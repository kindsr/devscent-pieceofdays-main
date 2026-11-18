"""운영 앱 승격 RED — scripts/ops/deploy.py production 앱 모드 계약 시험(PLAN_production-app-deployment.md §2~§6).

표준 라이브러리 unittest만 쓴다. 실제 Docker·git·네트워크·SSH·서버·DB·registry를 부르지 않는다.
- 기존 tests/test_deploy_app.py의 가짜 값·고정 자료·AppFlowBase(외부 명령·파일 경계)를 그대로 재사용한다.
- 메인 확정 계약(2026-11-18):
  * 문법 `deploy-app production <main SHA>` → ("deploy-app", "production", sha), `revert-static production` → ("revert-static", "production").
  * 함수 env 인자 기본 "dev": validate_app_env·validate_app_settings·runtime_compose_app·validate_app_record·front_nginx_conf.
    새 흐름 promote_app(sha, settings, dev_settings), 정적 복귀 revert_static(settings, env="production").
  * 운영 settings: dev APP_SETTINGS에서 dev_db → prod_db, + app_pool_max(int 1..5), + approved_migrations(양의 int).
  * 이름: project devscent-pieceofdays-main, front pieceofdays-comingsoon, app pieceofdays-app,
    network pieceofdays-prod-front(internal)·pieceofdays-prod-egress, app_health_url https://pieceofdays.com/try/.
  * 운영 기록 = dev 앱 기록 키 + app_source_sha(dev 기록 키 집합 불변). 이미지 revision은 dev SHA, 기록 sha는 main SHA.
  * registry 조회·pull·앱 재빌드·migration 자동 실행 0. dev-current(app/success·pending 없음·같은 tree)를 준비 때와 전환 직전에 확인.
- 새 공개 API가 없으면 각 시험이 require()/서명 검사에서 명시적으로 실패한다(정상 RED). type/import 오류를 RED로 세지 않는다.
- 값은 모두 시험용 가짜(ci-only-*)다.
"""

import contextlib
import hashlib
import inspect
import io
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_deploy_app as base  # noqa: E402  (기존 고정 자료·흐름 경계 재사용)

ROOT = Path(__file__).resolve().parents[1]
deploy = None

SHA, TREE, OTHER_TREE = base.SHA, base.TREE, base.OTHER_TREE
OLD_SHA, OLD_TREE = base.OLD_SHA, base.OLD_TREE
MANIFEST, CONFIG = base.MANIFEST, base.CONFIG
APP_ENGINE_ID, FRONT_IMAGE, OLD_FRONT_IMAGE = base.APP_ENGINE_ID, base.FRONT_IMAGE, base.OLD_FRONT_IMAGE
DEV_SHA = "abcdef0123456789abcdef0123456789abcdef01"  # 검증된 dev 이미지 revision(main SHA와 다르다)
PROD_ORIGIN = "https://pieceofdays.com"
PROD_PROJECT = "devscent-pieceofdays-main"
PROD_FRONT = "pieceofdays-comingsoon"
PROD_APP = "pieceofdays-app"
PROD_FRONT_NETWORK = "pieceofdays-prod-front"
PROD_EGRESS_NETWORK = "pieceofdays-prod-egress"
PROD_BUCKET = "pieceofdays-photos"
PROD_SESSION_KEY = "ci-only-prod-session-key-1-".ljust(40, "p")
PROD_DB_PASSWORD = "ci-only-prod-db-pass"
PROD_PHOTO_SECRET = "ci-only-prod-photo-secret+/==value"
PROD_SECRETS = (PROD_SESSION_KEY, PROD_DB_PASSWORD, PROD_PHOTO_SECRET, base.GOOGLE_SECRET)
# 기존 dev 바이트(BASE 8b10647에서 계산). dev 응답 계약은 바이트 단위로 유지한다.
DEV_FRONT_NGINX_SHA256 = "de6e6b96e27abd8847b3f5ba4f0399d5648104dbe83ea9ae9eb31741783cf7a6"
DEV_FRONT_RELAY_SHA256 = "4b9fd8605befb89d4485c1dcccc0ebbfde368f326b35629580e876e4af48c854"
DEV_EDGE_FILES_SHA256 = {
    "deploy/nginx/99-pieceofdays-dev.conf": "fc01a7e50a3bb9a11c9bc7ce565c42712badfd753ede12df9e67c7f3c798e6d0",
    "deploy/nginx/snippets/dev-private-photos.conf": "9b9e9495cabd9833f10676c45f39c04e15072f7da49acb2d5df54553e153683c",
}
PROD_SNIPPET = ROOT / "deploy/nginx/snippets/prod-app-locations.conf"
PROD_EDGE = ROOT / "deploy/nginx/99-pieceofdays.conf"
SNIPPET_INCLUDE = "/etc/nginx/conf.d/snippets/prod-app-locations.conf"

PROD_APP_SETTINGS = {
    "app_mode_enabled": True,
    "db_network": "ci-only-db-network",
    "app_health_url": PROD_ORIGIN + "/try/",
    "app_role": "pod_app_prod",
    "db_host": "ci-only-pg18",
    "prod_db": "pod_prod",
    "server_arch": "amd64",
    "front_subnet": "10.231.27.0/24",
    "egress_subnet": "10.231.28.0/24",
    "app_pool_max": 3,
    "approved_migrations": 2,  # base.app_inspect의 pod.migrations.latest "2"와 같다
}


def setUpModule():
    global deploy
    base.setUpModule()
    deploy = base.deploy


def require(test, *names):
    for name in names:
        test.assertTrue(hasattr(deploy, name), f"scripts/ops/deploy.py must define {name} (PLAN_production-app-deployment §2·§3)")


def require_env_param(test, name):
    """기존 함수가 명시적 env 인자(기본 dev)를 받는지 단언한다. 없으면 이 시험만 실패한다(정상 RED)."""
    require(test, name)
    params = inspect.signature(getattr(deploy, name)).parameters
    test.assertIn("env", params, f"{name} must take an explicit env argument (default 'dev') — PLAN_production-app-deployment §3")
    test.assertEqual(params["env"].default, "dev", f"{name}: env defaults to 'dev' so existing dev callers keep their behaviour")


def prod_env_lines(**changes):
    lines = {
        "POD_AUTH_SESSION_SECRETS": json.dumps({"1": PROD_SESSION_KEY}, separators=(",", ":")),
        "POD_AUTH_BASE_URL": PROD_ORIGIN,
        "POD_AUTH_PROVIDERS": "google",
        "POD_AUTH_GOOGLE_CLIENT_ID": "ci-only-prod-google-client",
        "POD_AUTH_GOOGLE_CLIENT_SECRET": base.GOOGLE_SECRET,
        "POD_DATABASE_URL": f"postgres://pod_app_prod:{PROD_DB_PASSWORD}@ci-only-pg18/pod_prod",
        "POD_DATABASE_POOL_MAX": "3",
        "POD_PHOTOS_S3_ENDPOINT": PROD_ORIGIN + "/",
        "POD_PHOTOS_S3_REGION": "ci-only-region-1",
        "POD_PHOTOS_S3_BUCKET": PROD_BUCKET,
        "POD_PHOTOS_S3_ACCESS_KEY_ID": "ci-only-prod-photo-access",
        "POD_PHOTOS_S3_SECRET_ACCESS_KEY": PROD_PHOTO_SECRET,
        "ANTHROPIC_API_KEY": "ci-only-prod-anthropic-key",
        "POD_STORY_WORKER_TOKEN": "fedcba9876543210" * 4,
    }
    for key, value in changes.items():
        if value is None:
            lines.pop(key, None)
        else:
            lines[key] = value
    return lines


def prod_env_text(**changes):
    return "".join(f"{k}={v}\n" for k, v in prod_env_lines(**changes).items())


def prod_settings_for(state, env_file=None):
    settings = {"runtime_working_dir": str(state / "runtime"), "health_url": PROD_ORIGIN + "/", **PROD_APP_SETTINGS}
    settings["app_env_file"] = str(env_file if env_file is not None else state / "live" / "prod-app.env")
    return settings


def assert_no_prod_secret(test, text, label=""):
    for secret in PROD_SECRETS:
        test.assertNotIn(secret, text, f"{label}: secret value leaked")


def sha256_hex(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


# ================================================================= 명령 문법 §2


class ProductionGrammarTests(unittest.TestCase):
    def test_exact_production_promotion_and_static_revert_grammar(self):
        for command, expected in ((f"deploy-app production {SHA}", ("deploy-app", "production", SHA)), ("revert-static production", ("revert-static", "production"))):
            with self.subTest(command=command):
                try:
                    parsed = deploy.parse_app_request(command)
                except ValueError:
                    self.fail(f"parse_app_request must accept {command.split(' ')[0]} production (PLAN_production-app-deployment §2)")
                self.assertEqual(parsed, expected)

    def test_dev_grammar_is_unchanged(self):
        self.assertEqual(
            deploy.parse_app_request(f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}"),
            ("deploy-app", "dev", SHA, TREE, MANIFEST, CONFIG),
        )
        self.assertEqual(deploy.parse_app_request("revert-static dev"), ("revert-static", "dev"))
        self.assertEqual(deploy.parse_request(f"deploy production {SHA}"), ("production", SHA))

    def test_anything_outside_the_exact_production_grammar_is_a_value_error(self):
        for command in (
            "deploy-app production",
            f"deploy-app production {SHA} {TREE}",
            f"deploy-app production {SHA} {TREE} {MANIFEST} {CONFIG}",  # registry/tree 인자는 운영 요청이 아니다
            f"deploy-app production {SHA.upper()}",
            f"deploy-app production {SHA[:39]}",
            f"deploy-app production {SHA}0",
            f" deploy-app production {SHA}",
            f"deploy-app production {SHA}\n",
            f"deploy-app  production {SHA}",
            f"deploy-app\tproduction {SHA}",
            f"deploy-app production {SHA}; id",
            f"deploy-app prod {SHA}",
            f"deploy-app Production {SHA}",
            "revert-static production ",
            "revert-static production now",
            "revert-static prod",
            f"revert-static production {SHA}",
        ):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    deploy.parse_app_request(command)
        for command in (f"deploy-app production {SHA}", "revert-static production"):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    deploy.parse_request(command)


# ================================================================= 운영 settings §3


class ProductionSettingsTests(unittest.TestCase):
    def setUp(self):
        require_env_param(self, "validate_app_settings")
        self.settings = {**PROD_APP_SETTINGS, "app_env_file": "/nonexistent/prod-app.env"}

    def check(self, settings, env="production", enabled=True):
        return deploy.validate_app_settings(settings, enabled, env=env)

    def test_complete_production_settings_are_accepted(self):
        self.assertEqual(self.check(self.settings), self.settings)
        for pool in (1, 2, 3, 4, 5):
            with self.subTest(pool=pool):
                self.check({**self.settings, "app_pool_max": pool})
        disabled = {**self.settings, "app_mode_enabled": False}
        self.check(disabled, enabled=False)
        with self.assertRaises(ValueError):
            self.check(disabled, enabled=True)

    def test_dev_only_or_missing_keys_and_dev_values_are_refused(self):
        cases = {
            "missing prod_db": {k: v for k, v in self.settings.items() if k != "prod_db"},
            "missing app_pool_max": {k: v for k, v in self.settings.items() if k != "app_pool_max"},
            "missing approved_migrations": {k: v for k, v in self.settings.items() if k != "approved_migrations"},
            "dev_db present": {**self.settings, "dev_db": "pod_dev"},
            "dev health url": {**self.settings, "app_health_url": "https://dev.pieceofdays.com/try/"},
            "root health url": {**self.settings, "app_health_url": PROD_ORIGIN + "/"},
            "other arch": {**self.settings, "server_arch": "arm64"},
            "edge db network": {**self.settings, "db_network": "edge"},
            "prod network name as db network": {**self.settings, "db_network": PROD_FRONT_NETWORK},
        }
        for pool in (0, 6, -1, "3", 3.0, True, None):
            cases[f"app_pool_max {pool!r}"] = {**self.settings, "app_pool_max": pool}
        for approved in (0, -1, "2", 2.0, True, None):
            cases[f"approved_migrations {approved!r}"] = {**self.settings, "approved_migrations": approved}
        for label, settings in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    self.check(settings)

    def test_environments_do_not_cross(self):
        dev = {**base.APP_SETTINGS_KEYS, "app_env_file": "/nonexistent/app.env"}
        self.assertEqual(deploy.validate_app_settings(dev, True), dev, "dev default is unchanged")
        self.assertEqual(deploy.validate_app_settings(dev, True, env="dev"), dev)
        for label, settings, env in (("dev settings as production", dev, "production"), ("production settings as dev", self.settings, "dev"), ("unknown env", self.settings, "prod")):
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    deploy.validate_app_settings(settings, True, env=env)


# ================================================================= 운영 env §3·§4


class ProductionAppEnvTests(unittest.TestCase):
    def setUp(self):
        require_env_param(self, "validate_app_env")
        self.settings = {**PROD_APP_SETTINGS, "app_env_file": "/nonexistent/prod-app.env"}

    def check(self, text, settings=None, env="production"):
        return deploy.validate_app_env(text, self.settings if settings is None else settings, env=env)

    def test_production_env_with_photos_pool_and_story_pair_is_accepted(self):
        self.assertEqual(self.check(prod_env_text()), prod_env_lines())
        self.assertEqual(self.check(prod_env_text(ANTHROPIC_API_KEY=None, POD_STORY_WORKER_TOKEN=None)), prod_env_lines(ANTHROPIC_API_KEY=None, POD_STORY_WORKER_TOKEN=None))
        pool2 = {**self.settings, "app_pool_max": 2}
        self.assertEqual(self.check(prod_env_text(POD_DATABASE_POOL_MAX="2"), pool2)["POD_DATABASE_POOL_MAX"], "2")

    def test_production_env_refusals_name_keys_never_values(self):
        cases = {
            "dev origin": prod_env_text(POD_AUTH_BASE_URL="https://dev.pieceofdays.com"),
            "origin slash": prod_env_text(POD_AUTH_BASE_URL=PROD_ORIGIN + "/"),
            "missing pool": prod_env_text(POD_DATABASE_POOL_MAX=None),
            "pool differs from settings": prod_env_text(POD_DATABASE_POOL_MAX="4"),
            "pool non-canonical": prod_env_text(POD_DATABASE_POOL_MAX="03"),
            "dev database": prod_env_text(POD_DATABASE_URL=f"postgres://pod_app_dev:{PROD_DB_PASSWORD}@ci-only-pg18/pod_dev"),
            "dev db name": prod_env_text(POD_DATABASE_URL=f"postgres://pod_app_prod:{PROD_DB_PASSWORD}@ci-only-pg18/pod_dev"),
            "photos missing": "".join(f"{k}={v}\n" for k, v in prod_env_lines().items() if not k.startswith("POD_PHOTOS_")),
            "dev bucket": prod_env_text(POD_PHOTOS_S3_BUCKET="pieceofdays-photos-dev"),
            "other endpoint": prod_env_text(POD_PHOTOS_S3_ENDPOINT="https://ci-only-photos.invalid/"),
            "endpoint without slash": prod_env_text(POD_PHOTOS_S3_ENDPOINT=PROD_ORIGIN),
            "dev relay flag": prod_env_text(POD_PHOTOS_INTERNAL_DEV_HTTP="1"),
            "dev relay endpoint": prod_env_text(POD_PHOTOS_S3_ENDPOINT="http://10.231.27.11:8081/", POD_PHOTOS_INTERNAL_DEV_HTTP="1"),
            "story key alone": prod_env_text(POD_STORY_WORKER_TOKEN=None),
            "fixture": prod_env_text() + "POD_LOCAL_FIXTURE=1\n",
        }
        for label, text in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(ValueError) as caught:
                    self.check(text)
                assert_no_prod_secret(self, str(caught.exception), label)

    def test_environment_cross_use_is_refused_and_dev_default_is_unchanged(self):
        dev_settings = {**base.APP_SETTINGS_KEYS, "app_env_file": "/nonexistent/app.env"}
        self.assertEqual(deploy.validate_app_env(base.env_text(), dev_settings), base.env_lines(), "dev default unchanged")
        self.assertEqual(deploy.validate_app_env(base.env_text(), dev_settings, env="dev"), base.env_lines())
        for label, text, settings, env in (
            ("production env in dev", prod_env_text(), dev_settings, "dev"),
            ("production env with dev default", prod_env_text(), dev_settings, None),
            ("dev env in production", base.env_text(), self.settings, "production"),
            ("production env with dev settings", prod_env_text(), dev_settings, "production"),
            ("unknown env", prod_env_text(), self.settings, "prod"),
        ):
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    if env is None:
                        deploy.validate_app_env(text, settings)
                    else:
                        deploy.validate_app_env(text, settings, env=env)


# ================================================================= 운영 Compose 망·이름 §3


class ProductionComposeTests(unittest.TestCase):
    def setUp(self):
        require_env_param(self, "runtime_compose_app")
        self.settings = {**PROD_APP_SETTINGS, "app_env_file": "/nonexistent/prod-app.env"}
        self.release = SHA + "-" + "e" * 32

    def compose(self, env="production", settings=None):
        return deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, self.release, 1000, 1000, self.settings if settings is None else settings, env=env)

    def test_production_document_uses_the_production_names_and_dedicated_networks(self):
        doc = self.compose()
        self.assertEqual(doc["name"], PROD_PROJECT)
        self.assertEqual(set(doc["services"]), {PROD_FRONT, PROD_APP})
        front, app = doc["services"][PROD_FRONT], doc["services"][PROD_APP]
        self.assertEqual(front["container_name"], PROD_FRONT, "edge upstream name pieceofdays-comingsoon is kept")
        self.assertEqual(app["container_name"], PROD_APP)
        self.assertEqual(front["image"], FRONT_IMAGE)
        self.assertEqual(app["image"], APP_ENGINE_ID)
        self.assertEqual(set(front["networks"]), {"edge", "front"}, "only the front joins edge")
        self.assertEqual(set(app["networks"]), {"front", "db", "egress"}, "app joins front+db+egress, never edge")
        self.assertEqual(front["depends_on"], {PROD_APP: {"condition": "service_started"}})
        for service in (front, app):
            self.assertNotIn("ports", service, "no host port")
            self.assertTrue(service["read_only"])
        self.assertEqual(app["secrets"], [deploy.APP_SECRET_NAME])
        self.assertEqual(app["command"], deploy.APP_COMMAND)
        self.assertEqual(app["cap_drop"], ["ALL"])
        networks = doc["networks"]
        self.assertEqual(networks["edge"], {"name": "edge", "external": True})
        self.assertEqual(networks["front"]["name"], PROD_FRONT_NETWORK)
        self.assertIs(networks["front"]["internal"], True)
        self.assertEqual(networks["front"]["ipam"], {"config": [{"subnet": PROD_APP_SETTINGS["front_subnet"]}]})
        self.assertEqual(networks["egress"]["name"], PROD_EGRESS_NETWORK)
        self.assertNotIn("internal", networks["egress"])
        self.assertEqual(networks["egress"]["ipam"], {"config": [{"subnet": PROD_APP_SETTINGS["egress_subnet"]}]})
        self.assertEqual(networks["db"], {"name": PROD_APP_SETTINGS["db_network"], "external": True})
        self.assertTrue(doc["secrets"][deploy.APP_SECRET_NAME]["file"].endswith("/releases/production/" + self.release + "/app.env"))
        text = json.dumps(doc)
        for dev_name in ("pieceofdays-dev", "pieceofdays-frontend-dev", "pieceofdays-app-dev", "dev-front", "dev-egress", "/releases/dev/"):
            self.assertNotIn(dev_name, text, f"no dev name in the production document: {dev_name}")

    def test_dev_document_is_unchanged_by_the_env_argument(self):
        dev = {**base.APP_SETTINGS_KEYS, "app_env_file": "/nonexistent/app.env"}
        release = SHA + "-" + "f" * 32
        default = deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, release, 1000, 1000, dev)
        self.assertEqual(deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, release, 1000, 1000, dev, env="dev"), default)
        self.assertEqual(default["name"], "pieceofdays-dev")
        self.assertEqual(set(default["services"]), {"pieceofdays-frontend-dev", "pieceofdays-app-dev"})

    def test_production_compose_refuses_dev_settings_and_unknown_env(self):
        dev = {**base.APP_SETTINGS_KEYS, "app_env_file": "/nonexistent/app.env"}
        for label, settings, env in (("dev settings", dev, "production"), ("unknown env", self.settings, "prod")):
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    self.compose(env=env, settings=settings)


# ================================================================= front conf §3·§4, dev 바이트 호환


def nginx_server_blocks(conf):
    return base.server_blocks(conf)


class FrontNginxConfTests(unittest.TestCase):
    def setUp(self):
        require(self, "front_nginx_conf")
        require_env_param(self, "front_nginx_conf")

    def test_dev_bytes_are_unchanged(self):
        self.assertEqual(sha256_hex(deploy.DEV_FRONT_NGINX_CONF), DEV_FRONT_NGINX_SHA256, "dev public80 constant bytes")
        self.assertEqual(sha256_hex(deploy.DEV_FRONT_RELAY_NGINX_CONF), DEV_FRONT_RELAY_SHA256, "dev relay constant bytes")
        self.assertEqual(deploy.front_nginx_conf(), deploy.DEV_FRONT_NGINX_CONF + deploy.DEV_FRONT_RELAY_NGINX_CONF)
        self.assertEqual(deploy.front_nginx_conf(env="dev"), deploy.DEV_FRONT_NGINX_CONF + deploy.DEV_FRONT_RELAY_NGINX_CONF)
        for path, expected in DEV_EDGE_FILES_SHA256.items():
            with self.subTest(path=path):
                self.assertEqual(sha256_hex((ROOT / path).read_bytes()), expected, "dev edge files keep their bytes")

    def test_production_conf_uses_production_host_upstream_and_bucket_only(self):
        conf = deploy.front_nginx_conf(env="production")
        self.assertIsInstance(conf, str)
        for dev_value in ("dev.pieceofdays.com", "pieceofdays-app-dev", "pieceofdays-photos-dev", "pieceofdays-frontend-dev"):
            self.assertNotIn(dev_value, conf, f"no dev value in the production front conf: {dev_value}")
        self.assertIn("proxy_set_header Host pieceofdays.com;", conf)
        self.assertIn("proxy_set_header X-Forwarded-Host pieceofdays.com;", conf)
        self.assertIn("proxy_set_header X-Forwarded-Proto https;", conf)
        self.assertEqual(sorted(set(re.findall(r"proxy_pass (http://[^;]+);", conf))), ["http://pieceofdays-app:3000"], "only the production app upstream on public80")
        public80, relay = nginx_server_blocks(conf)
        self.assertIn("listen 80;", public80)
        self.assertIn("listen 8081;", relay)
        # callbacks: Google·Kakao 기존 문법 유지, 로그 off
        for provider in ("google", "kakao"):
            self.assertRegex(public80, r"location = /auth/%s/callback \{ access_log off; error_log /dev/null crit; proxy_pass http://pieceofdays-app:3000; \}" % provider)
        self.assertRegex(public80, r"location = /photos/upload \{ client_max_body_size 9m; access_log off; error_log /dev/null crit;")
        self.assertRegex(public80, r"location \^~ /photos/ \{ access_log off; error_log /dev/null crit;")
        self.assertIn("location / { return 404; }", public80)
        self.assertNotIn("/internal", public80, "the internal story worker is never proxied")
        self.assertNotIn("healthz", public80)
        # relay: 운영 버킷만, 메서드별 x-id, 나머지 403, 로그 off, 5m
        self.assertIn("/pieceofdays-photos/photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg", relay)
        for method, op in (("(?:GET|HEAD)", "GetObject"), ("PUT", "PutObject"), ("DELETE", "DeleteObject")):
            self.assertIn(f"{method} /pieceofdays-photos/photos/", relay)
            self.assertIn(f"x-id={op}", relay)
        self.assertIn("return 403;", relay)
        self.assertIn("access_log off;", relay)
        self.assertIn("error_log /dev/null crit;", relay)
        self.assertIn("client_max_body_size 5m;", relay)
        self.assertIn("proxy_set_header Host $http_host;", relay)
        self.assertNotRegex(relay, r"add_header|proxy_hide_header")

    def test_unknown_env_is_refused(self):
        with self.assertRaises(ValueError):
            deploy.front_nginx_conf(env="prod")


# ================================================================= 운영 edge snippet §4 (메인 확정 2026-11-18)


def location_blocks(text):
    return [(m.group(1), m.group(2), m.group(3)) for m in re.finditer(r"location\s+(=|\^~)\s+(\S+)\s*\{([^{}]*)\}", text)]


ADD_HEADERS = {
    "X-Robots-Tag": '"noindex, nofollow"',
    "X-Frame-Options": '"SAMEORIGIN"',
    "X-Content-Type-Options": '"nosniff"',
    "Strict-Transport-Security": '"max-age=31536000"',
}


def add_headers(text):
    return [(m.group(1), m.group(2).strip()) for m in re.finditer(r"\badd_header\s+(\S+)\s+([^;]+);", text)]


class ProductionEdgeSnippetTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PROD_SNIPPET.is_file() and not PROD_SNIPPET.is_symlink(), "deploy/nginx/snippets/prod-app-locations.conf must exist as a regular file")
        # 주석은 판정에서 뺀다(설명 문구의 단어를 지시문으로 오인하지 않는다).
        self.snippet = "\n".join(line for line in PROD_SNIPPET.read_text().splitlines() if not line.lstrip().startswith("#"))
        self.locations = location_blocks(self.snippet)

    def location(self, kind, path):
        found = [body for k, p, body in self.locations if (k, p) == (kind, path)]
        self.assertEqual(len(found), 1, f"exactly one location {kind} {path}")
        return found[0]

    def test_exact_location_set(self):
        self.assertEqual(
            sorted((k, p) for k, p, _ in self.locations),
            sorted([("=", "/auth/google/callback"), ("=", "/auth/kakao/callback"), ("=", "/photos/upload"), ("^~", "/photos/"), ("^~", "/pieceofdays-photos/")]),
        )
        self.assertEqual(len(re.findall(r"\blocation\s", self.snippet)), 5, "no other edge routes")
        self.assertNotRegex(self.snippet, r"\b(server|listen|server_name|ssl_certificate|resolver|auth_basic|allow|deny|satisfy|return|rewrite)\s", "a location snippet only, no server/TLS/access changes")
        self.assertEqual(set(re.findall(r"\$pieceofdays_[a-z_]+", self.snippet)), {"$pieceofdays_comingsoon", "$pieceofdays_photos_relay"}, "only the existing app upstream and the new relay variable")

    def test_server_context_declares_the_five_security_headers_once_before_locations(self):
        head = self.snippet[: self.snippet.index("location ")]
        expected = sorted([*ADD_HEADERS.items(), ("Referrer-Policy", '"strict-origin-when-cross-origin"')])
        self.assertEqual(sorted((n, v.removesuffix(" always").strip()) for n, v in add_headers(head)), expected)
        for name, value in add_headers(head):
            self.assertTrue(value.endswith(" always"), f"server {name} uses always")
        self.assertNotRegex(head, r"proxy_hide_header")

    def test_callbacks_redeclare_all_five_with_no_referrer_and_log_nothing(self):
        expected = sorted([*ADD_HEADERS.items(), ("Referrer-Policy", '"no-referrer"')])
        for provider in ("google", "kakao"):
            with self.subTest(provider=provider):
                body = self.location("=", f"/auth/{provider}/callback")
                self.assertEqual(sorted((n, v.removesuffix(" always").strip()) for n, v in add_headers(body)), expected)
                for name, value in add_headers(body):
                    self.assertTrue(value.endswith(" always"), f"callback {name} uses always")
                self.assertRegex(body, r"\baccess_log\s+off\s*;")
                self.assertRegex(body, r"\berror_log\s+/dev/null\s+crit\s*;")
                self.assertEqual(re.findall(r"proxy_pass\s+([^;]+);", body), ["$pieceofdays_comingsoon"])
                self.assertNotRegex(body, r"proxy_hide_header", "the five ancestor hides are inherited")

    def test_photo_app_locations_and_relay_inherit_server_headers(self):
        for kind, path, size, upstream in (("=", "/photos/upload", "9m", "$pieceofdays_comingsoon"), ("^~", "/photos/", "1m", "$pieceofdays_comingsoon"), ("^~", "/pieceofdays-photos/", "5m", "$pieceofdays_photos_relay")):
            with self.subTest(path=path):
                body = self.location(kind, path)
                self.assertEqual(re.findall(r"client_max_body_size\s+([^;]+);", body), [size])
                self.assertRegex(body, r"\baccess_log\s+off\s*;")
                self.assertRegex(body, r"\berror_log\s+/dev/null\s+crit\s*;")
                self.assertEqual(re.findall(r"proxy_pass\s+([^;]+);", body), [upstream], "variable proxy_pass without a URI part")
                self.assertNotRegex(body, r"\b(add_header|proxy_hide_header)\s", "no local add/hide: server headers and ancestor hides stay single-valued")
        relay = self.location("^~", "/pieceofdays-photos/")
        self.assertRegex(relay, r"\bproxy_buffering\s+off\s*;")
        self.assertRegex(relay, r"\bproxy_request_buffering\s+off\s*;")
        self.assertRegex(relay, r"\bproxy_set_header\s+Host\s+\$http_host\s*;", "original Host reaches storage (SigV4)")

    def test_edge_https_server_sets_the_relay_and_includes_the_snippet_once(self):
        conf = PROD_EDGE.read_text()
        servers = [m for m in re.finditer(r"server\s*\{", conf)]
        https_canonical = [s for s in re.split(r"\n(?=server\s*\{)", conf) if "listen 443 ssl;" in s and re.search(r"server_name\s+pieceofdays\.com\s*;", s)]
        self.assertEqual(len(https_canonical), 1, "one canonical HTTPS server")
        server = https_canonical[0]
        self.assertIn("set $pieceofdays_photos_relay http://pieceofdays-comingsoon:8081;", server)
        self.assertEqual(re.findall(r"include\s+([^;]+);", server), [SNIPPET_INCLUDE])
        self.assertEqual(conf.count("prod-app-locations.conf"), 1, "included only in the canonical HTTPS server")
        self.assertIn("set $pieceofdays_comingsoon http://pieceofdays-comingsoon:80;", server, "existing upstream variable kept")
        self.assertGreaterEqual(len(servers), 4, "HTTP redirect / www / co.kr servers are kept")
        self.assertIn("return 301 https://pieceofdays.com$request_uri;", conf)


# ================================================================= 흐름: promote_app §2·§5


class PromoteFlowBase(base.AppFlowBase):
    def setUp(self):
        require(self, "promote_app", "front_nginx_conf")
        real_validate_app_record = deploy.validate_app_record
        super().setUp()
        # dev·운영 기록은 실제 검사기로 본다(기록 파일·compose·env를 실제로 쓴다). 외부 명령만 가짜다.
        for name, value in (("validate_app_record", real_validate_app_record), ("verify_app_release", mock.Mock(side_effect=self.fake_verify_any))):
            patcher = mock.patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.mocks["verify_app_release"] = deploy.verify_app_release
        self.dev_settings = self.settings
        self.prod_settings = prod_settings_for(self.state)
        self.prod_settings["runtime_working_dir"] = str(self.state / "runtime")
        base.write_private(Path(self.prod_settings["app_env_file"]), prod_env_text())
        self.prod_current = self.state / "production-current.json"
        self.prod_pending = self.state / "production-pending.json"
        self.prod_static_last = self.state / "production-static-last.json"
        self.image_sha = DEV_SHA
        self.image_tree = TREE
        self.image_migrations = "2"
        self.front_builds = []
        self.after_build = None
        # 검증된 dev 앱 기록(같은 tree, 이미지 revision DEV_SHA)
        self.dev_record = self.app_record(sha=DEV_SHA, tree=TREE, release=DEV_SHA + "-" + "a" * 32, manifest=MANIFEST, config=CONFIG, app_id=APP_ENGINE_ID, front=OLD_FRONT_IMAGE)
        self.write_json(self.current, self.dev_record)
        self.dev_static = self.static_record()
        self.write_json(self.static_last, self.dev_static)
        self.prod_static = self.prod_static_record()
        self.write_json(self.prod_current, self.prod_static)

    def prod_static_record(self, sha=OLD_SHA, tree=OLD_TREE, image=OLD_FRONT_IMAGE):
        compose_path = self.state / "releases" / "production" / (sha + "-" + "2" * 32) / "compose.json"
        base.write_private(compose_path, json.dumps(deploy.runtime_compose("production", image)), 0o600)
        return {
            "status": "success", "sha": sha, "tree": tree, "image_id": image,
            "serving_html_sha256": sha256_hex(b"<!doctype html><title>coming soon</title>\n"),
            "compose_path": str(compose_path), "compose_sha256": sha256_hex(compose_path.read_bytes()),
            "timestamp": "2026-11-04T00:00:00+00:00",
        }

    def _answer(self, args):
        if os.path.basename(args[0]) == "docker" and len(args) > 1 and args[1] == "build":
            context = Path(args[-1])
            conf = context / "default.conf"
            self.front_builds.append({"conf": conf.read_text() if conf.is_file() else None, "try": (context / "public" / "try" / "index.html").is_file(), "args": list(args)})
            if self.after_build:
                self.after_build()
            return ""
        joined = " ".join(args)
        if os.path.basename(args[0]) == "docker" and "{{json .}}" in joined and (APP_ENGINE_ID in joined or base.APP_REPO in joined):
            info = base.app_inspect(sha=self.image_sha, tree=self.image_tree, manifest=MANIFEST, engine_id=APP_ENGINE_ID)
            info["Config"]["Labels"]["pod.migrations.latest"] = self.image_migrations
            return info
        return super()._answer(args)

    def fake_verify_any(self, record, *args, **kwargs):
        self.events.append(("verify-app", record.get("release_id"), self.read_json(self.prod_current), self.prod_pending.exists()))
        is_new = record.get("sha") == SHA and record.get("app_source_sha") == DEV_SHA and record.get("release_id") != getattr(self, "_preexisting_release", None)
        if ("new-app" if is_new else "prev-app") in self.fail_verify:
            raise RuntimeError("verification failed")

    def promote(self):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                deploy.promote_app(SHA, self.prod_settings, self.dev_settings)
            finally:
                self.stdout, self.stderr = out.getvalue(), err.getvalue()

    def prod_release_dirs(self):
        root = self.state / "releases" / "production"
        return sorted(p.name for p in root.iterdir() if p.is_dir() and base.RELEASE_RE.fullmatch(p.name) and p.name.startswith(SHA + "-")) if root.exists() else []

    def compose_runs(self):
        return [a for a in self.runs if "compose" in a and "up" in a]

    def dev_snapshot(self):
        return {p.name: p.read_bytes() for p in (self.current, self.static_last, self.pending) if p.exists()}

    def assert_no_prod_switch(self, before):
        self.assertEqual(self.compose_runs(), [], "no compose up")
        self.assertFalse(self.prod_pending.exists(), "no production pending")
        self.assertEqual(self.read_json(self.prod_current), before, "production current unchanged")

    def assert_no_registry_or_rebuild(self):
        for args in self.runs:
            core, config = self.docker_core(args) if os.path.basename(args[0]) == "docker" else (args, None)
            self.assertIsNone(config, "no registry docker config")
            if os.path.basename(core[0]) == "docker":
                self.assertNotIn(core[1:3], (["manifest", "inspect"],), "no registry manifest lookup")
                self.assertNotIn(core[1], ("pull", "push", "login"), "no registry pull/push/login")
            self.assertFalse(any("migrate" in a for a in core), "no automatic migration")
        builds = [a for a in self.runs if os.path.basename(a[0]) == "docker" and a[1] == "build"]
        self.assertLessEqual(len(builds), 1, "only the production front image is built")
        for build in builds:
            self.assertFalse(any(base.APP_REPO in a for a in build), "the app image is never rebuilt")


class PromoteAppTransitionTests(PromoteFlowBase):
    def test_first_promotion_from_static_records_exact_fields_after_verification(self):
        dev_before = self.dev_snapshot()
        self.promote()
        record = self.read_json(self.prod_current)
        self.assertEqual(set(record), set(deploy.APP_RECORD_KEYS) | {"app_source_sha"}, "production record = dev app record keys + app_source_sha")
        self.assertEqual(record["mode"], "app")
        self.assertEqual(record["status"], "success")
        self.assertEqual(record["sha"], SHA, "production SHA is the main SHA")
        self.assertEqual(record["tree"], TREE)
        self.assertEqual(record["app_source_sha"], DEV_SHA, "the image revision is the validated dev SHA")
        self.assertEqual(record["app_image_id"], self.dev_record["app_image_id"], "the exact dev local image ID is reused")
        self.assertEqual(record["app_manifest_digest"], self.dev_record["app_manifest_digest"])
        self.assertEqual(record["app_config_digest"], self.dev_record["app_config_digest"])
        self.assertEqual(record["front_image_id"], FRONT_IMAGE, "a new production front image")
        self.assertTrue(record["release_id"].startswith(SHA + "-"))
        self.assertEqual(self.prod_release_dirs(), [record["release_id"]])
        release = self.state / "releases" / "production" / record["release_id"]
        self.assertEqual((release / "app.env").read_bytes(), prod_env_text().encode(), "live production env frozen verbatim")
        self.assertEqual(record["env_sha256"], sha256_hex(prod_env_text()))
        compose = json.loads((release / "compose.json").read_text())
        self.assertEqual(compose, deploy.runtime_compose_app(FRONT_IMAGE, APP_ENGINE_ID, record["release_id"], self.user.uid, self.user.gid, self.prod_settings, env="production"))
        self.assertFalse(self.prod_pending.exists())
        self.assertEqual(self.read_json(self.prod_static_last), self.prod_static, "the static production record is frozen as static-last before the first switch")
        self.assertEqual(self.dev_snapshot(), dev_before, "dev records are untouched")
        self.assertNotIn(self.state / "releases" / "dev" / record["release_id"], list((self.state / "releases" / "dev").iterdir()))
        self.assert_no_registry_or_rebuild()
        # 전환 명령: 운영 project, 로컬 이미지만, 남은 정적 서비스 제거
        ups = self.compose_runs()
        self.assertEqual(len(ups), 1)
        up = ups[0]
        self.assertEqual(up[up.index("-p") + 1], PROD_PROJECT)
        for flag in ("--no-build", "--remove-orphans"):
            self.assertIn(flag, up)
        self.assertEqual(up[up.index("--pull") + 1], "never")
        self.assertEqual(up[up.index("-f") + 1], str(release / "compose.json"))
        self.assertEqual(self.events[-1][0], "verify-app")
        self.assertEqual(self.events[-1][3], True, "verified while pending exists (before the success record)")
        self.mocks["assert_latest"].assert_any_call("production", SHA)
        self.assertTrue(all(c.args[0] == "production" for c in self.mocks["assert_latest"].call_args_list), "only the main branch is checked")
        self.mocks["sync_dev_clone"].assert_not_called()
        self.assertIn(f"production app {SHA}", self.stdout)
        for text in (self.stdout, self.stderr):
            assert_no_prod_secret(self, text, "output")

    def test_front_image_is_built_from_the_promoted_source_with_the_production_conf(self):
        self.promote()
        self.assertEqual(len(self.front_builds), 1)
        build = self.front_builds[0]
        self.assertEqual(build["conf"], deploy.front_nginx_conf(env="production"), "production front conf baked into the image")
        self.assertTrue(build["try"], "same source tree static files")
        self.assertIn("--network=none", build["args"])
        self.assertEqual(sum(1 for a in self.runs if "clone" in a), 1)
        clone = next(a for a in self.runs if "clone" in a)
        self.assertEqual(clone[clone.index("--branch") + 1], "main", "a clean clone of main")

    def test_verification_failure_restores_the_static_production_record(self):
        self.fail_verify.add("new-app")
        with self.assertRaises(RuntimeError):
            self.promote()
        self.assertEqual(self.read_json(self.prod_current), self.prod_static)
        self.assertFalse(self.prod_pending.exists())
        ups = self.compose_runs()
        self.assertEqual(len(ups), 2, "switch then restore")
        restore = ups[1]
        self.assertEqual(restore[restore.index("-p") + 1], PROD_PROJECT)
        self.assertEqual(restore[restore.index("-f") + 1], self.prod_static["compose_path"], "frozen static compose")
        self.assertIn("--remove-orphans", restore, "the new app container is removed")
        self.assertEqual(self.mocks["verify_release"].call_args.args[:2], (self.prod_static, "production"))

    def test_failed_restore_keeps_pending_and_is_not_success(self):
        self.fail_verify.update({"new-app", "static"})
        with self.assertRaises(Exception):
            self.promote()
        self.assertTrue(self.prod_pending.exists(), "pending is preserved when the restore cannot be verified")
        self.assertNotEqual((self.read_json(self.prod_current) or {}).get("sha"), SHA)

    def test_idempotent_request_only_verifies(self):
        self.promote()
        first = self.read_json(self.prod_current)
        self._preexisting_release = first["release_id"]
        self.runs.clear()
        self.events.clear()
        self.front_builds.clear()
        self.promote()
        self.assertEqual(self.compose_runs(), [])
        self.assertEqual(self.front_builds, [])
        self.assertEqual(self.read_json(self.prod_current)["release_id"], first["release_id"])
        self.assertEqual([e[0] for e in self.events], ["verify-app"])

    def test_interrupted_production_pending_is_recovered_first(self):
        self.write_json(self.prod_pending, self.prod_static)
        self.write_json(self.prod_current, {"status": "broken"})
        self.fail_verify.add("new-app")
        with self.assertRaises(RuntimeError):
            self.promote()
        ups = self.compose_runs()
        self.assertGreaterEqual(len(ups), 1)
        self.assertEqual(ups[0][ups[0].index("-f") + 1], self.prod_static["compose_path"], "pending is restored before anything else")


class PromoteAppRefusalTests(PromoteFlowBase):
    def refused(self, exc=Exception):
        before = self.read_json(self.prod_current)
        dev_before = self.dev_snapshot()
        with self.assertRaises(exc):
            self.promote()
        self.assert_no_prod_switch(before)
        self.assertEqual(self.prod_release_dirs(), [], "no production release directory")
        self.assertEqual(self.dev_snapshot(), dev_before)
        self.assertFalse(self.prod_static_last.exists(), "static-last is frozen only right before a real switch")
        for text in (self.stdout, self.stderr):
            assert_no_prod_secret(self, text, "output")

    def test_dev_basis_must_be_a_successful_app_record_of_the_same_tree_without_pending(self):
        cases = {
            "dev static": lambda: self.write_json(self.current, self.dev_static),
            "dev failed": lambda: self.write_json(self.current, {**self.dev_record, "status": "failed"}),
            "dev other tree": lambda: self.write_json(self.current, self.app_record(sha=DEV_SHA, tree=OTHER_TREE, release=DEV_SHA + "-" + "b" * 32, manifest=MANIFEST, config=CONFIG, app_id=APP_ENGINE_ID, front=OLD_FRONT_IMAGE)),
            "dev pending": lambda: self.write_json(self.pending, self.dev_static),
            "dev record with production key": lambda: self.write_json(self.current, {**self.dev_record, "app_source_sha": DEV_SHA}),
        }
        for label, prepare in cases.items():
            with self.subTest(case=label):
                self.setUp()
                prepare()
                self.refused(ValueError)
        with self.subTest(case="dev record missing"):
            self.setUp()
            self.current.unlink()
            self.refused(Exception)  # 없는 기록 파일은 OSError일 수 있다. 판정은 전환·기록 0이다.

    def test_dev_basis_is_rechecked_right_before_the_switch(self):
        other = self.app_record(sha=DEV_SHA, tree=OTHER_TREE, release=DEV_SHA + "-" + "c" * 32, manifest=MANIFEST, config=CONFIG, app_id=APP_ENGINE_ID, front=OLD_FRONT_IMAGE)
        self.after_build = lambda: self.write_json(self.current, other)
        self.refused(ValueError)

    def test_image_revision_tree_and_migration_fences(self):
        cases = {
            "image revision is the main SHA, not the dev SHA": ("image_sha", SHA),
            "image tree label differs": ("image_tree", OTHER_TREE),
            "migration above approved": ("image_migrations", "3"),
        }
        for label, (attr, value) in cases.items():
            with self.subTest(case=label):
                self.setUp()
                setattr(self, attr, value)
                self.refused(ValueError)

    def test_promoted_tree_must_equal_the_dev_tree(self):
        self.tree_answer = OTHER_TREE
        self.refused(ValueError)

    def test_disabled_app_mode_or_invalid_live_env_is_refused(self):
        cases = {
            "disabled": lambda: self.prod_settings.update(app_mode_enabled=False),
            "dev origin env": lambda: base.write_private(Path(self.prod_settings["app_env_file"]), prod_env_text(POD_AUTH_BASE_URL="https://dev.pieceofdays.com")),
            "dev relay env": lambda: base.write_private(Path(self.prod_settings["app_env_file"]), prod_env_text(POD_PHOTOS_INTERNAL_DEV_HTTP="1")),
            "pool mismatch": lambda: base.write_private(Path(self.prod_settings["app_env_file"]), prod_env_text(POD_DATABASE_POOL_MAX="5")),
            "dev settings as production": lambda: setattr(self, "prod_settings", {**self.dev_settings}),
        }
        for label, prepare in cases.items():
            with self.subTest(case=label):
                self.setUp()
                prepare()
                self.refused(ValueError)


class ProductionRecordTests(PromoteFlowBase):
    def test_production_record_shape_requires_app_source_sha_and_dev_shape_is_unchanged(self):
        require_env_param(self, "validate_app_record")
        self.promote()
        record = self.read_json(self.prod_current)
        self.assertEqual(deploy.validate_app_record(record, self.prod_settings, env="production"), record)
        for label, broken in (
            ("missing app_source_sha", {k: v for k, v in record.items() if k != "app_source_sha"}),
            ("non-hex app_source_sha", {**record, "app_source_sha": "z" * 40}),
            ("extra key", {**record, "extra": "x"}),
        ):
            with self.subTest(case=label):
                with self.assertRaises(ValueError):
                    deploy.validate_app_record(broken, self.prod_settings, env="production")
        with self.assertRaises(ValueError):
            deploy.validate_app_record(record, self.dev_settings)
        with self.assertRaises(ValueError):
            deploy.validate_app_record(self.dev_record, self.prod_settings, env="production")
        self.assertEqual(deploy.validate_app_record(self.dev_record, self.dev_settings), self.dev_record, "dev record keys unchanged")


class ProductionRevertAndStaticTests(PromoteFlowBase):
    def revert(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            deploy.revert_static(self.prod_settings, env="production")

    def test_revert_static_production_restores_the_frozen_static_record(self):
        require_env_param(self, "revert_static")
        self.promote()
        app = self.read_json(self.prod_current)
        self.runs.clear()
        self.prod_settings["app_mode_enabled"] = False  # 수동 복귀는 enable=false 뒤
        self.revert()
        self.assertEqual(self.read_json(self.prod_current), self.prod_static)
        self.assertFalse(self.prod_pending.exists())
        up = self.compose_runs()[-1]
        self.assertEqual(up[up.index("-p") + 1], PROD_PROJECT)
        self.assertEqual(up[up.index("-f") + 1], self.prod_static["compose_path"])
        self.assertIn("--remove-orphans", up)
        self.assertTrue((self.state / "releases" / "production" / app["release_id"]).is_dir(), "app release files are kept")
        self.assertEqual(self.read_json(self.current), self.dev_record, "dev untouched")

    def test_revert_static_production_without_static_last_is_refused(self):
        require_env_param(self, "revert_static")
        before = self.read_json(self.prod_current)
        with self.assertRaises(ValueError):
            self.revert()
        self.assert_no_prod_switch(before)

    def test_dev_revert_default_is_unchanged(self):
        require_env_param(self, "revert_static")
        self.assertEqual(inspect.signature(deploy.revert_static).parameters["env"].default, "dev")

    def test_static_production_deploy_is_refused_while_production_is_in_app_mode(self):
        self.promote()
        before = self.read_json(self.prod_current)
        self.runs.clear()
        with self.assertRaises(ValueError):
            with contextlib.redirect_stdout(io.StringIO()):
                deploy.deploy("production", OLD_SHA, self.prod_settings)
        self.assert_no_prod_switch(before)
        self.assertEqual(self.runs, [], "refused before any candidate, clone or build (like dev app mode)")


# ================================================================= main: 키·설정 경계


class MainProductionTests(unittest.TestCase):
    def setUp(self):
        require(self, "promote_app", "deploy_app", "revert_static")
        self.tmp = base.DeployUserState(self).root
        environments, settings = {}, {}
        for env, values in deploy.ENVIRONMENTS.items():
            runtime = self.tmp / ("runtime-" + env)
            runtime.mkdir()
            environments[env] = tuple(runtime if isinstance(v, Path) else v for v in values)
            url = next(v for v in values if isinstance(v, str) and v.startswith("https://") and v != deploy.REPOSITORY)
            settings[env] = {"runtime_working_dir": str(runtime), "health_url": url}
        settings["dev"].update(base.APP_SETTINGS_KEYS)
        settings["dev"]["app_env_file"] = str(base.write_private(self.tmp / "live" / "app.env", base.env_text()))
        settings["production"].update(PROD_APP_SETTINGS)
        settings["production"]["app_env_file"] = str(base.write_private(self.tmp / "live" / "prod-app.env", prod_env_text()))
        self.config = {"state_dir": str(self.tmp), "environments": settings}
        for target, value in (("ENVIRONMENTS", environments), ("STATE", self.tmp), ("trusted_file", mock.Mock(side_effect=lambda p: Path(p)))):
            patcher = mock.patch.object(deploy, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def mocks(self):
        mocks = base.side_effect_mocks(self, ("deploy_app", "revert_static", "promote_app"))
        mocks["read_json"].return_value = json.loads(json.dumps(self.config))
        return mocks

    def test_production_key_dispatches_promotion_and_static_revert(self):
        self.mocks()
        base.run_main(self, "production", "probe production")
        mocks = self.mocks()
        base.run_main(self, "production", f"deploy-app production {SHA}")
        mocks["promote_app"].assert_called_once()
        args = mocks["promote_app"].call_args.args
        self.assertEqual(args[0], SHA)
        self.assertEqual(args[1], self.config["environments"]["production"])
        self.assertEqual(args[2], self.config["environments"]["dev"], "the dev settings are passed as the promotion basis")
        mocks["deploy"].assert_not_called()
        mocks["deploy_app"].assert_not_called()
        mocks = self.mocks()
        base.run_main(self, "production", "revert-static production")
        mocks["revert_static"].assert_called_once()
        call = mocks["revert_static"].call_args
        env = call.kwargs["env"] if "env" in call.kwargs else (call.args[1] if len(call.args) > 1 else None)
        self.assertEqual(env, "production")
        self.assertEqual(call.args[0], self.config["environments"]["production"])
        mocks["promote_app"].assert_not_called()

    def test_static_production_settings_without_app_keys_still_probe(self):
        for key in list(PROD_APP_SETTINGS) + ["app_env_file"]:
            del self.config["environments"]["production"][key]
        self.mocks()
        base.run_main(self, "production", "probe production")

    def test_cross_environment_commands_are_refused_before_config_or_docker(self):
        for allowed, command in (
            ("dev", f"deploy-app production {SHA}"),
            ("dev", "revert-static production"),
            ("production", f"deploy-app dev {SHA} {TREE} {MANIFEST} {CONFIG}"),
            ("production", "revert-static dev"),
            ("production", f"deploy-app production {SHA} {TREE} {MANIFEST} {CONFIG}"),
        ):
            with self.subTest(allowed=allowed, command=command):
                mocks = base.side_effect_mocks(self, ("deploy_app", "revert_static", "promote_app"))
                with self.assertRaises(Exception) as caught:
                    base.run_main(self, allowed, command)
                self.assertNotIsInstance(caught.exception, SystemExit)
                for name, m in mocks.items():
                    if name == "signal.signal":
                        continue
                    self.assertEqual(m.call_count, 0, f"{name} called before refusal")

    def test_environment_specific_keys_do_not_cross(self):
        for env, key, value in (("production", "dev_db", "pod_dev"), ("dev", "prod_db", "pod_prod"), ("dev", "app_pool_max", 3), ("dev", "approved_migrations", 2)):
            with self.subTest(env=env, key=key):
                saved = json.loads(json.dumps(self.config))
                self.config["environments"][env][key] = value
                self.mocks()
                with self.assertRaises(ValueError):
                    base.run_main(self, env, "probe " + env)
                self.config = saved


if __name__ == "__main__":
    unittest.main()
