"""F6b RED — scripts/ops/deploy.py dev 앱 모드 확장 계약 시험(PLAN_dev-app-deployment.md R2 §5·§6·§10).

표준 라이브러리 unittest만 쓴다. 실제 Docker·git·네트워크·SSH·서버·DB를 부르지 않는다.
- 순수 검사 함수(parse_app_request·validate_app_env·validate_app_manifest·validate_app_image·runtime_compose_app·
  DEV_FRONT_NGINX_CONF)는 입력/반환·거부만 본다.
- 흐름(deploy_app·revert_static·deploy dev·validated_dev_tree·main)은 tests/test_deploy_failures.py처럼
  외부 명령(run)·파일(임시 STATE)·공개 검증 함수(verify_release·verify_app_release·validate_record·validate_app_record)
  경계만 바꾸고, 결과(기록 파일·pending·릴리스 폴더·compose 반영 명령)와 거부 시 부작용 0을 확인한다.
- 새 공개 API가 없으면 각 시험이 require()에서 명시적으로 실패한다(정상 RED).
- 값은 모두 시험용 가짜(ci-only-*)다.
"""

import contextlib
import copy
import hashlib
import http.client
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEPLOY_PATH = ROOT / "scripts" / "ops" / "deploy.py"

deploy = None


def setUpModule():
    global deploy
    spec = importlib.util.spec_from_file_location("pieceofdays_ops_deploy_app", DEPLOY_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"배포 스크립트를 불러올 수 없다: {DEPLOY_PATH}")
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)


def require(test, *names):
    """새 공개 API가 있는지 단언한다. 없으면 이 시험만 실패한다(정상 RED)."""
    for name in names:
        test.assertTrue(hasattr(deploy, name), f"scripts/ops/deploy.py must define {name} (PLAN_dev-app-deployment §6)")


# ---------------------------------------------------------------- 가짜 값

SHA = "0123456789abcdef0123456789abcdef01234567"
OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98"
TREE = "1111111111111111111111111111111111111111"
OLD_TREE = "2222222222222222222222222222222222222222"
OTHER_TREE = "3333333333333333333333333333333333333333"
MANIFEST = "sha256:" + "4" * 64
CONFIG = "sha256:" + "5" * 64
OLD_MANIFEST = "sha256:" + "6" * 64
OLD_CONFIG = "sha256:" + "7" * 64
APP_ENGINE_ID = "sha256:" + "8" * 64  # 엔진 image ID(config digest와 다르다)
OLD_APP_ENGINE_ID = "sha256:" + "9" * 64
FRONT_IMAGE = "sha256:" + "a" * 64
OLD_FRONT_IMAGE = "sha256:" + "b" * 64
LAYER = "sha256:" + "c" * 64
REPO_URL = "https://github.com/kindsr/devscent-pieceofdays-main"
APP_REPO = "ghcr.io/kindsr/devscent-pieceofdays-main-app"
TRY_HTML = b"<!doctype html><title>try</title>\n"
DEV_INDEX = b"<!doctype html><title>dev</title>\n"
OLD_TRY_HTML = b"<!doctype html><title>old try</title>\n"
RELEASE_RE = re.compile(r"^[0-9a-f]{40}-[0-9a-f]{32}$")
OLD_RELEASE = OLD_SHA + "-" + "d" * 32

SESSION_KEY = "ci-only-f6b-session-key-1-".ljust(40, "x")
GOOGLE_SECRET = "ci-only-f6b-google-secret"
KAKAO_SECRET = "ci-only-f6b-kakao-secret"
DB_PASSWORD = "ci-only-f6b-db-pass"
PHOTO_ENV = {
    "POD_PHOTOS_S3_ENDPOINT": "https://ci-only-photos.invalid/",
    "POD_PHOTOS_S3_REGION": "ci-only-region-1",
    "POD_PHOTOS_S3_BUCKET": "ci-only-private-photos",
    "POD_PHOTOS_S3_ACCESS_KEY_ID": "ci-only-photo-access+/=key",
    "POD_PHOTOS_S3_SECRET_ACCESS_KEY": "ci-only-photo-secret+/==value",
}
SECRET_VALUES = (SESSION_KEY, GOOGLE_SECRET, KAKAO_SECRET, DB_PASSWORD, *PHOTO_ENV.values())

APP_SETTINGS_KEYS = {
    "app_mode_enabled": True,
    "db_network": "ci-only-db-network",
    "app_health_url": "https://dev.pieceofdays.com/try/",
    "app_role": "pod_app_dev",
    "db_host": "ci-only-pg18",
    "dev_db": "pod_dev",
    "server_arch": "amd64",
    # main 추가 계약(2026-11-05): 전용 front/egress bridge의 고정 IPAM(가짜 RFC1918 /24, 실제 값은 비공개 설정).
    "front_subnet": "10.231.17.0/24",
    "egress_subnet": "10.231.18.0/24",
}
FRONT_SUBNET = APP_SETTINGS_KEYS["front_subnet"]
EGRESS_SUBNET = APP_SETTINGS_KEYS["egress_subnet"]


def env_lines(**changes):
    """유효한 앱 env 파일 줄(순서 유지). 값 None은 그 키를 뺀다."""
    lines = {
        "POD_AUTH_SESSION_SECRETS": json.dumps({"1": SESSION_KEY}, separators=(",", ":")),
        "POD_AUTH_BASE_URL": "https://dev.pieceofdays.com",
        "POD_AUTH_PROVIDERS": "google",
        "POD_AUTH_GOOGLE_CLIENT_ID": "ci-only-f6b-google-client",
        "POD_AUTH_GOOGLE_CLIENT_SECRET": GOOGLE_SECRET,
        "POD_DATABASE_URL": f"postgres://pod_app_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev",
    }
    for key, value in changes.items():
        if value is None:
            lines.pop(key, None)
        else:
            lines[key] = value
    return lines


def env_text(**changes):
    return "".join(f"{k}={v}\n" for k, v in env_lines(**changes).items())


def settings_for(state, env_file=None):
    settings = {"runtime_working_dir": str(state / "runtime"), "health_url": "https://dev.pieceofdays.com/", **APP_SETTINGS_KEYS}
    settings["app_env_file"] = str(env_file if env_file is not None else state / "live" / "app.env")
    return settings


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def oci_manifest(config=CONFIG):
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config, "size": 7023},
        "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": LAYER, "size": 32654}],
    }


def docker_manifest(config=CONFIG):
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
        "config": {"mediaType": "application/vnd.docker.container.image.v1+json", "digest": config, "size": 7023},
        "layers": [{"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip", "digest": LAYER, "size": 32654}],
    }


def app_inspect(sha=SHA, tree=TREE, manifest=MANIFEST, engine_id=APP_ENGINE_ID):
    return {
        "Id": engine_id,
        "RepoTags": [],
        "RepoDigests": [f"{APP_REPO}@{manifest}"],
        "Architecture": "amd64",
        "Os": "linux",
        "Config": {
            "User": "node",
            "Env": [
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "NODE_VERSION=26.13.0",
                "YARN_VERSION=1.22.22",
                "NODE_ENV=production",
                "NEXT_TELEMETRY_DISABLED=1",
                "PORT=3000",
                "HOSTNAME=0.0.0.0",
            ],
            "ExposedPorts": {"3000/tcp": {}},
            "Volumes": None,
            "Labels": {
                "org.opencontainers.image.source": REPO_URL,
                "org.opencontainers.image.revision": sha,
                "pod.tree": tree,
                "pod.migrations.latest": "2",
            },
            "Entrypoint": ["docker-entrypoint.sh"],
            "Cmd": ["node", "runtime-startup.mjs"],
            "Healthcheck": None,
        },
    }


def flag_values(args, name):
    """`name X`와 `name=X` 형태의 옵션 값을 모두 모은다."""
    values = []
    for index, arg in enumerate(args):
        if arg == name and index + 1 < len(args):
            values.append(args[index + 1])
        elif arg.startswith(name + "="):
            values.append(arg.split("=", 1)[1])
    return values


def assert_no_secret(test, text, label=""):
    for secret in SECRET_VALUES:
        test.assertNotIn(secret, text, f"{label}: secret value leaked")


# ================================================================= 명령 문법 §6.1


class ParseAppRequestTests(unittest.TestCase):
    def test_exact_deploy_app_and_revert_static_grammar_returns_the_fixed_tuples(self):
        require(self, "parse_app_request")
        self.assertEqual(
            deploy.parse_app_request(f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}"),
            ("deploy-app", "dev", SHA, TREE, MANIFEST, CONFIG),
        )
        self.assertEqual(deploy.parse_app_request("revert-static dev"), ("revert-static", "dev"))

    def test_production_variants_and_anything_outside_the_exact_grammar_are_value_errors(self):
        require(self, "parse_app_request")
        rejected = [
            f"deploy-app production {SHA} {TREE} {MANIFEST} {CONFIG}",
            "revert-static production",
            f"deploy-app dev {SHA} {TREE} {MANIFEST}",
            f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG} extra",
            f"deploy-app dev {SHA.upper()} {TREE} {MANIFEST} {CONFIG}",
            f"deploy-app dev {SHA[:39]} {TREE} {MANIFEST} {CONFIG}",
            f"deploy-app dev {SHA} {TREE[:39]} {MANIFEST} {CONFIG}",
            f"deploy-app dev {SHA} {TREE} {MANIFEST[7:]} {CONFIG}",
            f"deploy-app dev {SHA} {TREE} {MANIFEST} sha512:{'5' * 64}",
            f"deploy-app dev {SHA} {TREE} sha256:{'4' * 63} {CONFIG}",
            f"deploy-app dev {SHA} {TREE} sha256:{'G' * 64} {CONFIG}",
            f" deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}",
            f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}\n",
            f"deploy-app  dev {SHA} {TREE} {MANIFEST} {CONFIG}",
            f"deploy-app\tdev {SHA} {TREE} {MANIFEST} {CONFIG}",
            f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}; id",
            "revert-static dev ",
            "revert-static",
            "revert-static dev now",
            f"deploy dev {SHA}",
            "probe dev",
            "",
            None,
        ]
        for command in rejected:
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    deploy.parse_app_request(command)

    def test_existing_parse_request_keeps_its_contract_and_does_not_accept_app_commands(self):
        self.assertEqual(deploy.parse_request(f"deploy dev {SHA}"), ("dev", SHA))
        self.assertEqual(deploy.parse_request(f"deploy production {SHA}"), ("production", SHA))
        for command in (f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}", "revert-static dev"):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    deploy.parse_request(command)


# ================================================================= 고정 상수 §5·§6.2·기존 불변


class ConstantsTests(unittest.TestCase):
    def test_app_image_repository_is_a_fixed_helper_constant(self):
        require(self, "APP_IMAGE_REPOSITORY")
        self.assertEqual(deploy.APP_IMAGE_REPOSITORY, APP_REPO)

    def test_existing_static_and_production_constants_are_unchanged(self):
        self.assertEqual(deploy.REPOSITORY, REPO_URL + ".git")
        self.assertEqual(
            deploy.HEALTH,
            {"test": ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:80/ || exit 1"], "interval": "30s", "timeout": "5s", "retries": 3},
        )
        self.assertEqual(set(deploy.ENVIRONMENTS), {"dev", "production"})
        self.assertEqual(
            deploy.ENVIRONMENTS["production"],
            ("main", "devscent-pieceofdays-main", "pieceofdays-comingsoon", "docker-compose.yml", "deploy/comingsoon", "html", deploy.STATE, "https://pieceofdays.com/"),
        )
        self.assertEqual(
            deploy.ENVIRONMENTS["dev"][:6] + deploy.ENVIRONMENTS["dev"][7:],
            ("dev", "pieceofdays-dev", "pieceofdays-frontend-dev", "docker-compose.dev.yml", "frontend", "public", "https://dev.pieceofdays.com/"),
        )
        image = "sha256:" + "e" * 64
        self.assertEqual(
            deploy.runtime_compose("production", image),
            {
                "name": "devscent-pieceofdays-main",
                "services": {
                    "pieceofdays-comingsoon": {
                        "image": image,
                        "container_name": "pieceofdays-comingsoon",
                        "restart": "unless-stopped",
                        "expose": ["80"],
                        "healthcheck": deploy.HEALTH,
                        "networks": {"edge": None},
                        "read_only": True,
                        "tmpfs": ["/var/cache/nginx", "/var/run"],
                    }
                },
                "networks": {"edge": {"name": "edge", "external": True}},
            },
        )
        self.assertEqual(deploy.runtime_compose("dev", image)["name"], "pieceofdays-dev")
        self.assertEqual(set(deploy.runtime_compose("dev", image)["services"]), {"pieceofdays-frontend-dev"})


def nginx_locations(conf):
    """`location [mod] path { ... }` 블록을 (mod, path, body) 목록으로 읽는다(중첩 없음 가정)."""
    found = []
    for match in re.finditer(r"location\s+(=|\^~|~\*?)?\s*(\S+)\s*\{([^{}]*)\}", conf):
        found.append(((match.group(1) or "").strip(), match.group(2), match.group(3)))
    return found


class DevFrontNginxConfTests(unittest.TestCase):
    PROXY = {("=", "/"), ("=", "/login"), ("=", "/days"), ("^~", "/days/"), ("=", "/settings"), ("^~", "/auth/"), ("^~", "/account/"), ("^~", "/_next/")}
    STATIC = {"/try/", "/design/", "/promo/", "/status/"}
    # main 추가 계약(GREEN60 독립 검토 5779565104 P1): OIDC callback은 exact 위치에서 로그 없이 같은 upstream으로 보낸다.
    CALLBACKS = {("=", "/auth/google/callback"), ("=", "/auth/kakao/callback")}
    PHOTOS = {("=", "/photos/upload"), ("^~", "/photos/")}

    def conf(self):
        require(self, "DEV_FRONT_NGINX_CONF")
        conf = deploy.DEV_FRONT_NGINX_CONF
        self.assertIsInstance(conf, str)
        return conf

    def test_only_the_exact_allowlist_is_proxied_to_the_fixed_app_container(self):
        conf = self.conf()
        locations = nginx_locations(conf)
        proxied = {(mod, path) for mod, path, body in locations if "proxy_pass" in body}
        self.assertEqual(proxied, self.PROXY | self.CALLBACKS | self.PHOTOS)
        for mod, path, body in locations:
            for target in re.findall(r"proxy_pass\s+([^;]+);", body):
                with self.subTest(location=(mod, path)):
                    self.assertEqual(target.strip(), "http://pieceofdays-app-dev:3000")
        self.assertEqual(
            len(re.findall(r"proxy_pass\s", conf)), len(self.PROXY) + len(self.CALLBACKS) + len(self.PHOTOS), "proxy_pass only inside the allowlisted locations"
        )

    def test_oidc_callback_locations_proxy_to_the_same_app_without_access_or_error_logs(self):
        """callback query(code·state)와 referrer가 프런트 nginx 기본 access·error 로그에 남지 않게 한다.

        exact 위치는 query와 무관하게 path만으로 매칭되고 `^~ /auth/`보다 먼저 선택된다. 본문은 로그만 끄고
        헤더·캐시를 재정의하지 않아 server 수준의 고정 Host·X-Forwarded-*와 그대로 전달되는 Origin·Cookie를 상속한다.
        `error_log off`는 "off"라는 파일 이름이라 쓰지 않는다(/dev/null).
        """
        conf = self.conf()
        locations = nginx_locations(conf)
        self.assertIn(("^~", "/auth/"), {(mod, path) for mod, path, _ in locations}, "the existing /auth/ allowlist entry stays")
        for mod, path in sorted(self.CALLBACKS):
            with self.subTest(callback=path):
                same_path = [(m, body) for m, p, body in locations if p == path]
                self.assertEqual([m for m, _ in same_path], ["="], "exactly one exact-match location for the callback path")
                body = same_path[0][1]
                self.assertEqual(re.findall(r"proxy_pass\s+([^;]+);", body), ["http://pieceofdays-app-dev:3000"])
                self.assertRegex(body, r"(^|[\s;{])access_log\s+off\s*;")
                self.assertRegex(body, r"(^|[\s;{])error_log\s+/dev/null(\s+(debug|info|notice|warn|error|crit|alert|emerg))?\s*;")
                self.assertEqual(len(re.findall(r"access_log\s", body)), 1)
                self.assertEqual(len(re.findall(r"error_log\s", body)), 1)
                for directive in ("proxy_set_header", "add_header", "proxy_hide_header", "proxy_pass_request_headers", "proxy_cache", "more_set_headers", "proxy_set_body", "return", "rewrite"):
                    self.assertNotRegex(body, r"(^|[\s;{])" + directive + r"\s", f"{directive} would change the inherited request/response handling")
        self.assertNotRegex(conf, r"error_log\s+off\s*;", "`error_log off` writes to a file named off")
        for match in re.finditer(r"log_format\s[^;]*;", conf):
            self.assertNotRegex(match.group(0), r"\$(request|request_uri|args|query_string|arg_\w+|http_referer)\b", "no raw request/query/referrer log format")
        for mod, path in sorted(self.PHOTOS):
            with self.subTest(photo=path):
                same_path = [(m, body) for m, p, body in locations if p == path]
                self.assertEqual([m for m, _ in same_path], [mod], "one exact upload and one dedicated photo prefix")
                body = same_path[0][1]
                self.assertEqual(re.findall(r"proxy_pass\s+([^;]+);", body), ["http://pieceofdays-app-dev:3000"])
                self.assertRegex(body, r"(^|[\s;{])access_log\s+off\s*;")
                self.assertRegex(body, r"(^|[\s;{])error_log\s+/dev/null\s+crit\s*;")
                self.assertEqual(len(re.findall(r"access_log\s", body)), 1)
                self.assertEqual(len(re.findall(r"error_log\s", body)), 1)
                self.assertEqual(re.findall(r"client_max_body_size\s+([^;]+);", body), ["9m"] if mod == "=" else [], "only exact upload changes the inherited 1m limit")
                for directive in ("proxy_set_header", "add_header", "proxy_hide_header", "proxy_pass_request_headers", "proxy_cache", "more_set_headers", "proxy_set_body", "return", "rewrite"):
                    self.assertNotRegex(body, r"(^|[\s;{])" + directive + r"\s", f"{directive} would change the inherited photo handling")

    def test_static_paths_stay_static_and_everything_else_is_404(self):
        conf = self.conf()
        locations = nginx_locations(conf)
        static_paths = {path for _, path, body in locations if "proxy_pass" not in body and "return 404" not in body}
        self.assertTrue(self.STATIC <= static_paths, f"static locations {static_paths}")
        for _, path, body in locations:
            if path in self.STATIC:
                self.assertNotIn("proxy_pass", body)
        self.assertIn("/usr/share/nginx/html", conf)
        self.assertRegex(conf, r"index\s+index\.html")
        fallback = [body for mod, path, body in locations if path == "/" and mod == ""]
        self.assertEqual(len(fallback), 1, "a single catch-all `location /`")
        self.assertIn("return 404", fallback[0])
        for path in ("/healthz", "/healthz/ready", "/dev/", "/index.html", "/favicon.ico", "/sample/"):
            with self.subTest(path=path):
                self.assertNotIn(path, {p for _, p, _ in locations})

    def test_forwarded_headers_are_fixed_and_client_host_is_never_used(self):
        conf = self.conf()
        self.assertNotIn("$host", conf)
        self.assertNotIn("$http_host", conf)
        self.assertRegex(conf, r"proxy_set_header\s+Host\s+dev\.pieceofdays\.com;")
        self.assertRegex(conf, r"proxy_set_header\s+X-Forwarded-Host\s+dev\.pieceofdays\.com;")
        self.assertRegex(conf, r"proxy_set_header\s+X-Forwarded-Proto\s+https;")
        self.assertRegex(conf, r"client_max_body_size\s+1m;")
        self.assertRegex(conf, r"proxy_read_timeout\s+30s;")
        self.assertNotIn("proxy_cache", conf)
        self.assertNotIn("Clear-Site-Data", conf)
        self.assertNotRegex(conf, r"proxy_set_header\s+(Origin|Cookie)\s", "Origin/Cookie are forwarded as sent")
        self.assertCountEqual(re.findall(r"client_max_body_size\s+([^;]+);", conf), ["1m", "9m"], "the server 1m default stays; only one upload override")


# ================================================================= env 검사 §6.3


class ValidateAppEnvTests(unittest.TestCase):
    def setUp(self):
        require(self, "validate_app_env")
        self.settings = settings_for(Path("/nonexistent-state"))

    def check_rejected(self, text, label):
        with self.subTest(label=label):
            with self.assertRaises(ValueError) as caught:
                deploy.validate_app_env(text, self.settings)
            assert_no_secret(self, str(caught.exception), label)

    def test_valid_file_returns_the_exact_key_value_dict(self):
        self.assertEqual(deploy.validate_app_env(env_text(), self.settings), env_lines())
        both = env_lines(
            POD_AUTH_PROVIDERS="google,kakao",
            POD_AUTH_KAKAO_CLIENT_ID="ci-only-f6b-kakao-client",
            POD_AUTH_KAKAO_CLIENT_SECRET=KAKAO_SECRET,
            POD_WITHDRAWAL_ENABLED="1",
            POD_AUTH_SESSION_SECRETS=json.dumps({"1": SESSION_KEY, "2": SESSION_KEY[::-1]}, separators=(",", ":")),
            POD_DATABASE_URL=f"postgresql://pod_app_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev",
        )
        text = "# comment line\n\n" + "".join(f"{k}={v}\n" for k, v in both.items()) + "\n# trailing comment\n"
        self.assertEqual(deploy.validate_app_env(text, self.settings), both)
        kakao_only = env_lines(
            POD_AUTH_PROVIDERS="kakao",
            POD_AUTH_GOOGLE_CLIENT_ID=None,
            POD_AUTH_GOOGLE_CLIENT_SECRET=None,
            POD_AUTH_KAKAO_CLIENT_ID="ci-only-f6b-kakao-client",
            POD_AUTH_KAKAO_CLIENT_SECRET=KAKAO_SECRET,
        )
        self.assertEqual(deploy.validate_app_env("".join(f"{k}={v}\n" for k, v in kakao_only.items()), self.settings), kakao_only)
        for endpoint, region, bucket in (
            (PHOTO_ENV["POD_PHOTOS_S3_ENDPOINT"], "ci-only-region-1", "ci-only-private-photos"),
            ("https://ci-only-photos.invalid", "a", "a-b"),
            ("https://ci-only-photos.invalid:9000/", "r" * 63, "b" * 63),
            ("https://127.0.0.1:9000/", "a-", "ci-only.private-photos"),
        ):
            photos = {**PHOTO_ENV, "POD_PHOTOS_S3_ENDPOINT": endpoint, "POD_PHOTOS_S3_REGION": region, "POD_PHOTOS_S3_BUCKET": bucket}
            expected = env_lines(**photos)
            with self.subTest(photo_endpoint=endpoint):
                self.assertEqual(deploy.validate_app_env(env_text(**photos), self.settings), expected, "exact photo settings and +/= credential bytes are preserved")

    def test_file_syntax_outside_the_node_compatible_subset_is_rejected(self):
        base = env_text()
        cases = {
            "UTF-8 BOM": "﻿" + base,
            "CRLF": base.replace("\n", "\r\n"),
            "bare CR": base.replace("\n", "\r", 1),
            "NUL": base + "POD_X\x00=1\n",
            "tab control": base.replace("POD_AUTH_PROVIDERS=google", "POD_AUTH_PROVIDERS=\tgoogle"),
            "other control char": base.replace("ci-only-f6b-google-client", "ci-only\x07client"),
            "export prefix": base.replace("POD_AUTH_PROVIDERS=", "export POD_AUTH_PROVIDERS="),
            "space before key": base.replace("POD_AUTH_PROVIDERS=", " POD_AUTH_PROVIDERS="),
            "space around =": base.replace("POD_AUTH_PROVIDERS=", "POD_AUTH_PROVIDERS ="),
            "duplicate key": base + "POD_AUTH_PROVIDERS=google\n",
            "line without =": base + "POD_AUTH_PROVIDERS\n",
            "empty value": base.replace("POD_AUTH_GOOGLE_CLIENT_ID=ci-only-f6b-google-client", "POD_AUTH_GOOGLE_CLIENT_ID="),
            "leading space in value": base.replace("=ci-only-f6b-google-client", "= ci-only-f6b-google-client"),
            "trailing space in value": base.replace("ci-only-f6b-google-client\n", "ci-only-f6b-google-client \n"),
            "# inside value": base.replace(GOOGLE_SECRET, GOOGLE_SECRET + "#x"),
            "inline comment": base.replace(GOOGLE_SECRET, GOOGLE_SECRET + " # note"),
            "double-quoted value": base.replace("=" + GOOGLE_SECRET, '="' + GOOGLE_SECRET + '"'),
            "single-quoted value": base.replace("=" + GOOGLE_SECRET, "='" + GOOGLE_SECRET + "'"),
            "backtick value": base.replace("=" + GOOGLE_SECRET, "=`" + GOOGLE_SECRET + "`"),
            "lowercase key": base + "pod_withdrawal_enabled=1\n",
        }
        for label, text in cases.items():
            self.check_rejected(text, label)

    def test_unknown_and_forbidden_keys_are_rejected(self):
        for key, value in (
            ("POD_LOCAL_FIXTURE", "1"),
            ("POD_AUTH_MOCK_OIDC_ISSUER", "http://127.0.0.1:9/google"),
            ("POD_MIGRATE_DATABASE_URL", f"postgres://pod_migrator_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev"),
            ("NODE_ENV", "production"),
            ("NODE_OPTIONS", "--require=/tmp/x.js"),
            ("PATH", "/tmp"),
            ("POD_SOMETHING_NEW", "1"),
            ("POD_PHOTO_CLEANUP_DATABASE_URL", f"postgres://pod_purge_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev"),
            ("POD_FULL_CHECK_ISOLATED", "1"),
            ("POD_TEST_DB_DISPOSABLE", "1"),
            ("POD_TEST_ADMIN_URL", f"postgres://pod_owner_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev"),
            ("AWS_ACCESS_KEY_ID", PHOTO_ENV["POD_PHOTOS_S3_ACCESS_KEY_ID"]),
            ("AWS_SECRET_ACCESS_KEY", PHOTO_ENV["POD_PHOTOS_S3_SECRET_ACCESS_KEY"]),
            ("AWS_SESSION_TOKEN", "ci-only-photo-ambient-token"),
            ("AWS_ENDPOINT_URL", PHOTO_ENV["POD_PHOTOS_S3_ENDPOINT"]),
            ("AWS_REGION", "ci-only-region-1"),
            ("AWS_DEFAULT_REGION", "ci-only-region-1"),
            ("AWS_PROFILE", "ci-only-profile"),
            ("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/ci-only-credentials"),
            ("POD_PHOTOS_S3_EXTRA", "ci-only-not-allowlisted"),
        ):
            self.check_rejected(env_text() + f"{key}={value}\n", key)

    def test_each_required_key_is_required(self):
        for key in ("POD_AUTH_SESSION_SECRETS", "POD_AUTH_BASE_URL", "POD_AUTH_PROVIDERS", "POD_DATABASE_URL"):
            self.check_rejected(env_text(**{key: None}), f"missing {key}")
        self.check_rejected("", "empty file")
        self.check_rejected("# only a comment\n", "comments only")
        photo_keys = tuple(PHOTO_ENV)
        for mask in range(1, (1 << len(photo_keys)) - 1):
            partial = {key: PHOTO_ENV[key] for bit, key in enumerate(photo_keys) if mask & (1 << bit)}
            self.check_rejected(env_text(**partial), f"partial photo settings mask {mask}")

    def test_base_url_providers_and_provider_credentials_follow_the_contract(self):
        for value in ("http://dev.pieceofdays.com", "https://dev.pieceofdays.com/", "https://pieceofdays.com", "https://dev.pieceofdays.com:443", "https://DEV.pieceofdays.com"):
            self.check_rejected(env_text(POD_AUTH_BASE_URL=value), f"base {value}")
        for value in ("Google", "google,google", "google,", ",google", "naver", "google, kakao", "google;kakao"):
            self.check_rejected(env_text(POD_AUTH_PROVIDERS=value), f"providers {value}")
        self.check_rejected(env_text(POD_AUTH_GOOGLE_CLIENT_SECRET=None), "listed provider without secret")
        self.check_rejected(env_text(POD_AUTH_GOOGLE_CLIENT_ID=None), "listed provider without id")
        self.check_rejected(env_text(POD_AUTH_KAKAO_CLIENT_ID="ci-only-f6b-kakao-client"), "unlisted provider id")
        self.check_rejected(env_text(POD_AUTH_KAKAO_CLIENT_SECRET=KAKAO_SECRET), "unlisted provider secret")
        self.check_rejected(env_text(POD_AUTH_PROVIDERS="google,kakao"), "kakao listed without credentials")
        for value in ("true", "0", "yes", "11"):
            self.check_rejected(env_text(POD_WITHDRAWAL_ENABLED=value), f"withdrawal {value}")
        photo_cases = {
            "http": ("POD_PHOTOS_S3_ENDPOINT", "http://ci-only-photos.invalid/"),
            "http loopback": ("POD_PHOTOS_S3_ENDPOINT", "http://127.0.0.1:8333/"),
            "userinfo": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-user:ci-only-pass@ci-only-photos.invalid/"),
            "empty userinfo": ("POD_PHOTOS_S3_ENDPOINT", "https://@ci-only-photos.invalid/"),
            "empty password userinfo": ("POD_PHOTOS_S3_ENDPOINT", "https://:@ci-only-photos.invalid/"),
            "query": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid/?ci-only=1"),
            "empty query": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid/?"),
            "fragment": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid/#ci-only"),
            "empty fragment": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid/#"),
            "path": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid/bucket"),
            "normalized dot path": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid/a/../"),
            "double slash": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid//"),
            "port word": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid:word/"),
            "port overflow": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photos.invalid:65536/"),
            "endpoint space": ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only photos.invalid/"),
            "region uppercase": ("POD_PHOTOS_S3_REGION", "CI-region"),
            "region punctuation": ("POD_PHOTOS_S3_REGION", "ci_region"),
            "region leading dash": ("POD_PHOTOS_S3_REGION", "-ci-region"),
            "region overlong": ("POD_PHOTOS_S3_REGION", "r" * 64),
            "bucket short": ("POD_PHOTOS_S3_BUCKET", "ab"),
            "bucket overlong": ("POD_PHOTOS_S3_BUCKET", "b" * 64),
            "bucket uppercase": ("POD_PHOTOS_S3_BUCKET", "CI-bucket"),
            "bucket underscore": ("POD_PHOTOS_S3_BUCKET", "ci_bucket"),
            "bucket leading dash": ("POD_PHOTOS_S3_BUCKET", "-ci-bucket"),
            "bucket trailing dot": ("POD_PHOTOS_S3_BUCKET", "ci-bucket."),
            "bucket adjacent dots": ("POD_PHOTOS_S3_BUCKET", "ci..bucket"),
            "bucket dot dash": ("POD_PHOTOS_S3_BUCKET", "ci.-bucket"),
            "bucket dash dot": ("POD_PHOTOS_S3_BUCKET", "ci-.bucket"),
            "bucket IP literal": ("POD_PHOTOS_S3_BUCKET", "127.0.0.1"),
        }
        for key in PHOTO_ENV:
            photo_cases[f"{key} empty"] = (key, "")
            photo_cases[f"{key} leading space"] = (key, " " + PHOTO_ENV[key])
            photo_cases[f"{key} trailing space"] = (key, PHOTO_ENV[key] + " ")
            photo_cases[f"{key} inner space"] = (key, "ci-only photo-value")
        for label, (key, value) in photo_cases.items():
            self.check_rejected(env_text(**{**PHOTO_ENV, key: value}), f"photo {label}")

    def test_database_url_must_be_the_dev_app_role_on_the_expected_host_and_database(self):
        cases = {
            "other scheme": f"mysql://pod_app_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev",
            "migrator role": f"postgres://pod_migrator_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev",
            "owner role": f"postgres://pod_owner_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev",
            "other host": f"postgres://pod_app_dev:{DB_PASSWORD}@127.0.0.1/pod_dev",
            "other database": f"postgres://pod_app_dev:{DB_PASSWORD}@ci-only-pg18/pod_prod",
            "query": f"postgres://pod_app_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev?sslmode=disable",
            "query host override": f"postgres://pod_app_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev?host=/tmp",
            "no database": f"postgres://pod_app_dev:{DB_PASSWORD}@ci-only-pg18",
            "not a URL": "pod_app_dev",
        }
        for label, value in cases.items():
            self.check_rejected(env_text(POD_DATABASE_URL=value), label)

    def test_session_secrets_are_a_json_map_of_positive_safe_integer_keys_to_32_plus_char_strings(self):
        def secrets(value):
            return env_text(POD_AUTH_SESSION_SECRETS=value)

        self.assertIn("POD_AUTH_SESSION_SECRETS", deploy.validate_app_env(secrets(json.dumps({"7": "k" * 32}, separators=(",", ":"))), self.settings))
        cases = {
            "not JSON": "{1:" + SESSION_KEY + "}",
            "array": json.dumps([SESSION_KEY]),
            "string": json.dumps(SESSION_KEY),
            "empty map": "{}",
            "zero key": json.dumps({"0": SESSION_KEY}, separators=(",", ":")),
            "negative key": json.dumps({"-1": SESSION_KEY}, separators=(",", ":")),
            "fraction key": json.dumps({"1.5": SESSION_KEY}, separators=(",", ":")),
            "word key": json.dumps({"a": SESSION_KEY}, separators=(",", ":")),
            "unsafe key": json.dumps({"9007199254740992": SESSION_KEY}, separators=(",", ":")),
            "31 chars": json.dumps({"1": "k" * 31}, separators=(",", ":")),
            "number value": '{"1":' + "1" * 40 + "}",
            "null value": '{"1":null}',
        }
        for label, value in cases.items():
            self.check_rejected(secrets(value), label)

    def test_error_messages_name_keys_but_never_values(self):
        with self.assertRaises(ValueError) as caught:
            deploy.validate_app_env(env_text(POD_DATABASE_URL=f"postgres://intruder:{DB_PASSWORD}@ci-only-pg18/pod_dev"), self.settings)
        message = str(caught.exception)
        self.assertIn("POD_DATABASE_URL", message)
        self.assertNotIn("intruder", message)
        assert_no_secret(self, message)
        for key, value in (
            ("POD_PHOTOS_S3_ENDPOINT", "https://ci-only-photo-private-marker.invalid/private"),
            ("POD_PHOTOS_S3_REGION", "ci-only-private-region_"),
            ("POD_PHOTOS_S3_BUCKET", "ci-only-private-bucket_"),
            ("POD_PHOTOS_S3_ACCESS_KEY_ID", "ci-only private access"),
            ("POD_PHOTOS_S3_SECRET_ACCESS_KEY", "ci-only private secret"),
        ):
            with self.subTest(photo_key=key):
                with self.assertRaises(ValueError) as caught:
                    deploy.validate_app_env(env_text(**{**PHOTO_ENV, key: value}), self.settings)
                self.assertNotIn(value, str(caught.exception), "invalid storage values are never echoed")
                assert_no_secret(self, str(caught.exception), key)


# ================================================================= manifest·이미지 §6.3


class ValidateAppManifestTests(unittest.TestCase):
    def setUp(self):
        require(self, "validate_app_manifest")

    def test_single_platform_oci_or_docker_schema2_manifest_with_the_exact_config_digest_passes(self):
        self.assertIsNone(deploy.validate_app_manifest(oci_manifest(), CONFIG))
        self.assertIsNone(deploy.validate_app_manifest(docker_manifest(), CONFIG))

    def test_index_list_wrong_config_and_malformed_layers_are_rejected(self):
        def changed(base, path, value):
            doc = copy.deepcopy(base)
            target = doc
            for key in path[:-1]:
                target = target[key]
            if value is KeyError:
                del target[path[-1]]
            else:
                target[path[-1]] = value
            return doc

        index = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [{"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": MANIFEST, "size": 1, "platform": {"architecture": "amd64", "os": "linux"}}],
        }
        cases = {
            "OCI index": index,
            "Docker manifest list": {**index, "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json"},
            "manifests key on a manifest": {**oci_manifest(), "manifests": index["manifests"]},
            "schemaVersion 1": changed(oci_manifest(), ["schemaVersion"], 1),
            "unknown mediaType": changed(oci_manifest(), ["mediaType"], "application/json"),
            "other config digest": oci_manifest(config=OLD_CONFIG),
            "config mediaType": changed(oci_manifest(), ["config", "mediaType"], "application/vnd.oci.image.layer.v1.tar"),
            "config size 0": changed(oci_manifest(), ["config", "size"], 0),
            "config size string": changed(oci_manifest(), ["config", "size"], "7023"),
            "config size bool": changed(oci_manifest(), ["config", "size"], True),
            "no config": changed(oci_manifest(), ["config"], KeyError),
            "no layers": changed(oci_manifest(), ["layers"], []),
            "layers not a list": changed(oci_manifest(), ["layers"], {}),
            "layer digest": changed(oci_manifest(), ["layers"], [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": "sha256:xyz", "size": 1}]),
            "layer size": changed(oci_manifest(), ["layers"], [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": LAYER, "size": 0}]),
            "not a dict": [oci_manifest()],
        }
        for label, doc in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    deploy.validate_app_manifest(doc, CONFIG)
        for bad in (CONFIG[7:], "sha256:" + "5" * 63, "sha512:" + "5" * 64, None):
            with self.subTest(config_digest=bad):
                with self.assertRaises(ValueError):
                    deploy.validate_app_manifest(oci_manifest(), bad)


class ValidateAppImageTests(unittest.TestCase):
    def setUp(self):
        require(self, "validate_app_image")
        self.settings = settings_for(Path("/nonexistent-state"))

    def check(self, inspect):
        return deploy.validate_app_image(inspect, SHA, TREE, MANIFEST, self.settings)

    def test_valid_pulled_image_passes_and_the_engine_id_is_not_compared_with_the_config_digest(self):
        self.assertIsNone(self.check(app_inspect()))
        self.assertIsNone(self.check(app_inspect(engine_id="sha256:" + "f" * 64)))
        self.assertIsNone(self.check(app_inspect(engine_id=CONFIG)))
        fewer = app_inspect()
        fewer["Config"]["Env"] = ["PATH=/usr/bin", "NODE_ENV=production"]
        fewer["Config"]["Volumes"] = {}
        self.assertIsNone(self.check(fewer), "a subset of the allowed env keys and empty Volumes pass")

    def test_requested_manifest_digest_alias_in_repo_tags_passes(self):
        inspect = app_inspect(engine_id=MANIFEST)
        inspect["RepoTags"] = [f"{APP_REPO}@{MANIFEST}"]
        self.assertIsNone(self.check(inspect))

    def test_repo_tags_reject_other_references_mixtures_and_malformed_values(self):
        requested = f"{APP_REPO}@{MANIFEST}"
        other_digest = f"{APP_REPO}@{OLD_MANIFEST}"
        other_repo = f"{APP_REPO}-other@{MANIFEST}"
        tag = f"{APP_REPO}:latest"
        cases = {
            "other digest": [other_digest],
            "other repository": [other_repo],
            "mutable tag": [tag],
            "tag-qualified digest": [f"{APP_REPO}:latest@{MANIFEST}"],
            "requested alias plus tag": [requested, tag],
            "requested alias plus other digest": [requested, other_digest],
            "requested alias plus other repository": [requested, other_repo],
            "non-list reference": requested,
            "non-list empty string": "",
            "non-list empty object": {},
            "null entry": [None],
            "numeric entry": [42],
            "nested list entry": [[requested]],
            "requested alias plus invalid entry": [requested, None],
        }
        for label, repo_tags in cases.items():
            with self.subTest(label=label):
                inspect = app_inspect(engine_id=MANIFEST)
                inspect["RepoTags"] = repo_tags
                with self.assertRaises(ValueError):
                    self.check(inspect)

    def test_identity_digest_tags_user_labels_ports_volumes_env_and_arch_policy(self):
        def mutate(fn):
            inspect = app_inspect()
            fn(inspect)
            return inspect

        cases = {
            "bad Id": mutate(lambda i: i.__setitem__("Id", "sha256:short")),
            "Id without prefix": mutate(lambda i: i.__setitem__("Id", "8" * 64)),
            "RepoTags": mutate(lambda i: i.__setitem__("RepoTags", [f"{APP_REPO}:latest"])),
            "no RepoDigests": mutate(lambda i: i.__setitem__("RepoDigests", [])),
            "other manifest digest": mutate(lambda i: i.__setitem__("RepoDigests", [f"{APP_REPO}@{OLD_MANIFEST}"])),
            "other repository": mutate(lambda i: i.__setitem__("RepoDigests", [f"ghcr.io/evil/app@{MANIFEST}"])),
            "user empty": mutate(lambda i: i["Config"].__setitem__("User", "")),
            "user root": mutate(lambda i: i["Config"].__setitem__("User", "root")),
            "user 0": mutate(lambda i: i["Config"].__setitem__("User", "0")),
            "user 0:0": mutate(lambda i: i["Config"].__setitem__("User", "0:0")),
            "revision": mutate(lambda i: i["Config"]["Labels"].__setitem__("org.opencontainers.image.revision", OLD_SHA)),
            "tree": mutate(lambda i: i["Config"]["Labels"].__setitem__("pod.tree", OLD_TREE)),
            "source": mutate(lambda i: i["Config"]["Labels"].__setitem__("org.opencontainers.image.source", "https://github.com/evil/app")),
            "migrations 0": mutate(lambda i: i["Config"]["Labels"].__setitem__("pod.migrations.latest", "0")),
            "migrations word": mutate(lambda i: i["Config"]["Labels"].__setitem__("pod.migrations.latest", "latest")),
            "migrations missing": mutate(lambda i: i["Config"]["Labels"].pop("pod.migrations.latest")),
            "extra port": mutate(lambda i: i["Config"].__setitem__("ExposedPorts", {"3000/tcp": {}, "9229/tcp": {}})),
            "other port": mutate(lambda i: i["Config"].__setitem__("ExposedPorts", {"8080/tcp": {}})),
            "volume": mutate(lambda i: i["Config"].__setitem__("Volumes", {"/data": {}})),
            "POD_ env baked in": mutate(lambda i: i["Config"]["Env"].append("POD_DATABASE_URL=postgres://x")),
            "unknown env key": mutate(lambda i: i["Config"]["Env"].append("NODE_OPTIONS=--inspect")),
            "NODE_ENV development": mutate(lambda i: i["Config"].__setitem__("Env", ["NODE_ENV=development"])),
            "PORT other": mutate(lambda i: i["Config"].__setitem__("Env", ["PORT=8080"])),
            "HOSTNAME other": mutate(lambda i: i["Config"].__setitem__("Env", ["HOSTNAME=127.0.0.1"])),
            "telemetry on": mutate(lambda i: i["Config"].__setitem__("Env", ["NEXT_TELEMETRY_DISABLED=0"])),
            "arm64": mutate(lambda i: i.__setitem__("Architecture", "arm64")),
        }
        for key, value in {**PHOTO_ENV, "POD_PHOTO_CLEANUP_DATABASE_URL": "postgres://ci-only-purge.invalid/pod_dev"}.items():
            cases[f"{key} must not be baked into image ENV"] = mutate(lambda i, key=key, value=value: i["Config"]["Env"].append(f"{key}={value}"))
        for label, inspect in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    self.check(inspect)


# ================================================================= 앱 compose 템플릿 §3·§6.3


class RuntimeComposeAppTests(unittest.TestCase):
    UID, GID = 1000, 1001

    def setUp(self):
        require(self, "runtime_compose_app")
        self.state = Path(os.path.realpath(tempfile.mkdtemp(prefix="pieceofdays-compose-")))
        self.addCleanup(lambda: shutil.rmtree(self.state, ignore_errors=True))
        patcher = mock.patch.object(deploy, "STATE", self.state)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.settings = settings_for(self.state)
        self.release = SHA + "-" + "e" * 32

    def compose(self, release=None, uid=None, gid=None):
        return deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, release or self.release, uid or self.UID, gid or self.GID, self.settings)

    def test_two_fixed_services_use_the_recorded_engine_image_ids(self):
        data = self.compose()
        self.assertEqual(data, self.compose(), "deterministic for the same inputs")
        services = data["services"]
        self.assertEqual(set(services), {"pieceofdays-frontend-dev", "pieceofdays-app-dev"})
        front, app = services["pieceofdays-frontend-dev"], services["pieceofdays-app-dev"]
        self.assertEqual(front["image"], FRONT_IMAGE)
        self.assertEqual(app["image"], APP_ENGINE_ID)
        self.assertNotIn(APP_REPO, json.dumps(data), "no registry reference at runtime")
        self.assertEqual(front.get("container_name"), "pieceofdays-frontend-dev")
        self.assertEqual(app.get("container_name"), "pieceofdays-app-dev")

    def test_app_command_user_health_and_frozen_secret_file(self):
        data = self.compose()
        app = data["services"]["pieceofdays-app-dev"]
        self.assertEqual(app["entrypoint"], ["node"])
        # main 추가 계약(2026-11-05): standalone server.js 앞에서 기존 운영 모드 검사를 다시 실행하는 wrapper로 시작한다.
        self.assertEqual(app["command"], ["--env-file=/run/secrets/pod_app_env", "runtime-startup.mjs"])
        self.assertEqual(app["user"], f"{self.UID}:{self.GID}")
        health = app["healthcheck"]
        self.assertEqual(
            health["test"],
            ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"],
        )
        self.assertEqual((health["interval"], health["timeout"], health["retries"], health["start_period"]), ("30s", "5s", 3, "20s"))
        self.assertEqual(data["secrets"], {"pod_app_env": {"file": str(self.state / "releases" / "dev" / self.release / "app.env")}})
        self.assertIn("pod_app_env", json.dumps(app.get("secrets")))
        front_health = data["services"]["pieceofdays-frontend-dev"]["healthcheck"]
        self.assertIn("wget -q -O /dev/null http://127.0.0.1:80/try/", " ".join(front_health["test"]))

    def test_hardening_and_no_host_ports_mounts_or_injected_environment(self):
        data = self.compose()
        front, app = data["services"]["pieceofdays-frontend-dev"], data["services"]["pieceofdays-app-dev"]
        self.assertIs(app.get("read_only"), True)
        self.assertEqual(app.get("cap_drop"), ["ALL"])
        self.assertIn("no-new-privileges:true", app.get("security_opt", []))
        tmpfs = " ".join(app.get("tmpfs", []))
        self.assertIn("/tmp", tmpfs)
        self.assertIn("/app/.next/cache", tmpfs)
        self.assertIs(front.get("read_only"), True)
        self.assertTrue({"/var/cache/nginx", "/var/run"} <= {t.split(":")[0] for t in front.get("tmpfs", [])})
        for name, service in (("front", front), ("app", app)):
            for key in ("ports", "volumes", "privileged", "devices", "cap_add", "environment", "env_file", "build", "network_mode", "pid", "ipc", "extra_hosts"):
                with self.subTest(service=name, key=key):
                    self.assertNotIn(key, service)
        self.assertNotIn("volumes", data)

    def test_networks_edge_internal_front_external_db_and_app_egress(self):
        data = self.compose()
        top = data["networks"]
        self.assertEqual(len(top), 4)

        def resolved(service):
            return {key: top[key] for key in data["services"][service]["networks"]}

        front_nets = list(resolved("pieceofdays-frontend-dev").values())
        app_nets = list(resolved("pieceofdays-app-dev").values())
        edge = {"name": "edge", "external": True}
        self.assertIn(edge, front_nets)
        self.assertNotIn(edge, app_nets, "the app is not on the public edge network")
        self.assertEqual(len(front_nets), 2)
        self.assertEqual(len(app_nets), 3)
        internal = [n for n in front_nets if n.get("internal") is True]
        self.assertEqual(len(internal), 1)
        self.assertIn(internal[0], app_nets, "front and app share the internal network")
        self.assertIn({"name": "ci-only-db-network", "external": True}, app_nets)
        egress = [n for n in app_nets if not n.get("external") and not n.get("internal")]
        self.assertEqual(len(egress), 1, "a dedicated app egress bridge")
        self.assertNotIn(egress[0], front_nets)
        # 전용 두 네트워크만 고정 IPAM을 갖고, 외부 참조(edge·DB)에는 IPAM이 없다.
        self.assertEqual(internal[0].get("ipam"), {"config": [{"subnet": FRONT_SUBNET}]})
        self.assertEqual(egress[0].get("ipam"), {"config": [{"subnet": EGRESS_SUBNET}]})
        for entry in top.values():
            if entry.get("external"):
                self.assertNotIn("ipam", entry, "external networks are referenced as-is")

    def test_dedicated_subnets_must_be_normalized_non_overlapping_rfc1918_ipv4_slash_24(self):
        bad = {
            "public range": ("8.8.8.0/24", EGRESS_SUBNET),
            "outside 172.16/12": ("172.32.5.0/24", EGRESS_SUBNET),
            "/16": ("10.231.0.0/16", EGRESS_SUBNET),
            "/25": ("192.168.40.0/25", EGRESS_SUBNET),
            "host bits set": ("10.231.17.5/24", EGRESS_SUBNET),
            "no prefix": ("10.231.17.0", EGRESS_SUBNET),
            "IPv6": ("fd00:231:17::/64", EGRESS_SUBNET),
            "leading zero": ("10.231.017.0/24", EGRESS_SUBNET),
            "whitespace": (" 10.231.17.0/24", EGRESS_SUBNET),
            "same subnet": (FRONT_SUBNET, FRONT_SUBNET),
            "egress public": (FRONT_SUBNET, "100.64.0.0/24"),
            "egress missing": (FRONT_SUBNET, None),
            "front not a string": (None, EGRESS_SUBNET),
        }
        for label, (front, egress) in bad.items():
            with self.subTest(label=label):
                settings = {**self.settings, "front_subnet": front, "egress_subnet": egress}
                with self.assertRaises(ValueError):
                    deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, self.release, self.UID, self.GID, settings)
        for front, egress in (("172.16.9.0/24", "192.168.9.0/24"), ("172.31.255.0/24", "10.0.0.0/24")):
            with self.subTest(front=front, egress=egress):
                settings = {**self.settings, "front_subnet": front, "egress_subnet": egress}
                deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, self.release, self.UID, self.GID, settings)

    def test_invalid_release_id_ids_and_root_uid_gid_are_rejected(self):
        for release in ("../" + self.release, SHA, SHA + "-" + "E" * 32, SHA + "-" + "e" * 31, "/abs/" + self.release, self.release + "/x"):
            with self.subTest(release=release):
                with self.assertRaises(ValueError):
                    self.compose(release=release)
        for uid, gid in ((0, self.GID), (self.UID, 0), (0, 0)):
            with self.subTest(uid=uid, gid=gid):
                with self.assertRaises(ValueError):
                    deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, self.release, uid, gid, self.settings)
        for front, app in (("nginx:latest", APP_ENGINE_ID), (FRONT_IMAGE, f"{APP_REPO}@{MANIFEST}"), (FRONT_IMAGE, "sha256:x")):
            with self.subTest(front=front, app=app):
                with self.assertRaises(ValueError):
                    deploy.runtime_compose_app(front, app, self.release, self.UID, self.GID, self.settings)


# ================================================================= 흐름 공통: 임시 STATE·배포 사용자·가짜 Docker


DEPLOY_UID = 1000
DEPLOY_GID = 1000


class DeployUserState:
    """임시 STATE를 만들고 배포 사용자(비 root uid/gid)로 동작하게 한다.

    root(격리 Cloud)에서 실행되면 STATE를 1000:1000 소유로 바꾸고 유효 uid/gid를 잠시 낮춘 뒤
    deploy.os.getuid/getgid가 그 값을 돌려주게 한다(helper는 uid 0을 거부한다). 비 root(CI)는 실제 uid/gid를 쓴다.
    """

    def __init__(self, test):
        self.test = test
        self.root = Path(os.path.realpath(tempfile.mkdtemp(prefix="pieceofdays-f6b-")))
        test.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        if os.getuid() == 0:
            os.chown(self.root, DEPLOY_UID, DEPLOY_GID)
            os.setegid(DEPLOY_GID)
            os.seteuid(DEPLOY_UID)

            def restore():
                os.seteuid(0)
                os.setegid(0)

            test.addCleanup(restore)
            for name, value in (("getuid", DEPLOY_UID), ("getgid", DEPLOY_GID)):
                patcher = mock.patch.object(deploy.os, name, return_value=value)
                patcher.start()
                test.addCleanup(patcher.stop)
        self.uid, self.gid = deploy.os.getuid(), deploy.os.getgid()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        (self.state / "runtime").mkdir(mode=0o700)
        (self.state / "live").mkdir(mode=0o700)


def write_private(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)
    return path


class AppFlowBase(unittest.TestCase):
    """deploy_app·revert_static·deploy(dev) 흐름의 외부 경계만 바꾼다."""

    REQUIRED = ("deploy_app", "validate_app_record", "verify_app_release", "runtime_compose_app", "validate_app_env", "validate_app_manifest", "validate_app_image")

    def setUp(self):
        require(self, *self.REQUIRED)
        self.user = DeployUserState(self)
        self.state = self.user.state
        self.settings = settings_for(self.state)
        self.live_env = Path(self.settings["app_env_file"])
        write_private(self.live_env, env_text())
        self.current = self.state / "dev-current.json"
        self.pending = self.state / "dev-pending.json"
        self.static_last = self.state / "dev-static-last.json"
        self.tree_answer = TREE
        self.runs = []
        self.events = []
        self.containers = {}
        self.fail_compose_paths = set()
        self.fail_verify = set()  # "new-app" | "prev-app" | "static"
        self.networks = {}  # 이미 있는 Docker 네트워크: 이름 → subnet(기본: 전용 네트워크 없음)
        self.calls = []  # (args, docker config dir, 그 시점 존재·비어 있음) — 외부 명령 경계 관찰
        self.container_states = {}  # 컨테이너 이름 → State 덮어쓰기(기본 running·healthy)
        self.ready_fails = False  # 앱 컨테이너 안 /healthz/ready 명령이 0이 아닌 종료로 끝난다
        self.front_try_override = None  # 프런트 컨테이너 안 /try/ 본문 덮어쓰기
        self.trusted_calls = []  # trusted_file 호출 경로(spy)
        self.reject_trusted = lambda path: False  # 특정 경로에서 신뢰 거부를 주입한다

        patches = {
            "STATE": self.state,
            # /tmp(1777) 부모 때문에 실제 신뢰 규칙은 쓰지 않는다. 대신 호출 경로를 기록하고 거부를 주입할 수 있는 spy다.
            "trusted_file": mock.Mock(side_effect=self.fake_trusted_file),
            "assert_latest": mock.Mock(return_value=None),
            "sync_dev_clone": mock.Mock(return_value=None),
            "validate_record": mock.Mock(side_effect=lambda record, env: record),
            "validate_app_record": mock.Mock(side_effect=lambda record, settings: record),
            "run": mock.Mock(side_effect=self.fake_run),
            "verify_release": mock.Mock(side_effect=self.fake_verify_static),
            "verify_app_release": mock.Mock(side_effect=self.fake_verify_app),
        }
        for name, value in patches.items():
            patcher = mock.patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.mocks = patches
        for patcher in (
            mock.patch.object(deploy.subprocess, "run", side_effect=AssertionError("real subprocess.run")),
            mock.patch.object(deploy.urllib.request, "urlopen", side_effect=AssertionError("real urlopen")),
            mock.patch.object(deploy.urllib.request, "build_opener", side_effect=AssertionError("real HTTPS opener")),
            mock.patch.object(deploy.signal, "signal"),
            mock.patch.object(deploy.time, "sleep"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    # --- 기록 준비 ---
    def static_record(self, sha=OLD_SHA, tree=OLD_TREE, image=OLD_FRONT_IMAGE):
        compose_path = self.state / "releases" / "dev" / (sha + "-" + "1" * 32) / "compose.json"
        write_private(compose_path, json.dumps(deploy.runtime_compose("dev", image)), 0o600)
        return {
            "status": "success",
            "sha": sha,
            "tree": tree,
            "image_id": image,
            "serving_html_sha256": sha256_hex(DEV_INDEX),
            "compose_path": str(compose_path),
            "compose_sha256": sha256_hex(compose_path.read_bytes()),
            "timestamp": "2026-11-04T00:00:00+00:00",
        }

    def app_record(self, sha=OLD_SHA, tree=OLD_TREE, release=OLD_RELEASE, env=None, manifest=OLD_MANIFEST, config=OLD_CONFIG, app_id=OLD_APP_ENGINE_ID, front=OLD_FRONT_IMAGE):
        release_dir = self.state / "releases" / "dev" / release
        env_bytes = (env if env is not None else env_text()).encode()
        write_private(release_dir / "app.env", env_bytes)
        compose = deploy.runtime_compose_app(front, app_id, release, self.user.uid, self.user.gid, self.settings)
        write_private(release_dir / "compose.json", json.dumps(compose, indent=2) + "\n")
        return {
            "mode": "app",
            "status": "success",
            "sha": sha,
            "tree": tree,
            "release_id": release,
            "front_image_id": front,
            "app_image_id": app_id,
            "app_manifest_digest": manifest,
            "app_config_digest": config,
            "try_html_sha256": sha256_hex(OLD_TRY_HTML if front == OLD_FRONT_IMAGE else TRY_HTML),
            "compose_sha256": sha256_hex((release_dir / "compose.json").read_bytes()),
            "env_sha256": sha256_hex(env_bytes),
            "timestamp": "2026-11-04T00:00:00+00:00",
        }

    def write_json(self, path, data):
        write_private(path, json.dumps(data, indent=2) + "\n")

    def read_json(self, path):
        return json.loads(Path(path).read_text()) if Path(path).exists() else None

    def release_dirs(self):
        base = self.state / "releases" / "dev"
        return sorted(p.name for p in base.iterdir() if p.is_dir() and RELEASE_RE.fullmatch(p.name)) if base.exists() else []

    # --- 가짜 외부 명령 ---
    def write_source(self, source):
        source = Path(source)
        public = source / "frontend" / "public"
        (public / "try").mkdir(parents=True)
        (public / "index.html").write_bytes(DEV_INDEX)
        (public / "try" / "index.html").write_bytes(TRY_HTML)
        (source / "frontend" / "Dockerfile").write_text("FROM nginx:stable-alpine\nCOPY public/ /usr/share/nginx/html/\n")
        compose = {
            "name": "pieceofdays-dev",
            "services": {
                "pieceofdays-frontend-dev": {
                    "image": "pieceofdays-dev:local",
                    "build": {"context": "./frontend", "dockerfile": "Dockerfile"},
                    "container_name": "pieceofdays-frontend-dev",
                    "restart": "unless-stopped",
                    "expose": ["80"],
                    "read_only": True,
                    "tmpfs": ["/var/cache/nginx", "/var/run"],
                    "healthcheck": deploy.HEALTH,
                    "networks": {"edge": None},
                }
            },
            "networks": {"edge": {"external": True, "name": "edge"}},
        }
        (source / "docker-compose.dev.yml").write_text(json.dumps(compose))

    def known_image(self, args):
        for arg in args:
            for image in (APP_ENGINE_ID, OLD_APP_ENGINE_ID, FRONT_IMAGE, OLD_FRONT_IMAGE):
                if image in arg:
                    return image
            if APP_REPO in arg:
                return APP_ENGINE_ID
            if arg.startswith("pieceofdays-"):
                continue
        return FRONT_IMAGE

    def output(self, args, image):
        """후보·컨테이너 안 요청의 응답. 이전 프런트 이미지는 이전 /try/ 본문을 낸다."""
        joined = " ".join(args)
        if "/try/" in joined:
            return OLD_TRY_HTML if image == OLD_FRONT_IMAGE else TRY_HTML
        if "healthz" in joined:
            return b"ok"
        if "http://127.0.0.1:80/" in joined:
            return DEV_INDEX
        return b""

    def fake_trusted_file(self, path):
        path = Path(path)
        self.trusted_calls.append(path)
        if self.reject_trusted(path):
            raise ValueError("unsafe trusted path permissions")
        return path

    def trusted(self, path):
        return Path(path) in self.trusted_calls

    @staticmethod
    def docker_core(args):
        """`docker --config DIR …` 전역 옵션을 걷어 낸 명령(분기용)과 그 DIR."""
        args = list(args)
        config = None
        while len(args) > 2 and (args[1] == "--config" or args[1].startswith("--config=")):
            if args[1] == "--config":
                config = args[2]
                del args[1:3]
            else:
                config = args[1].split("=", 1)[1]
                del args[1]
        return args, config

    def fake_run(self, args, cwd=None, timeout=300, binary=False, **kwargs):
        args = [str(a) for a in args]
        self.runs.append(args)
        core, config = self.docker_core(args) if os.path.basename(args[0]) == "docker" else (args, None)
        env = kwargs.get("env")
        if config is None and isinstance(env, dict):
            config = env.get("DOCKER_CONFIG")
        if config is not None:
            directory = Path(config)
            self.calls.append((core, config, directory.is_dir(), directory.is_dir() and not any(directory.iterdir())))
        else:
            self.calls.append((core, None, False, False))
        out = self._answer(core)
        if isinstance(out, (dict, list)):
            out = json.dumps(out)
        if binary:
            return out if isinstance(out, bytes) else out.encode()
        return out.decode().strip() if isinstance(out, bytes) else out

    def _answer(self, args):
        tool = os.path.basename(args[0])
        if tool == "git":
            if "clone" in args:
                self.write_source(args[-1])
                return ""
            if "rev-parse" in args:
                return self.tree_answer if any(a.endswith("^{tree}") for a in args) else SHA
            return ""
        if tool != "docker":
            raise AssertionError("unexpected external command: " + " ".join(args[:3]))
        verb = args[1:3]
        if "compose" in args and "up" in args:
            path = args[args.index("-f") + 1]
            self.events.append(("compose", path, "--remove-orphans" in args, "--no-build" in args, self.read_json(self.current), self.pending.exists()))
            if path in self.fail_compose_paths:
                raise RuntimeError("compose up failed")
            data = json.loads(Path(path).read_text())
            self.containers = {s.get("container_name", k): s["image"] for k, s in data["services"].items()}
            return ""
        if verb == ["manifest", "inspect"]:
            return oci_manifest()
        if verb == ["image", "inspect"] or (args[1] == "inspect" and any(APP_REPO in a for a in args)):
            image = self.known_image(args[2:])
            if "{{.Id}}" in " ".join(args):
                return image
            info = app_inspect() if image == APP_ENGINE_ID else {"Id": image, "RepoTags": [], "RepoDigests": [], "Architecture": "amd64", "Config": {}}
            return info if "{{json .}}" in " ".join(args) else [info]
        if args[1] == "inspect":
            name = args[-1]
            image = self.containers.get(name, self.known_image(args))
            state = {"Status": "running", "Running": True, "Health": {"Status": "healthy"}}
            state.update(self.container_states.get(name, {}))
            return [{"Id": "c" * 64, "Name": "/" + name, "Image": image, "State": state}]
        if args[1] == "run":
            if "--name" in args:
                self.containers[args[args.index("--name") + 1]] = self.known_image(args)
            return self.output(args, self.known_image(args)) if "--rm" in args else "c" * 64
        if args[1] == "exec":
            name = next((a for a in args[2:] if a in self.containers), None)
            joined = " ".join(args)
            if "healthz/ready" in joined and self.ready_fails:
                raise RuntimeError("command failed: docker exec")  # 0이 아닌 종료(503)
            if "/try/" in joined and self.front_try_override is not None:
                return self.front_try_override
            return self.output(args, self.containers.get(name))
        if args[1] == "network":
            return self.network_answer(args)
        if args[1] in {"pull", "build", "rm", "stop", "kill", "create", "start", "wait", "logs"} or verb == ["image", "rm"]:
            return ""
        return ""

    def network_answer(self, args):
        """읽기(inspect·ls)만 답한다. 없는 네트워크 inspect는 docker처럼 실패한다. 변경 명령은 기록만 한다."""
        sub = args[2] if len(args) > 2 else ""
        if sub == "inspect":
            names = [a for a in args[3:] if not a.startswith("-") and "{{" not in a]
            missing = [n for n in names if n not in self.networks]
            if missing:
                raise RuntimeError("command failed: docker network")
            items = [{"Name": n, "Driver": "bridge", "IPAM": {"Driver": "default", "Config": [{"Subnet": self.networks[n]}]}} for n in names]
            if "{{json .}}" in " ".join(args):
                return "\n".join(json.dumps(i) for i in items)
            return items
        if sub == "ls":
            if "{{json .}}" in " ".join(args) or "json" in args:
                return "\n".join(json.dumps({"Name": n, "Driver": "bridge"}) for n in self.networks)
            return "\n".join(self.networks)
        return ""

    def network_mutations(self):
        return [a for a in self.runs if os.path.basename(a[0]) == "docker" and len(a) > 2 and a[1] == "network" and a[2] in {"rm", "create", "prune", "disconnect", "connect"}]

    # --- 가짜 공개 검증 ---
    def fake_verify_static(self, record, env, settings):
        self.events.append(("verify-static", record["sha"], self.read_json(self.current), self.pending.exists()))
        if "static" in self.fail_verify:
            raise RuntimeError("static verification failed")

    def fake_verify_app(self, record, settings):
        kind = "new-app" if record.get("sha") == SHA and record.get("release_id") != self.preexisting_release() else "prev-app"
        self.events.append(("verify-app", record.get("release_id"), self.read_json(self.current), self.pending.exists()))
        if kind in self.fail_verify:
            raise RuntimeError(kind + " verification failed")

    def preexisting_release(self):
        return getattr(self, "_preexisting_release", None)

    # --- 실행 ---
    def deploy_app(self):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                deploy.deploy_app(SHA, TREE, MANIFEST, CONFIG, self.settings)
            finally:
                self.stdout, self.stderr = out.getvalue(), err.getvalue()

    def compose_events(self):
        return [e for e in self.events if e[0] == "compose"]

    def runs_after_first_compose(self):
        for index, args in enumerate(self.runs):
            if "compose" in args and "up" in args:
                return self.runs[index + 1 :]
        return []

    def assert_no_switch(self, current_before):
        self.assertEqual(self.compose_events(), [], "no compose up")
        self.assertFalse(self.pending.exists(), "no pending")
        self.assertEqual(self.read_json(self.current), current_before, "current record unchanged")


# ================================================================= 흐름: 최초·이후 배포와 복귀 §6.4·§6.7·§10


class DeployAppTransitionTests(AppFlowBase):
    def test_first_app_release_from_static_records_exact_fields_only_after_verification(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        self.write_json(self.static_last, previous)
        self.deploy_app()

        record = self.read_json(self.current)
        self.assertEqual(
            set(record),
            {"mode", "status", "sha", "tree", "release_id", "front_image_id", "app_image_id", "app_manifest_digest", "app_config_digest", "try_html_sha256", "compose_sha256", "env_sha256", "timestamp"},
            "exact app record keys (no path fields)",
        )
        self.assertEqual((record["mode"], record["status"], record["sha"], record["tree"]), ("app", "success", SHA, TREE))
        self.assertEqual((record["app_manifest_digest"], record["app_config_digest"]), (MANIFEST, CONFIG))
        self.assertEqual(record["app_image_id"], APP_ENGINE_ID, "engine image ID from the pulled image, not the config digest")
        self.assertEqual(record["front_image_id"], FRONT_IMAGE)
        self.assertEqual(record["try_html_sha256"], sha256_hex(TRY_HTML))
        self.assertRegex(record["release_id"], RELEASE_RE)
        self.assertTrue(record["release_id"].startswith(SHA + "-"))
        release_dir = self.state / "releases" / "dev" / record["release_id"]
        frozen = release_dir / "app.env"
        self.assertEqual(frozen.read_bytes(), self.live_env.read_bytes(), "env frozen from the validated live file")
        self.assertEqual(stat.S_IMODE(frozen.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(release_dir.stat().st_mode), 0o700)
        self.assertEqual(record["env_sha256"], sha256_hex(frozen.read_bytes()))
        compose_file = release_dir / "compose.json"
        self.assertEqual(record["compose_sha256"], sha256_hex(compose_file.read_bytes()))
        self.assertEqual(
            json.loads(compose_file.read_text()),
            deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, record["release_id"], self.user.uid, self.user.gid, self.settings),
        )
        composes = self.compose_events()
        self.assertEqual([e[1] for e in composes], [str(compose_file)])
        self.assertTrue(composes[0][2] and composes[0][3], "compose up --remove-orphans --no-build")
        self.assertTrue(composes[0][5], "pending exists while switching")
        self.assertEqual(composes[0][4], previous, "current still the static record while switching")
        verify = [e for e in self.events if e[0] == "verify-app"]
        self.assertEqual(len(verify), 1)
        self.assertEqual(verify[0][2], previous, "not recorded before verification")
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.read_json(self.static_last), previous, "dev-static-last.json changes only on static success")
        pulls = [a for a in self.runs if os.path.basename(a[0]) == "docker" and "pull" in a]
        self.assertTrue(pulls and all(any(f"{APP_REPO}@{MANIFEST}" in x for x in a) for a in pulls), "pull by the fixed repository and digest")
        assert_no_secret(self, self.stdout + self.stderr, "output")
        self.assertEqual(self.network_mutations(), [], "the helper never creates, removes or reconnects networks itself")

    def test_candidates_run_hardened_without_env_and_the_pull_is_anonymous_platform_pinned_after_manifest_check(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        self.deploy_app()
        docker = [(c, cfg, is_dir, empty) for c, cfg, is_dir, empty in self.calls if os.path.basename(c[0]) == "docker"]

        def first(pred):
            return next((i for i, item in enumerate(docker) if pred(item[0])), None)

        manifest_at = first(lambda c: c[1:3] == ["manifest", "inspect"])
        pull_at = first(lambda c: c[1] == "pull")
        compose_at = first(lambda c: "compose" in c and "up" in c)
        self.assertIsNotNone(manifest_at, "docker manifest inspect of the fixed digest")
        self.assertIsNotNone(pull_at, "docker pull of the fixed digest")
        self.assertLess(manifest_at, pull_at, "the manifest is validated before pulling")
        for at in (manifest_at, pull_at):
            core, config, is_dir, empty = docker[at]
            with self.subTest(command=core[1:3]):
                self.assertIn(f"{APP_REPO}@{MANIFEST}", core)
                self.assertIsNotNone(config, "an explicit DOCKER_CONFIG (env or --config)")
                self.assertTrue(is_dir and empty, "anonymous registry access: the Docker config directory exists and is empty")
        self.assertEqual(flag_values(docker[pull_at][0], "--platform"), ["linux/amd64"])

        before_switch = [c for c, _, _, _ in docker[:compose_at]]
        runs = [c for c in before_switch if c[1] == "run"]
        app_runs = [c for c in runs if self.known_image(c[2:]) == APP_ENGINE_ID]
        front_runs = [c for c in runs if self.known_image(c[2:]) == FRONT_IMAGE]
        previous_runs = [c for c in runs if self.known_image(c[2:]) == OLD_FRONT_IMAGE]
        self.assertTrue(app_runs, "an app candidate container before switching")
        self.assertTrue(front_runs, "a front candidate container before switching")
        self.assertTrue(previous_runs, "the previous record is checked as a candidate (rollback possible)")
        for c in app_runs:
            with self.subTest(candidate="app"):
                self.assertEqual(flag_values(c, "--network"), ["none"])
                self.assertIn("--read-only", c)
                self.assertTrue(any(v.startswith("/tmp") for v in flag_values(c, "--tmpfs")), "tmpfs /tmp")
                self.assertEqual(flag_values(c, "--cap-drop"), ["ALL"])
                self.assertTrue(any(v.startswith("no-new-privileges") for v in flag_values(c, "--security-opt")))
                self.assertEqual(flag_values(c, "--user"), [f"{self.user.uid}:{self.user.gid}"])
                for forbidden in ("-e", "--env", "--env-file", "-v", "--volume", "--mount", "--privileged", "-p", "--publish", "--cap-add", "--device"):
                    self.assertFalse(any(a == forbidden or a.startswith(forbidden + "=") for a in c), f"app candidate must not use {forbidden}")
                self.assertFalse(any("app.env" in a or "pod_app_env" in a or str(self.live_env) in a for a in c), "no env or secret for the candidate")
        for c in front_runs + previous_runs:
            with self.subTest(candidate="front"):
                self.assertEqual(flag_values(c, "--network"), ["none"])
                self.assertIn("--read-only", c)
        joined = [" ".join(c) for c in before_switch]
        self.assertTrue(any("http://127.0.0.1:3000/healthz" in j and "ready" not in j for j in joined), "app candidate /healthz check")
        self.assertTrue(any("/try/" in j for j in joined), "front candidate /try/ check")

    def test_existing_dedicated_networks_with_the_same_ipam_are_reused(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        self.networks = {"pieceofdays-dev-front": FRONT_SUBNET, "pieceofdays-dev-egress": EGRESS_SUBNET, "edge": "172.18.0.0/16", "ci-only-db-network": "172.19.0.0/16"}
        self.deploy_app()
        self.assertEqual(self.read_json(self.current)["sha"], SHA)
        self.assertEqual(self.network_mutations(), [])

    def test_existing_dedicated_network_with_a_different_ipam_is_refused_without_modifying_it(self):
        previous = self.static_record()
        for name, subnet in (("pieceofdays-dev-front", "10.231.99.0/24"), ("pieceofdays-dev-egress", "192.168.77.0/24")):
            with self.subTest(network=name):
                self.events.clear()
                self.runs.clear()
                self.write_json(self.current, previous)
                self.networks = {"pieceofdays-dev-front": FRONT_SUBNET, "pieceofdays-dev-egress": EGRESS_SUBNET, name: subnet}
                with self.assertRaises(Exception):
                    self.deploy_app()
                self.assert_no_switch(previous)
                self.assertEqual(self.network_mutations(), [], "an existing network is never modified or removed")

    def test_first_app_release_failure_returns_to_the_static_compose_with_remove_orphans(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        self.fail_verify = {"new-app"}
        with self.assertRaises(Exception):
            self.deploy_app()
        composes = self.compose_events()
        self.assertGreaterEqual(len(composes), 2)
        self.assertEqual(composes[-1][1], previous["compose_path"], "back to the static compose")
        self.assertTrue(composes[-1][2], "--remove-orphans removes the app container")
        self.assertIn(("verify-static", OLD_SHA), [e[:2] for e in self.events])
        self.assertEqual(self.read_json(self.current), previous)
        self.assertFalse(self.pending.exists())
        self.assertFalse(any("pull" in a or "manifest" in a for a in self.runs_after_first_compose()), "rollback needs no registry")

    def test_later_app_release_failure_returns_to_the_previous_release_frozen_env_and_local_images(self):
        previous = self.app_record()
        self._preexisting_release = OLD_RELEASE
        self.write_json(self.current, previous)
        old_env = (self.state / "releases" / "dev" / OLD_RELEASE / "app.env").read_bytes()
        write_private(self.live_env, env_text(POD_WITHDRAWAL_ENABLED="1"))
        self.fail_verify = {"new-app"}
        with self.assertRaises(Exception):
            self.deploy_app()
        composes = self.compose_events()
        previous_compose = str(self.state / "releases" / "dev" / OLD_RELEASE / "compose.json")
        self.assertEqual(composes[-1][1], previous_compose)
        self.assertTrue(composes[-1][2], "--remove-orphans")
        self.assertEqual(self.containers.get("pieceofdays-app-dev"), OLD_APP_ENGINE_ID)
        self.assertEqual(self.containers.get("pieceofdays-frontend-dev"), OLD_FRONT_IMAGE)
        self.assertIn(OLD_RELEASE, [e[1] for e in self.events if e[0] == "verify-app"])
        self.assertEqual((self.state / "releases" / "dev" / OLD_RELEASE / "app.env").read_bytes(), old_env, "frozen env untouched")
        self.assertEqual(self.read_json(self.current), previous)
        self.assertFalse(self.pending.exists())
        self.assertFalse(any("pull" in a or "manifest" in a for a in self.runs_after_first_compose()), "rollback needs no registry")

    def test_rollback_failure_preserves_pending_with_the_previous_record(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        self.fail_verify = {"new-app"}
        self.fail_compose_paths = {previous["compose_path"]}
        with self.assertRaises(Exception):
            self.deploy_app()
        self.assertTrue(self.pending.exists())
        self.assertEqual(self.read_json(self.pending), previous)
        self.assertNotEqual((self.read_json(self.current) or {}).get("sha"), SHA)

    def test_rollback_verification_failure_also_preserves_pending(self):
        previous = self.app_record()
        self._preexisting_release = OLD_RELEASE
        self.write_json(self.current, previous)
        self.fail_verify = {"new-app", "prev-app"}
        with self.assertRaises(Exception):
            self.deploy_app()
        self.assertEqual(self.read_json(self.pending), previous)
        self.assertNotEqual((self.read_json(self.current) or {}).get("sha"), SHA)


class DeployAppIdempotencyAndRotationTests(AppFlowBase):
    def same_release(self):
        record = self.app_record(sha=SHA, tree=TREE, release=SHA + "-" + "2" * 32, env=env_text(), manifest=MANIFEST, config=CONFIG, app_id=APP_ENGINE_ID, front=FRONT_IMAGE)
        self._preexisting_release = record["release_id"]
        self.write_json(self.current, record)
        return record

    def test_same_sha_digests_and_live_env_hash_is_an_idempotent_health_check_without_a_new_release(self):
        record = self.same_release()
        before = self.release_dirs()
        self.deploy_app()
        self.assertEqual(self.compose_events(), [], "no switch")
        self.assertEqual(self.release_dirs(), before, "no new release directory")
        self.assertIn(record["release_id"], [e[1] for e in self.events if e[0] == "verify-app"])
        self.assertEqual({k: v for k, v in self.read_json(self.current).items() if k != "timestamp"}, {k: v for k, v in record.items() if k != "timestamp"})
        self.assertFalse(self.pending.exists())

    def test_changed_live_env_with_the_same_sha_and_digests_creates_a_new_release(self):
        record = self.same_release()
        rotated = env_text(POD_AUTH_SESSION_SECRETS=json.dumps({"1": SESSION_KEY, "2": "r" * 40}, separators=(",", ":")))
        write_private(self.live_env, rotated)
        self.deploy_app()
        new = self.read_json(self.current)
        self.assertNotEqual(new["release_id"], record["release_id"])
        self.assertEqual(new["env_sha256"], sha256_hex(rotated.encode()))
        self.assertEqual((self.state / "releases" / "dev" / new["release_id"] / "app.env").read_bytes(), rotated.encode())
        self.assertEqual((self.state / "releases" / "dev" / record["release_id"] / "app.env").read_bytes(), env_text().encode(), "old release kept")
        self.assertEqual(len(self.compose_events()), 1)
        self.assertEqual(self.compose_events()[0][1], str(self.state / "releases" / "dev" / new["release_id"] / "compose.json"))


class DeployAppRecoveryAndRefusalTests(AppFlowBase):
    def test_interrupted_pending_app_record_is_restored_first(self):
        pending = self.app_record()
        self._preexisting_release = OLD_RELEASE
        self.write_json(self.current, self.static_record(sha=SHA2_FOR_PENDING, tree=OTHER_TREE))
        self.write_json(self.pending, pending)
        self.mocks["assert_latest"].side_effect = ValueError("stop after recovery")
        with self.assertRaises(ValueError):
            self.deploy_app()
        composes = self.compose_events()
        self.assertEqual(composes[0][1], str(self.state / "releases" / "dev" / OLD_RELEASE / "compose.json"))
        self.assertTrue(composes[0][2], "--remove-orphans")
        self.assertIn(OLD_RELEASE, [e[1] for e in self.events if e[0] == "verify-app"])
        self.assertEqual(self.read_json(self.current), pending)
        self.assertFalse(self.pending.exists())

    def test_interrupted_pending_static_record_is_restored_with_remove_orphans(self):
        pending = self.static_record()
        self.write_json(self.current, self.app_record())
        self.write_json(self.pending, pending)
        self.mocks["assert_latest"].side_effect = ValueError("stop after recovery")
        with self.assertRaises(ValueError):
            self.deploy_app()
        composes = self.compose_events()
        self.assertEqual(composes[0][1], pending["compose_path"])
        self.assertTrue(composes[0][2], "--remove-orphans")
        self.assertIn(("verify-static", OLD_SHA), [e[:2] for e in self.events])
        self.assertEqual(self.read_json(self.current), pending)
        self.assertFalse(self.pending.exists())

    def test_unknown_record_modes_are_refused_without_switching(self):
        for where in ("current", "pending"):
            with self.subTest(where=where):
                self.events.clear()
                weird = {**self.static_record(), "mode": "hybrid"}
                for path in (self.current, self.pending):
                    if path.exists():
                        path.unlink()
                self.write_json(self.current if where == "current" else self.pending, weird)
                if where == "pending":
                    self.write_json(self.current, self.static_record())
                with self.assertRaises(Exception):
                    self.deploy_app()
                self.assertEqual(self.compose_events(), [])
                if where == "pending":
                    self.assertEqual(self.read_json(self.pending), weird, "unknown pending is preserved, not deleted")

    def test_tree_mismatch_is_refused_before_registry_access_or_switching(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        self.tree_answer = OTHER_TREE
        with self.assertRaises(Exception):
            self.deploy_app()
        self.assertFalse(any(os.path.basename(a[0]) == "docker" and ("pull" in a or "manifest" in a) for a in self.runs))
        self.assert_no_switch(previous)

    def test_invalid_manifest_or_pulled_image_is_refused_before_switching(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        for name in ("validate_app_manifest", "validate_app_image"):
            with self.subTest(check=name):
                self.events.clear()
                with mock.patch.object(deploy, name, side_effect=ValueError(name + " refused")):
                    with self.assertRaises(ValueError):
                        self.deploy_app()
                self.assert_no_switch(previous)
                self.assertFalse(any((self.state / "releases" / "dev" / d / "app.env").exists() for d in self.release_dirs()), "no frozen env written")

    def test_invalid_or_unsafe_live_env_is_refused_before_switching_and_values_are_not_printed(self):
        """시험 경계: live env의 regular file·0600·배포 사용자 소유 검사는 env 전용 검사(PLAN §6.2)다.

        trusted_file(경로 신뢰 규칙)은 이 시험에서 spy라 통과시키므로, 0640·0644 거부는 trusted_file 밖의
        env 전용 검사로 나와야 한다. 경로 신뢰 거부 자체는 TrustedPathTests가 따로 확인한다.
        """
        previous = self.static_record()
        self.write_json(self.current, previous)
        cases = {
            "fixture key": (env_text() + "POD_LOCAL_FIXTURE=1\n", 0o600),
            "wrong role": (env_text(POD_DATABASE_URL=f"postgres://pod_migrator_dev:{DB_PASSWORD}@ci-only-pg18/pod_dev"), 0o600),
            "group readable": (env_text(), 0o640),
            "world readable": (env_text(), 0o644),
        }
        for label, (text, mode) in cases.items():
            with self.subTest(label=label):
                self.events.clear()
                write_private(self.live_env, text, mode)
                with self.assertRaises(Exception) as caught:
                    self.deploy_app()
                assert_no_secret(self, str(caught.exception) + self.stdout + self.stderr, label)
                self.assert_no_switch(previous)
                self.assertFalse(any((self.state / "releases" / "dev" / d / "app.env").exists() for d in self.release_dirs()))

    def test_static_deploy_dev_is_refused_while_dev_is_in_app_mode(self):
        current = self.app_record()
        self.write_json(self.current, current)
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(Exception):
                deploy.deploy("dev", SHA, self.settings)
        self.assert_no_switch(current)
        self.assertFalse(any(os.path.basename(a[0]) == "docker" and "build" in a for a in self.runs), "no static build in app mode")


SHA2_FOR_PENDING = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"


class RevertStaticTests(AppFlowBase):
    REQUIRED = AppFlowBase.REQUIRED + ("revert_static",)

    def test_revert_static_restores_the_last_static_record_with_remove_orphans_after_verification(self):
        static = self.static_record()
        self.write_json(self.static_last, static)
        self.write_json(self.current, self.app_record())
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.revert_static(self.settings)
        composes = self.compose_events()
        self.assertEqual(composes[-1][1], static["compose_path"])
        self.assertTrue(composes[-1][2], "--remove-orphans removes the app container")
        self.assertIn(("verify-static", OLD_SHA), [e[:2] for e in self.events])
        self.assertEqual(self.read_json(self.current), static)
        self.assertFalse(self.pending.exists())
        self.assertFalse(any("pull" in a or "manifest" in a for a in self.runs), "no registry access")

    def test_revert_static_reads_the_static_record_through_trusted_file_and_a_rejection_changes_nothing(self):
        static = self.static_record()
        self.write_json(self.static_last, static)
        app = self.app_record()
        self.write_json(self.current, app)
        self.reject_trusted = lambda p: p == self.static_last
        with self.assertRaises(ValueError):
            deploy.revert_static(self.settings)
        self.assertIn(self.static_last, self.trusted_calls)
        self.assertEqual(self.compose_events(), [])
        self.assertEqual(self.read_json(self.current), app)
        self.assertFalse(self.pending.exists())

    def test_revert_static_without_a_static_record_or_with_failed_verification_keeps_the_app_record_current(self):
        app = self.app_record()
        self.write_json(self.current, app)
        with self.assertRaises(Exception):
            deploy.revert_static(self.settings)
        self.assertEqual(self.compose_events(), [])
        self.assertEqual(self.read_json(self.current), app)

        static = self.static_record()
        self.write_json(self.static_last, static)
        self.fail_verify = {"static"}
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(Exception):
                deploy.revert_static(self.settings)
        self.assertNotEqual(self.read_json(self.current), static, "current changes only after verification")


class StaticDevSuccessUpdatesStaticLastTests(AppFlowBase):
    def test_successful_static_dev_deploy_also_records_dev_static_last(self):
        previous = self.static_record()
        self.write_json(self.current, previous)
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.deploy("dev", SHA, self.settings)
        current = self.read_json(self.current)
        self.assertEqual(current["sha"], SHA)
        self.assertNotIn("mode", current, "static records keep their existing shape")
        self.assertEqual(self.read_json(self.static_last), current)


# ================================================================= 앱 기록 읽기 §6.4


class ValidateAppRecordTests(AppFlowBase):
    def setUp(self):
        # 흐름 시험은 validate_app_record를 identity로 바꾸므로, 바꾸기 전 실제 함수를 잡아 둔다.
        # 실제 함수는 같은 deploy 모듈의 STATE·run·trusted_file(시험이 바꾼 경계)을 쓴다.
        require(self, "validate_app_record")
        self.real_validate = deploy.validate_app_record
        super().setUp()
        self.record = self.app_record()
        self.release_dir = self.state / "releases" / "dev" / OLD_RELEASE

    def validate(self, record):
        return self.real_validate(record, self.settings)

    def test_valid_record_is_returned_unchanged(self):
        self.assertEqual(self.validate(copy.deepcopy(self.record)), self.record)

    def test_shape_paths_and_formats_are_rejected(self):
        bad = {
            "path field": {**self.record, "compose_path": str(self.release_dir / "compose.json")},
            "missing env hash": {k: v for k, v in self.record.items() if k != "env_sha256"},
            "static mode": {**self.record, "mode": "static"},
            "no mode": {k: v for k, v in self.record.items() if k != "mode"},
            "status": {**self.record, "status": "pending"},
            "traversal release": {**self.record, "release_id": "../" + OLD_RELEASE},
            "uppercase release": {**self.record, "release_id": OLD_RELEASE.upper()},
            "bad image id": {**self.record, "app_image_id": f"{APP_REPO}@{OLD_MANIFEST}"},
            "bad digest": {**self.record, "app_manifest_digest": "sha256:xyz"},
            "bad sha": {**self.record, "sha": OLD_SHA[:-1]},
        }
        for label, record in bad.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    self.validate(record)

    def test_frozen_files_must_match_hashes_permissions_template_and_env_rules(self):
        compose = self.release_dir / "compose.json"
        frozen = self.release_dir / "app.env"
        original_compose, original_env = compose.read_bytes(), frozen.read_bytes()

        def restore():
            for path in (compose, frozen):
                if path.is_symlink() or path.exists():
                    path.unlink()
            write_private(compose, original_compose)
            write_private(frozen, original_env)

        cases = []

        def compose_changed():
            data = json.loads(original_compose)
            data["services"]["pieceofdays-app-dev"]["privileged"] = True
            write_private(compose, json.dumps(data))
            return {**self.record, "compose_sha256": sha256_hex(compose.read_bytes())}

        def env_hash_mismatch():
            write_private(frozen, env_text(POD_WITHDRAWAL_ENABLED="1"))
            return self.record

        def env_invalid_but_hashed():
            text = original_env + b"POD_LOCAL_FIXTURE=1\n"
            write_private(frozen, text)
            return {**self.record, "env_sha256": sha256_hex(text)}

        def env_mode():
            os.chmod(frozen, 0o644)
            return self.record

        def env_symlink():
            target = self.state / "elsewhere.env"
            write_private(target, original_env)
            frozen.unlink()
            os.symlink(target, frozen)
            return self.record

        def compose_hash_mismatch():
            write_private(compose, original_compose + b"\n")
            return self.record

        cases = [compose_changed, env_hash_mismatch, env_invalid_but_hashed, env_mode, env_symlink, compose_hash_mismatch]
        for make in cases:
            with self.subTest(case=make.__name__):
                record = make()
                with self.assertRaises(ValueError):
                    self.validate(record)
                restore()

    def test_release_dir_frozen_env_and_compose_paths_go_through_trusted_file_and_a_rejection_fails(self):
        self.assertEqual(self.validate(copy.deepcopy(self.record)), self.record)
        paths = (self.release_dir, self.release_dir / "app.env", self.release_dir / "compose.json")
        for path in paths:
            with self.subTest(trusted=str(path.relative_to(self.state))):
                self.assertTrue(self.trusted(path), "validate_app_record must apply trusted_file to this path")
        for path in paths:
            with self.subTest(reject=str(path.relative_to(self.state))):
                self.reject_trusted = lambda p, target=path: p == target
                with self.assertRaises(ValueError):
                    self.validate(copy.deepcopy(self.record))
        self.reject_trusted = lambda p: False

    def test_missing_local_image_is_rejected(self):
        original = self.fake_run

        def run(args, cwd=None, timeout=300, binary=False):
            if any(OLD_APP_ENGINE_ID in str(a) for a in args):
                raise RuntimeError("command failed: docker image")
            return original(args, cwd=cwd, timeout=timeout, binary=binary)

        deploy.run.side_effect = run
        with self.assertRaises(Exception):
            self.validate(copy.deepcopy(self.record))


# ================================================================= 신뢰 경로 spy §6.2·§6.4


class TrustedPathTests(AppFlowBase):
    """deploy_app이 live env·새 릴리스 폴더·current·pending에 trusted_file을 적용하고, 거부되면 아무것도 바꾸지 않는다.

    /tmp(1777) 부모 때문에 실제 trusted_file 규칙은 쓰지 않는다. spy가 호출 경로를 기록하고 지정 경로에서 ValueError를 낸다.
    """

    def new_release_dir(self, path):
        return path.parent == self.state / "releases" / "dev" and path.name.startswith(SHA + "-")

    def frozen_envs(self):
        return [d for d in self.release_dirs() if d.startswith(SHA + "-") and (self.state / "releases" / "dev" / d / "app.env").exists()]

    def test_successful_deploy_applies_trusted_file_to_live_env_new_release_dir_and_current(self):
        self.write_json(self.current, self.static_record())
        self.deploy_app()
        self.assertTrue(self.trusted(self.live_env), "live env file")
        self.assertTrue(self.trusted(self.current), "current record")
        self.assertTrue(any(self.new_release_dir(p) for p in self.trusted_calls), "new release directory")

    def test_interrupted_pending_is_read_through_trusted_file(self):
        self.write_json(self.current, self.app_record())
        self.write_json(self.pending, self.static_record())
        self.mocks["assert_latest"].side_effect = ValueError("stop after recovery")
        with self.assertRaises(ValueError):
            self.deploy_app()
        self.assertTrue(self.trusted(self.pending))

    def test_rejection_at_each_path_leaves_services_and_records_unchanged(self):
        previous = self.static_record()
        cases = {
            "live env": lambda p: p == self.live_env,
            "new release directory": self.new_release_dir,
            "current record": lambda p: p == self.current,
        }
        for label, reject in cases.items():
            with self.subTest(reject=label):
                self.events.clear()
                self.write_json(self.current, previous)
                self.reject_trusted = reject
                with self.assertRaises(ValueError):
                    self.deploy_app()
                self.assert_no_switch(previous)
                self.assertEqual(self.frozen_envs(), [], "no frozen env written")
        self.reject_trusted = lambda p: False

    def test_rejected_pending_is_neither_recovered_nor_deleted(self):
        current = self.app_record()
        pending = self.static_record()
        self.write_json(self.current, current)
        self.write_json(self.pending, pending)
        self.reject_trusted = lambda p: p == self.pending
        with self.assertRaises(ValueError):
            self.deploy_app()
        self.assertEqual(self.compose_events(), [])
        self.assertEqual(self.read_json(self.pending), pending)
        self.assertEqual(self.read_json(self.current), current)


# ================================================================= 실제 verify_app_release §6.7 8단계


class FakeResponse(io.BytesIO):
    def __init__(self, url, status, headers, body):
        super().__init__(body)
        self.url, self.status, self.code = url, status, status
        self.headers = http.client.HTTPMessage()
        for key, value in headers.items():
            self.headers[key] = value

    def getcode(self):
        return self.status

    def geturl(self):
        return self.url

    def info(self):
        return self.headers

    def getheader(self, name, default=None):
        return self.headers.get(name, default)


class VerifyAppReleaseTests(AppFlowBase):
    """실제 verify_app_release를 fake run(docker)·fake HTTPS opener 경계로 부른다.

    시험 경계:
    - 컨테이너 상태는 `docker inspect <이름>`의 Image·State.Running·State.Health.Status로 답한다.
    - 컨테이너 안 요청은 `docker exec <이름> …`이다. 앱 안 /healthz/ready는 명령의 종료 상태로 판정한다(0이 아니면 실패, 이미지에 wget이 없으므로 node fetch 종료 코드 등).
      프런트 안 /try/는 exec 출력 본문의 sha256이다.
    - 공개 HTTPS는 urllib.request.build_opener/urlopen 경계다. fake opener는 실제 urllib처럼 redirect를 처리한다:
      넘겨받은 HTTPRedirectHandler의 redirect_request가 None이면 따라가지 않고 HTTPError, 아니면(기본 처리기 포함) 따라간다.
      4xx·5xx는 HTTPError다.
    """

    LOGIN = "https://dev.pieceofdays.com/login"

    def setUp(self):
        require(self, "verify_app_release")
        self.real_verify = deploy.verify_app_release
        super().setUp()
        self.http_requests = []
        for name, side_effect in (("build_opener", self.fake_build_opener), ("urlopen", self.fake_urlopen)):
            patcher = mock.patch.object(deploy.urllib.request, name, side_effect=side_effect)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.record = self.app_record(sha=SHA, tree=TREE, release=SHA + "-" + "3" * 32, manifest=MANIFEST, config=CONFIG, app_id=APP_ENGINE_ID, front=FRONT_IMAGE)
        self.reset_world()

    def reset_world(self):
        self.containers = {"pieceofdays-frontend-dev": FRONT_IMAGE, "pieceofdays-app-dev": APP_ENGINE_ID}
        self.container_states = {}
        self.ready_fails = False
        self.front_try_override = None
        self.http = {
            self.settings["app_health_url"]: (200, {"Content-Type": "text/html"}, TRY_HTML),
            self.LOGIN: (200, {"Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate"}, b"<!doctype html><title>login</title>"),
        }

    # --- fake HTTPS ---
    def fake_build_opener(self, *handlers):
        test = self

        class Opener:
            def open(self, request, data=None, timeout=None):
                return test.open_url(request, handlers)

        return Opener()

    def fake_urlopen(self, request, data=None, timeout=None, **kwargs):
        return self.open_url(request, ())

    def open_url(self, request, handlers):
        url = getattr(request, "full_url", request)
        self.http_requests.append(url)
        status, headers, body = self.http.get(url, (404, {}, b""))
        message = http.client.HTTPMessage()
        for key, value in headers.items():
            message[key] = value
        if status in (301, 302, 303, 307, 308):
            location = headers["Location"]
            req = request if isinstance(request, urllib.request.Request) else urllib.request.Request(url)
            redirectors = [h for h in handlers if isinstance(h, urllib.request.HTTPRedirectHandler)] or [urllib.request.HTTPRedirectHandler()]
            if all(h.redirect_request(req, io.BytesIO(body), status, "redirect", message, location) is not None for h in redirectors):
                return self.open_url(location, handlers)
            raise urllib.error.HTTPError(url, status, "redirect", message, io.BytesIO(body))
        if status >= 400:
            raise urllib.error.HTTPError(url, status, "error", message, io.BytesIO(body))
        return FakeResponse(url, status, headers, body)

    def verify(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return self.real_verify(copy.deepcopy(self.record), self.settings)

    def test_healthy_release_passes_and_every_check_is_performed(self):
        self.assertIsNone(self.verify())
        docker = [c for c, _, _, _ in self.calls if os.path.basename(c[0]) == "docker"]
        for name in ("pieceofdays-frontend-dev", "pieceofdays-app-dev"):
            with self.subTest(container=name):
                self.assertTrue(any("inspect" in c and name in c for c in docker), "container state inspected")
        self.assertTrue(any(c[1] == "exec" and "pieceofdays-app-dev" in c and "healthz/ready" in " ".join(c) for c in docker), "app internal readiness")
        self.assertTrue(any(c[1] == "exec" and "pieceofdays-frontend-dev" in c and "/try/" in " ".join(c) for c in docker), "front internal /try/")
        self.assertIn(self.settings["app_health_url"], self.http_requests)
        self.assertIn(self.LOGIN, self.http_requests)

    def test_each_mismatch_fails_verification(self):
        cases = {
            "app container image": lambda: self.containers.__setitem__("pieceofdays-app-dev", OLD_APP_ENGINE_ID),
            "front container image": lambda: self.containers.__setitem__("pieceofdays-frontend-dev", OLD_FRONT_IMAGE),
            "app not running": lambda: self.container_states.__setitem__("pieceofdays-app-dev", {"Running": False, "Status": "exited"}),
            "front not running": lambda: self.container_states.__setitem__("pieceofdays-frontend-dev", {"Running": False, "Status": "exited"}),
            "app unhealthy": lambda: self.container_states.__setitem__("pieceofdays-app-dev", {"Health": {"Status": "unhealthy"}}),
            "app never healthy": lambda: self.container_states.__setitem__("pieceofdays-app-dev", {"Health": {"Status": "starting"}}),
            "front unhealthy": lambda: self.container_states.__setitem__("pieceofdays-frontend-dev", {"Health": {"Status": "unhealthy"}}),
            "app readiness 503": lambda: setattr(self, "ready_fails", True),
            "front /try/ hash": lambda: setattr(self, "front_try_override", b"<!doctype html><title>other</title>\n"),
            "public /try/ hash": lambda: self.http.__setitem__(self.settings["app_health_url"], (200, {}, b"other")),
            "public /try/ 503": lambda: self.http.__setitem__(self.settings["app_health_url"], (503, {}, b"")),
            "/login redirect is not followed": lambda: self.http.update(
                {self.LOGIN: (302, {"Location": self.LOGIN + "/next"}, b""), self.LOGIN + "/next": (200, {"Cache-Control": "no-store"}, b"")}
            ),
            "/login without Cache-Control": lambda: self.http.__setitem__(self.LOGIN, (200, {}, b"login")),
            "/login cacheable": lambda: self.http.__setitem__(self.LOGIN, (200, {"Cache-Control": "public, max-age=60"}, b"login")),
            "/login 500": lambda: self.http.__setitem__(self.LOGIN, (500, {"Cache-Control": "no-store"}, b"")),
        }
        for label, mutate in cases.items():
            with self.subTest(case=label):
                self.reset_world()
                mutate()
                with self.assertRaises(Exception):
                    self.verify()
        self.reset_world()


# ================================================================= 운영 승격 경계 §6.5


class ProductionPromotionBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.state = Path(os.path.realpath(tempfile.mkdtemp(prefix="pieceofdays-promo-")))
        self.addCleanup(lambda: shutil.rmtree(self.state, ignore_errors=True))
        self.validate_record = mock.Mock(side_effect=lambda record, env: record)
        self.run = mock.Mock(side_effect=AssertionError("no external command"))
        for name, value in (("STATE", self.state), ("validate_record", self.validate_record), ("run", self.run), ("trusted_file", mock.Mock(side_effect=lambda p: Path(p)))):
            patcher = mock.patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_current(self, record):
        (self.state / "dev-current.json").write_text(json.dumps(record))

    def test_dev_app_record_is_refused_before_any_other_check(self):
        for record in (
            {"mode": "app", "status": "success", "sha": SHA, "tree": TREE, "release_id": SHA + "-" + "e" * 32},
            {"mode": "app"},
            {"mode": "app", "status": "failed", "tree": "not-hex"},
        ):
            with self.subTest(record=record):
                self.write_current(record)
                with self.assertRaises(ValueError) as caught:
                    deploy.validated_dev_tree(TREE)
                self.assertEqual(str(caught.exception), "dev app record is not a production promotion basis")
                self.validate_record.assert_not_called()
                self.run.assert_not_called()

    def test_static_record_for_the_same_tree_is_still_accepted_and_other_trees_refused(self):
        static = {"status": "success", "sha": SHA, "tree": TREE, "image_id": "sha256:" + "e" * 64, "serving_html_sha256": "c" * 64, "compose_path": "/x", "compose_sha256": "d" * 64, "timestamp": "t"}
        self.write_current(static)
        self.assertIsNone(deploy.validated_dev_tree(TREE))
        with self.assertRaises(ValueError):
            deploy.validated_dev_tree(OTHER_TREE)


# ================================================================= main: 키·설정 경계 §6.1·§6.2


def side_effect_mocks(test, extra=()):
    mocks = {}
    for name in ("read_json", "run", "deploy", "compose_up", "verify_release", "atomic_json", *extra):
        patcher = mock.patch.object(deploy, name)
        mocks[name] = patcher.start()
        test.addCleanup(patcher.stop)
    for target, attr in ((deploy.subprocess, "run"), (deploy.fcntl, "flock"), (deploy.signal, "signal"), (deploy.urllib.request, "urlopen")):
        patcher = mock.patch.object(target, attr)
        mocks[f"{target.__name__}.{attr}"] = patcher.start()
        test.addCleanup(patcher.stop)
    return mocks


def run_main(test, allowed_env, command):
    argv = ["deploy.py", "--config", "/nonexistent/pieceofdays-deploy.json", "--allowed-environment", allowed_env]
    env_patch = mock.patch.dict(os.environ, {}, clear=False)
    env_patch.start()
    test.addCleanup(env_patch.stop)
    os.environ.pop("SSH_ORIGINAL_COMMAND", None)
    if command is not None:
        os.environ["SSH_ORIGINAL_COMMAND"] = command
    with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
        deploy.main()


class MainAppCommandTests(unittest.TestCase):
    APP_FUNCS = ("deploy_app", "revert_static")

    def test_app_commands_with_the_production_key_or_malformed_are_refused_before_config_registry_or_docker(self):
        require(self, *self.APP_FUNCS)
        for allowed, command in (
            ("production", f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}"),
            ("production", "revert-static dev"),
            ("production", f"deploy-app production {SHA} {TREE} {MANIFEST} {CONFIG}"),
            ("dev", f"deploy-app production {SHA} {TREE} {MANIFEST} {CONFIG}"),
            ("dev", "revert-static production"),
            ("dev", f"deploy-app dev {SHA} {TREE} {MANIFEST}"),
            ("dev", f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG} ; id"),
        ):
            with self.subTest(allowed=allowed, command=command):
                mocks = side_effect_mocks(self, self.APP_FUNCS)
                with self.assertRaises(Exception) as caught:
                    run_main(self, allowed, command)
                self.assertNotIsInstance(caught.exception, SystemExit)
                for name, m in mocks.items():
                    if name == "signal.signal":
                        continue
                    self.assertEqual(m.call_count, 0, f"{name} called before refusal")


class MainConfigTests(unittest.TestCase):
    def setUp(self):
        require(self, "deploy_app", "revert_static")
        self.tmp = DeployUserState(self).root
        environments, settings = {}, {}
        for env, values in deploy.ENVIRONMENTS.items():
            runtime = self.tmp / ("runtime-" + env)
            runtime.mkdir()
            environments[env] = tuple(runtime if isinstance(v, Path) else v for v in values)
            url = next(v for v in values if isinstance(v, str) and v.startswith("https://") and v != deploy.REPOSITORY)
            settings[env] = {"runtime_working_dir": str(runtime), "health_url": url}
        settings["dev"].update(APP_SETTINGS_KEYS)
        settings["dev"]["app_env_file"] = str(write_private(self.tmp / "live" / "app.env", env_text()))
        self.config = {"state_dir": str(self.tmp), "environments": settings}
        for target, value in (("ENVIRONMENTS", environments), ("STATE", self.tmp), ("trusted_file", mock.Mock(side_effect=lambda p: Path(p)))):
            patcher = mock.patch.object(deploy, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def mocks(self):
        mocks = side_effect_mocks(self, ("deploy_app", "revert_static"))
        mocks["read_json"].return_value = json.loads(json.dumps(self.config))
        return mocks

    def test_dev_app_settings_are_accepted_and_app_commands_dispatch_to_the_app_functions(self):
        mocks = self.mocks()
        run_main(self, "dev", "probe dev")
        mocks = self.mocks()
        run_main(self, "dev", f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}")
        mocks["deploy_app"].assert_called_once()
        self.assertEqual(mocks["deploy_app"].call_args.args[:4], (SHA, TREE, MANIFEST, CONFIG))
        mocks["deploy"].assert_not_called()
        mocks = self.mocks()
        run_main(self, "dev", "revert-static dev")
        mocks["revert_static"].assert_called_once()
        mocks["deploy"].assert_not_called()
        mocks["deploy_app"].assert_not_called()

    def test_app_keys_in_the_production_entry_are_refused(self):
        for key, value in APP_SETTINGS_KEYS.items():
            with self.subTest(key=key):
                self.config["environments"]["production"] = {**self.config["environments"]["production"], key: value}
                self.mocks()
                with self.assertRaises(ValueError):
                    run_main(self, "production", "probe production")
                del self.config["environments"]["production"][key]


if __name__ == "__main__":
    unittest.main()
