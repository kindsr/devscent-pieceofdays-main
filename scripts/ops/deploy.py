#!/usr/bin/env python3
"""Reviewed forced-command helper, installed outside the repository."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat as statmod
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

REPOSITORY = "https://github.com/kindsr/devscent-pieceofdays-main.git"
HOME = Path(pwd.getpwuid(os.getuid()).pw_dir)
STATE = HOME / "deployment/devscent-pieceofdays-main"
ENVIRONMENTS = {
    "dev": ("dev", "pieceofdays-dev", "pieceofdays-frontend-dev", "docker-compose.dev.yml", "frontend", "public", HOME / "development/devscent-pieceofdays-main", "https://dev.pieceofdays.com/"),
    "production": ("main", "devscent-pieceofdays-main", "pieceofdays-comingsoon", "docker-compose.yml", "deploy/comingsoon", "html", STATE, "https://pieceofdays.com/"),
}
HEALTH = {"test": ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:80/ || exit 1"], "interval": "30s", "timeout": "5s", "retries": 3}
SAFE_ENV = {"PATH": "/usr/bin:/bin", "HOME": str(HOME), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "DOCKER_CONFIG": str(STATE / "docker-config")}
PHASE = "request"

# --- dev app mode (F6b). Only the dev environment can use these; production stays static. ---
APP_IMAGE_REPOSITORY = "ghcr.io/kindsr/devscent-pieceofdays-main-app"
APP_SOURCE_URL = "https://github.com/kindsr/devscent-pieceofdays-main"
DOCKER = "/usr/bin/docker"
DEV_PROJECT = "pieceofdays-dev"
FRONT_SERVICE = "pieceofdays-frontend-dev"
APP_SERVICE = "pieceofdays-app-dev"
FRONT_NETWORK = "pieceofdays-dev-front"
EGRESS_NETWORK = "pieceofdays-dev-egress"
DEV_ORIGIN = "https://dev.pieceofdays.com"
APP_HEALTH_URL = DEV_ORIGIN + "/try/"
APP_LOGIN_URL = DEV_ORIGIN + "/login"
# Official nginx stable-alpine, linux/amd64 image digest (front image base, generated Dockerfile only).
FRONT_NGINX_BASE = "nginx:stable-alpine@sha256:84ed8c0dd296c188bfc24ed506f46589e9285fb0b11cf3a04d91d524d3067e11"
APP_SECRET_NAME = "pod_app_env"
APP_COMMAND = ["--env-file=/run/secrets/" + APP_SECRET_NAME, "runtime-startup.mjs"]
APP_LIVENESS_JS = "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
APP_READY_JS = "fetch('http://127.0.0.1:3000/healthz/ready').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"
APP_HEALTH = {"test": ["CMD", "node", "-e", APP_LIVENESS_JS], "interval": "30s", "timeout": "5s", "retries": 3, "start_period": "20s"}
FRONT_TRY_CHECK = "wget -q -O /dev/null http://127.0.0.1:80/try/ || exit 1"
FRONT_HEALTH = {"test": ["CMD-SHELL", FRONT_TRY_CHECK], "interval": "30s", "timeout": "5s", "retries": 3}
FRONT_TMPFS = ["/var/cache/nginx", "/var/run"]
DIGEST_RE = r"sha256:[0-9a-f]{64}"
RELEASE_RE = r"[0-9a-f]{40}-[0-9a-f]{32}"
APP_RECORD_KEYS = frozenset({"mode", "status", "sha", "tree", "release_id", "front_image_id", "app_image_id", "app_manifest_digest", "app_config_digest", "try_html_sha256", "compose_sha256", "env_sha256", "timestamp"})
STATIC_SETTINGS = frozenset({"runtime_working_dir", "bootstrap_record", "health_url", "health_headers_file"})
APP_SETTINGS = frozenset({"app_mode_enabled", "app_env_file", "db_network", "app_health_url", "app_role", "db_host", "dev_db", "server_arch", "front_subnet", "egress_subnet"})
APP_ENV_REQUIRED = ("POD_AUTH_SESSION_SECRETS", "POD_AUTH_BASE_URL", "POD_AUTH_PROVIDERS", "POD_DATABASE_URL")
APP_ENV_PROVIDERS = ("google", "kakao")
APP_ENV_KEYS = frozenset(APP_ENV_REQUIRED + ("POD_WITHDRAWAL_ENABLED",) + tuple("POD_AUTH_%s_CLIENT_%s" % (p.upper(), part) for p in APP_ENV_PROVIDERS for part in ("ID", "SECRET")))
APP_ENV_MAX_BYTES = 64 * 1024
IMAGE_ENV_FIXED = {"NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1", "PORT": "3000", "HOSTNAME": "0.0.0.0"}
IMAGE_ENV_FREE = frozenset({"PATH", "NODE_VERSION", "YARN_VERSION"})
MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json",
}
PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
PROXIED_LOCATIONS = ("= /", "= /login", "= /days", "^~ /days/", "= /settings", "^~ /auth/", "^~ /account/", "^~ /_next/")
STATIC_DIRECTORIES = ("try", "design", "promo", "status")
# The only front proxy policy. Static paths keep the default nginx static behaviour (including the
# directory redirect); every other path is 404. Host and forwarded headers are fixed, never client-supplied.
DEV_FRONT_NGINX_CONF = (
    "server {\n"
    "    listen 80;\n"
    "    server_name _;\n"
    "    root /usr/share/nginx/html;\n"
    "    index index.html;\n"
    "    client_max_body_size 1m;\n"
    "\n"
    "    proxy_http_version 1.1;\n"
    "    proxy_read_timeout 30s;\n"
    "    proxy_set_header Host dev.pieceofdays.com;\n"
    "    proxy_set_header X-Forwarded-Host dev.pieceofdays.com;\n"
    "    proxy_set_header X-Forwarded-Proto https;\n"
    "    proxy_set_header Connection \"\";\n"
    "\n"
    + "".join("    location %s { proxy_pass http://pieceofdays-app-dev:3000; }\n" % location for location in PROXIED_LOCATIONS)
    + "\n"
    + "".join("    location = /%s { }\n    location ^~ /%s/ { }\n" % (name, name) for name in STATIC_DIRECTORIES)
    + "\n"
    "    location / { return 404; }\n"
    "}\n"
)


def is_hex(value, length=40):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{%d}" % length, value) is not None


def parse_request(command):
    match = re.fullmatch(r"deploy (dev|production) ([0-9a-f]{40})", command) if isinstance(command, str) else None
    if match is None:
        raise ValueError("expected deploy <dev|production> <40 lowercase hex SHA>")
    return match.group(1), match.group(2)


def parse_app_request(command):
    if isinstance(command, str):
        if command == "revert-static dev":
            return ("revert-static", "dev")
        match = re.fullmatch(r"deploy-app dev ([0-9a-f]{40}) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) (sha256:[0-9a-f]{64})", command)
        if match is not None:
            return ("deploy-app", "dev") + match.groups()
    raise ValueError("expected deploy-app dev <sha> <tree> <manifest digest> <config digest> or revert-static dev")


def validate_compose(data, env):
    if env not in ENVIRONMENTS or not isinstance(data, dict):
        raise ValueError("invalid environment or Compose document")
    _, project, service, _, _, _, _, _ = ENVIRONMENTS[env]
    projects = {project, "pieceofdays"} if env == "production" else {project}
    if set(data) - {"name", "services", "networks"} or data.get("name") not in projects:
        raise ValueError("unapproved Compose fields or project")
    services = data.get("services")
    if not isinstance(services, dict) or set(services) != {service}:
        raise ValueError("only the exact environment service is allowed")
    item = services[service]
    allowed = {"image", "build", "container_name", "restart", "expose", "healthcheck", "networks", "read_only", "tmpfs", "cap_drop", "security_opt"}
    if not isinstance(item, dict) or set(item) - allowed:
        raise ValueError("unapproved service fields")
    if item.get("container_name") != service or not isinstance(item.get("image"), str) or not item["image"].strip():
        raise ValueError("invalid image or container name")
    if item.get("restart") != "unless-stopped" or item.get("expose") != ["80"] or item.get("healthcheck") != HEALTH:
        raise ValueError("unapproved runtime or health policy")
    if item.get("networks") != {"edge": None} or data.get("networks") != {"edge": {"name": "edge", "external": True}}:
        raise ValueError("only external edge without aliases is allowed")
    fixed = {"read_only": True, "tmpfs": ["/var/cache/nginx", "/var/run"], "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"]}
    for key, value in fixed.items():
        if key in item and item[key] != value:
            raise ValueError("unapproved hardening option")
    if "build" in item:
        build = item["build"]
        if not isinstance(build, dict) or set(build) - {"context", "dockerfile"}:
            raise ValueError("unapproved build fields")
        context = build.get("context")
        if not isinstance(context, str) or not context or re.search(r"[\x00-\x20$~]", context) or ":" in context or ".." in Path(context).parts:
            raise ValueError("invalid local build context")
        if build.get("dockerfile", "Dockerfile") != "Dockerfile":
            raise ValueError("unapproved Dockerfile path")


def require_dev_validation(tree, record):
    if not is_hex(tree) or not isinstance(record, dict) or record.get("status") != "success" or record.get("tree") != tree:
        raise ValueError("production requires the current successful dev tree")


def run(args, cwd=None, timeout=300, binary=False):
    result = subprocess.run(args, cwd=cwd, env=SAFE_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode:
        # Never forward credentials or repository-controlled child output.
        raise RuntimeError("command failed: " + args[0] + " " + args[1])
    return result.stdout if binary else result.stdout.decode().strip()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def trusted_file(path):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError("trusted paths must be absolute")
    for part in (path, *path.parents):
        stat = part.lstat()
        if part.is_symlink() or stat.st_uid not in {0, os.getuid()} or stat.st_mode & 0o022:
            raise ValueError("unsafe trusted path permissions")
    return path


def read_json(path):
    return json.loads(trusted_file(path).read_text())


def atomic_json(path, data):
    path = Path(path)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(data, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def clear_pending(path):
    path.unlink()
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def runtime_compose(env, image):
    _, project, service, _, _, _, _, _ = ENVIRONMENTS[env]
    return {"name": project, "services": {service: {"image": image, "container_name": service, "restart": "unless-stopped", "expose": ["80"], "healthcheck": HEALTH, "networks": {"edge": None}, "read_only": True, "tmpfs": ["/var/cache/nginx", "/var/run"]}}, "networks": {"edge": {"name": "edge", "external": True}}}


def compose_up(path, env, settings):
    _, project, service, _, _, _, _, _ = ENVIRONMENTS[env]
    run(["/usr/bin/docker", "compose", "--env-file", "/dev/null", "--project-directory", settings["runtime_working_dir"], "-p", project, "-f", str(path), "up", "-d", "--no-deps", "--no-build", "--pull", "never", service], cwd=settings["runtime_working_dir"])


def verify_container(name, image, html_hash):
    for _ in range(45):
        info = json.loads(run(["/usr/bin/docker", "inspect", name]))[0]
        state = info["State"]
        if info["Image"] != image or not state.get("Running"):
            raise RuntimeError("container image or running state mismatch")
        if state.get("Health", {}).get("Status") == "healthy":
            body = run(["/usr/bin/docker", "exec", name, "wget", "-qO-", "http://127.0.0.1:80/"], binary=True)
            if digest(body) != html_hash:
                raise RuntimeError("container serving HTML mismatch")
            return
        time.sleep(2)
    raise RuntimeError("container health timed out")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_release(record, env, settings):
    verify_container(ENVIRONMENTS[env][2], record["image_id"], record["serving_html_sha256"])
    headers = read_json(settings["health_headers_file"]) if settings.get("health_headers_file") else {}
    if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
        raise ValueError("health headers must be a string map")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for attempt in range(10):
        try:
            request = urllib.request.Request(settings["health_url"], headers={**headers, "Accept-Encoding": "identity", "Cache-Control": "no-cache"})
            with opener.open(request, timeout=15) as response:
                if response.status != 200 or digest(response.read(2 * 1024 * 1024)) != record["serving_html_sha256"]:
                    raise RuntimeError("HTTPS serving HTML mismatch")
            return
        except Exception:
            if attempt == 9:
                raise RuntimeError("HTTPS health or HTML verification failed") from None
            time.sleep(2)


def validate_record(record, env):
    if not isinstance(record, dict) or record.get("status") != "success" or not all(is_hex(record.get(k)) for k in ("sha", "tree")):
        raise ValueError("invalid previous release record")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", record.get("image_id", "")) or not all(is_hex(record.get(k), 64) for k in ("serving_html_sha256", "compose_sha256")) or not isinstance(record.get("timestamp"), str):
        raise ValueError("invalid previous release artifacts")
    path = trusted_file(record["compose_path"])
    if digest(path.read_bytes()) != record["compose_sha256"]:
        raise ValueError("previous Compose hash mismatch")
    data = read_json(path)
    validate_compose(data, env)
    if data != runtime_compose(env, record["image_id"]):
        raise ValueError("previous Compose must match the trusted runtime template")
    if run(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", record["image_id"]]) != record["image_id"]:
        raise ValueError("previous image is unavailable")
    return record


def assert_latest(env, sha):
    ref = "refs/heads/" + ENVIRONMENTS[env][0]
    fields = run(["/usr/bin/git", "ls-remote", "--exit-code", REPOSITORY, ref]).split()
    if fields != [sha, ref]:
        raise ValueError("request is no longer the current GitHub branch SHA")


def validated_dev_tree(tree):
    global PHASE
    PHASE = "dev-validation"
    record = read_json(STATE / "dev-current.json")
    # A dev app record never authorizes a static production promotion; refuse it before anything else.
    if isinstance(record, dict) and record.get("mode") == "app":
        raise ValueError("dev app record is not a production promotion basis")
    if (STATE / "dev-pending.json").exists():
        raise ValueError("dev has an interrupted deployment; recover dev first")
    if not isinstance(record, dict) or "mode" in record:
        raise ValueError("dev record is not a static release record")
    record = validate_record(record, "dev")
    PHASE = "production-promotion-check"
    require_dev_validation(tree, record)


def sync_dev_clone(sha, source, settings):
    clone = settings["runtime_working_dir"]
    git = ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-C", clone]
    allowed_config = {"core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "remote.origin.url", "remote.origin.fetch", "branch.dev.remote", "branch.dev.merge"}
    config_keys = run(git + ["config", "--local", "--includes", "--name-only", "--list"]).splitlines()
    if set(config_keys) - allowed_config:
        raise ValueError("unapproved local Git configuration keys")
    if run(git + ["config", "--get", "remote.origin.url"]) != REPOSITORY or run(git + ["remote", "get-url", "origin"]) != REPOSITORY:
        raise ValueError("dev origin must be the canonical GitHub repository")
    if run(git + ["symbolic-ref", "--short", "HEAD"]) != "dev" or run(git + ["status", "--porcelain", "--untracked-files=no"]):
        raise ValueError("dev clone must be clean and on branch dev")
    head = run(git + ["rev-parse", "HEAD"])
    # Check ancestry in the isolated fetched repository before touching the clone.
    run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(source), "merge-base", "--is-ancestor", head, sha])
    run(git + ["fetch", "--no-tags", "origin", "dev"])
    if run(git + ["rev-parse", "FETCH_HEAD"]) != sha:
        raise ValueError("dev branch changed during fetch")
    run(git + ["merge", "--ff-only", sha])
    if run(git + ["rev-parse", "HEAD"]) != sha:
        raise ValueError("dev clone did not reach the requested SHA")


def candidate(env, image, html_hash):
    name = "pieceofdays-candidate-" + env + "-" + uuid.uuid4().hex
    try:
        run(["/usr/bin/docker", "run", "--detach", "--name", name, "--network", "none", "--read-only", "--tmpfs", "/var/cache/nginx", "--tmpfs", "/var/run", "--health-cmd", HEALTH["test"][1], "--health-interval", "2s", "--health-timeout", "5s", "--health-retries", "3", image])
        verify_container(name, image, html_hash)
    finally:
        run(["/usr/bin/docker", "rm", "--force", name])


def deploy(env, sha, settings):
    global PHASE
    current_path = STATE / (env + "-current.json")
    pending_path = STATE / (env + "-pending.json")
    if env == "dev":
        # dev pending may hold either record format (static or app); recover it by its mode.
        recover_dev_pending(settings)
    elif pending_path.exists():
        PHASE = "interrupted-release-recovery"
        previous = validate_record(read_json(pending_path), env)
        compose_up(previous["compose_path"], env, settings)
        verify_release(previous, env, settings)
        atomic_json(current_path, previous)
        clear_pending(pending_path)
    PHASE = "branch-and-rollback-record-check"
    assert_latest(env, sha)
    previous = read_json(current_path if current_path.exists() else settings["bootstrap_record"])
    if env == "dev" and dev_record_mode(previous) != "static":
        raise ValueError("dev is in app mode; static deploy is refused (use revert-static dev first)")
    previous = validate_record(previous, env)
    if previous["sha"] == sha:
        if env == "production":
            validated_dev_tree(previous["tree"])
        PHASE = "idempotent-release-health"
        verify_release(previous, env, settings)
        atomic_json(current_path, previous)
        if env == "dev":
            atomic_json(STATE / "dev-static-last.json", previous)
        print("already healthy: " + env + " " + sha)
        return
    PHASE = "rollback-snapshot-health"
    candidate(env, previous["image_id"], previous["serving_html_sha256"])
    with tempfile.TemporaryDirectory(prefix="build-", dir=STATE) as temporary:
        source = Path(temporary) / "source"
        PHASE = "fixed-source-fetch"
        run(["/usr/bin/git", "clone", "--quiet", "--no-checkout", "--single-branch", "--branch", ENVIRONMENTS[env][0], REPOSITORY, str(source)])
        run(["/usr/bin/git", "-C", str(source), "checkout", "--quiet", "--detach", sha])
        tree = run(["/usr/bin/git", "-C", str(source), "rev-parse", "HEAD^{tree}"])
        if not is_hex(tree) or run(["/usr/bin/git", "-C", str(source), "rev-parse", "HEAD"]) != sha:
            raise ValueError("fixed source identity mismatch")
        if env == "production":
            validated_dev_tree(tree)
        _, _, service, compose_name, context_name, content_name, _, _ = ENVIRONMENTS[env]
        compose_source = source / compose_name
        context = source / context_name
        PHASE = "compose-and-build-policy"
        if source.resolve() not in context.resolve().parents or any(p.is_symlink() for p in source.rglob("*")):
            raise ValueError("source symlinks are forbidden")
        # JSON is valid YAML; parse before any Compose include/env-file expansion.
        document = json.loads(compose_source.read_text())
        validate_compose(document, env)
        if document["services"][service].get("build") != {"context": "./" + context_name, "dockerfile": "Dockerfile"}:
            raise ValueError("build context must be the fixed static directory")
        expected = ["FROM nginx:stable-alpine", "COPY " + content_name + "/ /usr/share/nginx/html/"]
        dockerfile = (context / "Dockerfile").read_text()
        if re.search(r"^\s*#\s*(syntax|escape|check)\s*=", dockerfile, re.IGNORECASE | re.MULTILINE):
            raise ValueError("Dockerfile parser directives are forbidden")
        actual = [line.strip() for line in dockerfile.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        if actual != expected:
            raise ValueError("only the approved static-image Dockerfile is allowed")
        html_hash = digest((context / content_name / "index.html").read_bytes())
        tag = "pieceofdays-" + env + ":" + sha
        # Execute only our own Dockerfile, never a repository-supplied frontend.
        trusted_dockerfile = Path(temporary) / "Dockerfile.trusted"
        trusted_dockerfile.write_text("\n".join(expected) + "\n")
        PHASE = "image-build"
        run(["/usr/bin/docker", "build", "--network=none", "--pull", "-f", str(trusted_dockerfile), "-t", tag, str(context)], timeout=600)
        image = run(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", tag])
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
            raise ValueError("unexpected built image identity")
        PHASE = "candidate-health"
        candidate(env, image, html_hash)
        PHASE = "release-directory-policy"
        releases = STATE / "releases"
        release_dir = releases / env / (sha + "-" + uuid.uuid4().hex)
        for path in (releases, releases / env, release_dir):
            path.mkdir(mode=0o700, exist_ok=True)
            trusted_file(path)
        compose_path = release_dir / "compose.json"
        atomic_json(compose_path, runtime_compose(env, image))
        record = {"status": "success", "sha": sha, "tree": tree, "image_id": image, "serving_html_sha256": html_hash, "compose_path": str(compose_path), "compose_sha256": digest(compose_path.read_bytes()), "timestamp": datetime.now(timezone.utc).isoformat()}
        PHASE = "final-branch-check-and-dev-sync"
        assert_latest(env, sha)
        if env == "production":
            validated_dev_tree(tree)
        else:
            sync_dev_clone(sha, source, settings)
            assert_latest(env, sha)
        atomic_json(pending_path, previous)
        try:
            PHASE = "service-switch"
            compose_up(compose_path, env, settings)
            PHASE = "live-https-health"
            verify_release(record, env, settings)
            PHASE = "success-record"
            record["timestamp"] = datetime.now(timezone.utc).isoformat()
            atomic_json(current_path, record)
            clear_pending(pending_path)
        except BaseException:
            failed_phase = PHASE
            PHASE = "rollback"
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            compose_up(previous["compose_path"], env, settings)
            verify_release(previous, env, settings)
            atomic_json(current_path, previous)
            clear_pending(pending_path)
            PHASE = "rollback-complete-after-" + failed_phase
            raise
    if env == "dev":
        # Recorded only after the verified static success, outside the rollback scope.
        PHASE = "static-last-record"
        atomic_json(STATE / "dev-static-last.json", record)
    print("deployed: " + env + " " + sha)


# ----------------------------------------------------------------------------- dev app mode (F6b)


def is_digest(value):
    return isinstance(value, str) and re.fullmatch(DIGEST_RE, value) is not None


def is_positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def dedicated_subnets(settings):
    """Normalized, non-overlapping RFC1918 IPv4 /24 subnets of the two dedicated bridges."""
    subnets = []
    for key in ("front_subnet", "egress_subnet"):
        value = settings.get(key) if isinstance(settings, dict) else None
        if not isinstance(value, str) or re.fullmatch(r"(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}/24", value) is None:
            raise ValueError(key + " must be a normalized IPv4 /24")
        try:
            network = ipaddress.IPv4Network(value)
        except ValueError:
            raise ValueError(key + " must be a normalized IPv4 /24 without host bits") from None
        if str(network) != value or not any(network.subnet_of(private) for private in PRIVATE_NETWORKS):
            raise ValueError(key + " must be an RFC1918 /24")
        subnets.append(network)
    if subnets[0].overlaps(subnets[1]):
        raise ValueError("front_subnet and egress_subnet must not overlap")
    return subnets


def validate_db_network(value):
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is None or value in {"edge", "none", "host", "bridge", FRONT_NETWORK, EGRESS_NETWORK}:
        raise ValueError("db_network must be the name of a separate external network")
    return value


def validate_app_settings(settings, require_enabled):
    if not isinstance(settings, dict) or APP_SETTINGS - set(settings):
        raise ValueError("dev app settings are incomplete")
    if not isinstance(settings["app_mode_enabled"], bool) or (require_enabled and settings["app_mode_enabled"] is not True):
        raise ValueError("dev app mode is not enabled")
    env_file = settings["app_env_file"]
    if not isinstance(env_file, str) or "\x00" in env_file or not os.path.isabs(env_file) or os.path.normpath(env_file) != env_file:
        raise ValueError("app_env_file must be a normalized absolute path")
    if settings["app_health_url"] != APP_HEALTH_URL or settings["server_arch"] != "amd64":
        raise ValueError("unexpected app health URL or server architecture")
    for key in ("app_role", "dev_db"):
        if not isinstance(settings[key], str) or re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", settings[key]) is None:
            raise ValueError(key + " must be a plain PostgreSQL identifier")
    if not isinstance(settings["db_host"], str) or re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", settings["db_host"]) is None:
        raise ValueError("db_host must be a plain host name")
    validate_db_network(settings["db_network"])
    dedicated_subnets(settings)
    return settings


def deployment_ids():
    uid, gid = os.getuid(), os.getgid()
    if not is_positive_int(uid) or not is_positive_int(gid):
        raise ValueError("the deployment user and group must not be root")
    return uid, gid


def release_path(release_id):
    if not isinstance(release_id, str) or re.fullmatch(RELEASE_RE, release_id) is None:
        raise ValueError("invalid release id")
    return STATE / "releases" / "dev" / release_id


def read_private_file(path, limit):
    """Read a 0600 regular file owned by the deployment user, without following symlinks."""
    path = trusted_file(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        raise ValueError("private file is missing or is not a regular file") from None
    try:
        info = os.fstat(descriptor)
        if not statmod.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or statmod.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError("private file must be a 0600 regular file owned by the deployment user")
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError("private file is too large")
            chunks.append(chunk)
    finally:
        os.close(descriptor)
    return b"".join(chunks)


def write_new_private_file(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(data)
        while view:
            view = view[os.write(descriptor, view):]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def unique_json_object(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError("duplicate JSON key")
        data[key] = value
    return data


def validate_app_env(text, settings):
    """Strict KEY=VALUE subset that Node --env-file reads verbatim. Errors name keys or lines, never values."""
    if not isinstance(text, str):
        raise ValueError("app env must be text")
    if text.startswith("﻿"):
        raise ValueError("app env: byte order mark is not allowed")
    if "\r" in text:
        raise ValueError("app env: carriage return is not allowed")
    if any(not (" " <= ch <= "~") and ch != "\n" for ch in text):
        raise ValueError("app env: only printable ASCII and LF are allowed")
    values = {}
    for number, line in enumerate(text.split("\n"), 1):
        if line == "" or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]{0,63})=(.*)", line)
        if match is None:
            raise ValueError("app env line %d: expected KEY=VALUE without spaces or export" % number)
        key, value = match.groups()
        if key not in APP_ENV_KEYS:
            raise ValueError("app env: key not allowed: " + key)
        if key in values:
            raise ValueError("app env: duplicate key: " + key)
        if value == "" or value != value.strip(" ") or "#" in value or value[0] in "\"'`":
            raise ValueError("app env: value of " + key + " must be non-empty, unquoted, without surrounding spaces or #")
        values[key] = value
    for key in APP_ENV_REQUIRED:
        if key not in values:
            raise ValueError("app env: missing key: " + key)
    if values["POD_AUTH_BASE_URL"] != DEV_ORIGIN:
        raise ValueError("app env: POD_AUTH_BASE_URL must be the exact dev origin")
    providers = values["POD_AUTH_PROVIDERS"].split(",")
    if re.fullmatch(r"(google|kakao)(,(google|kakao))*", values["POD_AUTH_PROVIDERS"]) is None or len(set(providers)) != len(providers):
        raise ValueError("app env: POD_AUTH_PROVIDERS must list google and/or kakao once each")
    for provider in APP_ENV_PROVIDERS:
        for part in ("ID", "SECRET"):
            key = "POD_AUTH_%s_CLIENT_%s" % (provider.upper(), part)
            if (provider in providers) != (key in values):
                raise ValueError("app env: " + key + " must be set exactly when its provider is listed")
    if "POD_WITHDRAWAL_ENABLED" in values and values["POD_WITHDRAWAL_ENABLED"] != "1":
        raise ValueError("app env: POD_WITHDRAWAL_ENABLED must be 1 when present")
    try:
        secrets = json.loads(values["POD_AUTH_SESSION_SECRETS"], object_pairs_hook=unique_json_object)
    except ValueError:
        raise ValueError("app env: POD_AUTH_SESSION_SECRETS must be a JSON object") from None
    if not isinstance(secrets, dict) or not secrets:
        raise ValueError("app env: POD_AUTH_SESSION_SECRETS must be a non-empty JSON object")
    for key, secret in secrets.items():
        if re.fullmatch(r"[1-9][0-9]*", key) is None or int(key) > 2 ** 53 - 1 or not isinstance(secret, str) or len(secret) < 32 or secret.strip() == "":
            raise ValueError("app env: POD_AUTH_SESSION_SECRETS needs positive safe integer keys and strings of 32+ characters")
    expected = [settings.get(k) if isinstance(settings, dict) else None for k in ("app_role", "db_host", "dev_db")]
    if not all(isinstance(v, str) and v for v in expected):
        raise ValueError("app env: database expectations are not configured")
    role, host, database = expected
    match = re.fullmatch(r"(postgres|postgresql)://([^:@/?]+):([A-Za-z0-9._~!$&'()*+,;=%-]+)@([^@/?:]+)(:[1-9][0-9]{0,4})?/([^/?]+)", values["POD_DATABASE_URL"])
    if match is None or match.group(2) != role or match.group(4) != host or match.group(6) != database or re.search(r"%(?![0-9A-Fa-f]{2})", match.group(3)):
        raise ValueError("app env: POD_DATABASE_URL must use the dev app role, host and database without query")
    if match.group(5) and int(match.group(5)[1:]) > 65535:
        raise ValueError("app env: POD_DATABASE_URL port is invalid")
    return values


def validate_app_manifest(document, config_digest):
    if not is_digest(config_digest):
        raise ValueError("config digest must be sha256:<64 hex>")
    if not isinstance(document, dict) or "manifests" in document or document.get("schemaVersion") != 2:
        raise ValueError("expected a single-platform schema 2 image manifest")
    config_type = MANIFEST_TYPES.get(document.get("mediaType"))
    config = document.get("config")
    if config_type is None or not isinstance(config, dict):
        raise ValueError("unsupported manifest media type or missing config")
    if config.get("mediaType") != config_type or config.get("digest") != config_digest or not is_positive_int(config.get("size")):
        raise ValueError("manifest config does not match the requested config digest")
    layers = document.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("manifest must list layers")
    for layer in layers:
        if not isinstance(layer, dict) or not is_digest(layer.get("digest")) or not is_positive_int(layer.get("size")) or not isinstance(layer.get("mediaType"), str):
            raise ValueError("malformed manifest layer")


def validate_app_image(inspect, sha, tree, manifest_digest, settings):
    """Checks the pulled image; Id is the opaque engine image ID and is not compared with the config digest."""
    if not isinstance(inspect, dict) or not is_digest(inspect.get("Id")) or not is_hex(sha) or not is_hex(tree) or not is_digest(manifest_digest):
        raise ValueError("invalid image identity")
    if inspect.get("RepoTags") not in (None, []):
        raise ValueError("app image must not carry tags")
    repo_digests = inspect.get("RepoDigests")
    expected = APP_IMAGE_REPOSITORY + "@" + manifest_digest
    if not isinstance(repo_digests, list) or expected not in repo_digests or any(not isinstance(d, str) or re.fullmatch(re.escape(APP_IMAGE_REPOSITORY) + "@" + DIGEST_RE, d) is None for d in repo_digests):
        raise ValueError("app image must come from the fixed repository and manifest digest")
    if inspect.get("Os") != "linux" or inspect.get("Architecture") != settings.get("server_arch"):
        raise ValueError("app image platform mismatch")
    config = inspect.get("Config")
    if not isinstance(config, dict):
        raise ValueError("app image config missing")
    user = config.get("User")
    if not isinstance(user, str) or not user or user.split(":", 1)[0] in {"", "root", "0"}:
        raise ValueError("app image must run as a non-root user")
    labels = config.get("Labels")
    if not isinstance(labels, dict) or labels.get("org.opencontainers.image.source") != APP_SOURCE_URL or labels.get("org.opencontainers.image.revision") != sha or labels.get("pod.tree") != tree:
        raise ValueError("app image labels do not match the requested source")
    if not isinstance(labels.get("pod.migrations.latest"), str) or re.fullmatch(r"[1-9][0-9]{0,8}", labels["pod.migrations.latest"]) is None:
        raise ValueError("app image migration label is invalid")
    if config.get("ExposedPorts") != {"3000/tcp": {}} or config.get("Volumes") not in (None, {}):
        raise ValueError("app image ports or volumes are not allowed")
    env = config.get("Env")
    if not isinstance(env, list):
        raise ValueError("app image env is invalid")
    seen = set()
    for item in env:
        key, separator, value = item.partition("=") if isinstance(item, str) else ("", "", "")
        if not separator or key in seen or (key not in IMAGE_ENV_FREE and IMAGE_ENV_FIXED.get(key) != value):
            raise ValueError("app image env contains a key or value outside the allowlist")
        seen.add(key)


def app_tmpfs(uid, gid):
    return ["/tmp:rw,noexec,nosuid,nodev,size=64m", "/app/.next/cache:rw,noexec,nosuid,nodev,size=64m,uid=%d,gid=%d,mode=0700" % (uid, gid)]


def runtime_compose_app(front_id, app_image_id, release_id, uid, gid, settings):
    """The only dev app-mode Compose document. Images are local engine image IDs; no registry reference."""
    if not is_digest(front_id) or not is_digest(app_image_id):
        raise ValueError("compose images must be local engine image IDs")
    if not is_positive_int(uid) or not is_positive_int(gid):
        raise ValueError("app uid and gid must be positive")
    secret_file = release_path(release_id) / "app.env"
    front_subnet, egress_subnet = dedicated_subnets(settings)
    db_network = validate_db_network(settings.get("db_network"))
    # Fixed addresses keep the nginx upstream (resolved at nginx start) valid across app restarts.
    app_address, front_address = str(front_subnet.network_address + 10), str(front_subnet.network_address + 11)
    return {
        "name": DEV_PROJECT,
        "services": {
            FRONT_SERVICE: {
                "image": front_id,
                "container_name": FRONT_SERVICE,
                "restart": "unless-stopped",
                "expose": ["80"],
                "healthcheck": FRONT_HEALTH,
                "depends_on": {APP_SERVICE: {"condition": "service_started"}},
                "networks": {"edge": None, "front": {"ipv4_address": front_address}},
                "read_only": True,
                "tmpfs": list(FRONT_TMPFS),
            },
            APP_SERVICE: {
                "image": app_image_id,
                "container_name": APP_SERVICE,
                "restart": "unless-stopped",
                "entrypoint": ["node"],
                "command": list(APP_COMMAND),
                "user": "%d:%d" % (uid, gid),
                "healthcheck": APP_HEALTH,
                "secrets": [APP_SECRET_NAME],
                "networks": {"front": {"ipv4_address": app_address}, "db": None, "egress": None},
                "read_only": True,
                "tmpfs": app_tmpfs(uid, gid),
                "cap_drop": ["ALL"],
                "security_opt": ["no-new-privileges:true"],
            },
        },
        "networks": {
            "edge": {"name": "edge", "external": True},
            "front": {"name": FRONT_NETWORK, "driver": "bridge", "internal": True, "ipam": {"config": [{"subnet": str(front_subnet)}]}},
            "db": {"name": db_network, "external": True},
            "egress": {"name": EGRESS_NETWORK, "driver": "bridge", "ipam": {"config": [{"subnet": str(egress_subnet)}]}},
        },
        "secrets": {APP_SECRET_NAME: {"file": str(secret_file)}},
    }


def dev_record_mode(record):
    if not isinstance(record, dict):
        raise ValueError("invalid dev release record")
    if "mode" not in record:
        return "static"
    if record["mode"] == "app":
        return "app"
    raise ValueError("unknown dev release record mode")


def validate_app_record(record, settings):
    """Local checks of an app record and its frozen release files; returns the same record."""
    if not isinstance(record, dict) or set(record) != APP_RECORD_KEYS or record.get("mode") != "app" or record.get("status") != "success":
        raise ValueError("invalid app release record shape")
    if not is_hex(record["sha"]) or not is_hex(record["tree"]) or not isinstance(record["release_id"], str) or not record["release_id"].startswith(record["sha"] + "-"):
        raise ValueError("invalid app release identity")
    if not all(is_digest(record[k]) for k in ("front_image_id", "app_image_id", "app_manifest_digest", "app_config_digest")) or record["app_manifest_digest"] == record["app_config_digest"]:
        raise ValueError("invalid app release image identities")
    if not all(is_hex(record[k], 64) for k in ("try_html_sha256", "compose_sha256", "env_sha256")) or not isinstance(record["timestamp"], str):
        raise ValueError("invalid app release hashes")
    uid, gid = deployment_ids()
    release_dir = trusted_file(release_path(record["release_id"]))
    try:
        info = os.lstat(release_dir)
    except OSError:
        raise ValueError("app release directory is missing") from None
    if not statmod.S_ISDIR(info.st_mode) or info.st_uid != uid or statmod.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("app release directory must be a private directory of the deployment user")
    env_bytes = read_private_file(release_dir / "app.env", APP_ENV_MAX_BYTES)
    compose_bytes = read_private_file(release_dir / "compose.json", 1024 * 1024)
    if digest(env_bytes) != record["env_sha256"] or digest(compose_bytes) != record["compose_sha256"]:
        raise ValueError("frozen release file hash mismatch")
    try:
        validate_app_env(env_bytes.decode("utf-8"), settings)
    except UnicodeDecodeError:
        raise ValueError("frozen app env is not UTF-8") from None
    if json.loads(compose_bytes) != runtime_compose_app(record["front_image_id"], record["app_image_id"], record["release_id"], uid, gid, settings):
        raise ValueError("frozen Compose must match the trusted app template")
    for image in (record["front_image_id"], record["app_image_id"]):
        if run([DOCKER, "image", "inspect", "--format", "{{.Id}}", image]) != image:
            raise ValueError("release image is not available locally")
    return record


def validated_dev_record(record, settings):
    if dev_record_mode(record) == "app":
        return validate_app_record(record, settings)
    return validate_record(record, "dev")


def compose_up_dev(path, settings):
    # --remove-orphans: switching between the static and app documents leaves no stale container.
    run([DOCKER, "compose", "--env-file", "/dev/null", "--project-directory", settings["runtime_working_dir"], "-p", DEV_PROJECT, "-f", str(path), "up", "-d", "--no-build", "--pull", "never", "--remove-orphans"], cwd=settings["runtime_working_dir"], timeout=600)


def restore_dev_record(record, settings):
    """Bring up an already validated dev record from local files and images only, then verify it."""
    if dev_record_mode(record) == "app":
        compose_up_dev(release_path(record["release_id"]) / "compose.json", settings)
        verify_app_release(record, settings)
    else:
        compose_up_dev(record["compose_path"], settings)
        verify_release(record, "dev", settings)


def recover_dev_pending(settings):
    global PHASE
    pending_path = STATE / "dev-pending.json"
    if not pending_path.exists():
        return
    PHASE = "interrupted-release-recovery"
    record = validated_dev_record(read_json(pending_path), settings)
    restore_dev_record(record, settings)
    atomic_json(STATE / "dev-current.json", record)
    clear_pending(pending_path)


def wait_container_healthy(name, image):
    for _ in range(45):
        info = json.loads(run([DOCKER, "inspect", "--type", "container", name]))[0]
        state = info.get("State") or {}
        if info.get("Image") != image or state.get("Running") is not True:
            raise RuntimeError("container image or running state mismatch")
        health = (state.get("Health") or {}).get("Status")
        if health == "healthy":
            return
        if health != "starting":
            raise RuntimeError("container is not healthy")
        time.sleep(2)
    raise RuntimeError("container health timed out")


def front_candidate(image, try_hash):
    name = "pieceofdays-candidate-front-" + uuid.uuid4().hex
    try:
        # The fixed upstream name only has to resolve for nginx to start; nothing is reachable (network none).
        run([DOCKER, "run", "--detach", "--name", name, "--network", "none", "--read-only", "--tmpfs", FRONT_TMPFS[0], "--tmpfs", FRONT_TMPFS[1], "--add-host", APP_SERVICE + ":127.0.0.1", "--health-cmd", FRONT_TRY_CHECK, "--health-interval", "2s", "--health-timeout", "5s", "--health-retries", "3", image])
        wait_container_healthy(name, image)
        if digest(run([DOCKER, "exec", name, "wget", "-qO-", "http://127.0.0.1:80/try/"], binary=True)) != try_hash:
            raise RuntimeError("candidate /try/ mismatch")
    finally:
        run([DOCKER, "rm", "--force", name])


def app_candidate(image, uid, gid):
    """Env-less liveness of the app image through the runtime wrapper, with the runtime hardening."""
    name = "pieceofdays-candidate-app-" + uuid.uuid4().hex
    hardening = ["--read-only", "--tmpfs", app_tmpfs(uid, gid)[0], "--tmpfs", app_tmpfs(uid, gid)[1], "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "%d:%d" % (uid, gid)]
    try:
        run([DOCKER, "run", "--detach", "--name", name, "--network", "none", *hardening, "--health-cmd", 'node -e "' + APP_LIVENESS_JS + '"', "--health-interval", "2s", "--health-timeout", "5s", "--health-retries", "3", "--entrypoint", "node", image, "runtime-startup.mjs"])
        wait_container_healthy(name, image)
        run([DOCKER, "exec", name, "node", "-e", APP_LIVENESS_JS])
    finally:
        run([DOCKER, "rm", "--force", name])


def candidate_dev_record(record, uid, gid):
    if dev_record_mode(record) == "app":
        front_candidate(record["front_image_id"], record["try_html_sha256"])
        app_candidate(record["app_image_id"], uid, gid)
    else:
        candidate("dev", record["image_id"], record["serving_html_sha256"])


def cache_directives(value):
    return {part.strip().split("=", 1)[0].strip().lower() for part in value.split(",")} if isinstance(value, str) else set()


def verify_app_release(record, settings):
    """Post-switch checks: exact running healthy images, internal readiness and /try/, public /try/ and /login."""
    wait_container_healthy(APP_SERVICE, record["app_image_id"])
    wait_container_healthy(FRONT_SERVICE, record["front_image_id"])
    run([DOCKER, "exec", APP_SERVICE, "node", "-e", APP_READY_JS])
    if digest(run([DOCKER, "exec", FRONT_SERVICE, "wget", "-qO-", "http://127.0.0.1:80/try/"], binary=True)) != record["try_html_sha256"]:
        raise RuntimeError("front /try/ mismatch")
    headers = read_json(settings["health_headers_file"]) if settings.get("health_headers_file") else {}
    if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
        raise ValueError("health headers must be a string map")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def fetch(url):
        request = urllib.request.Request(url, headers={**headers, "Accept-Encoding": "identity", "Cache-Control": "no-cache"})
        with opener.open(request, timeout=15) as response:
            return response.status, response.headers.get("Cache-Control"), response.read(2 * 1024 * 1024)

    for attempt in range(10):
        try:
            status, _, body = fetch(settings["app_health_url"])
            if status != 200 or digest(body) != record["try_html_sha256"]:
                raise RuntimeError("public /try/ mismatch")
            status, cache_control, _ = fetch(APP_LOGIN_URL)
            if status != 200 or "no-store" not in cache_directives(cache_control):
                raise RuntimeError("public /login must be 200 and no-store")
            return
        except (OSError, RuntimeError, http.client.HTTPException):
            if attempt == 9:
                raise RuntimeError("public HTTPS app verification failed") from None
            time.sleep(2)


def check_dedicated_networks(settings):
    """Refuse an existing dedicated network whose IPAM differs; never create, change or remove networks."""
    front_subnet, egress_subnet = dedicated_subnets(settings)
    existing = set(run([DOCKER, "network", "ls", "--format", "{{.Name}}"]).splitlines())
    for name, subnet, internal in ((FRONT_NETWORK, str(front_subnet), True), (EGRESS_NETWORK, str(egress_subnet), False)):
        if name not in existing:
            continue
        items = json.loads(run([DOCKER, "network", "inspect", name]))
        item = items[0] if isinstance(items, list) and len(items) == 1 and isinstance(items[0], dict) else {}
        config = (item.get("IPAM") or {}).get("Config") if isinstance(item.get("IPAM"), dict) else None
        entry = config[0] if isinstance(config, list) and len(config) == 1 and isinstance(config[0], dict) else {}
        if item.get("Name") != name or item.get("Driver") != "bridge" or item.get("Internal", internal) is not internal or entry.get("Subnet") != subnet or set(entry) - {"Subnet", "Gateway"}:
            raise ValueError("existing dedicated network " + name + " does not match the fixed IPAM")


def read_live_app_env(settings):
    data = read_private_file(settings["app_env_file"], APP_ENV_MAX_BYTES)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("app env is not UTF-8") from None
    validate_app_env(text, settings)
    return data


def deploy_app(sha, tree, manifest_digest, config_digest, settings):
    global PHASE
    PHASE = "app-request-check"
    if not is_hex(sha) or not is_hex(tree) or not is_digest(manifest_digest) or not is_digest(config_digest) or manifest_digest == config_digest:
        raise ValueError("invalid app deployment request")
    validate_app_settings(settings, require_enabled=True)
    uid, gid = deployment_ids()
    current_path = STATE / "dev-current.json"
    pending_path = STATE / "dev-pending.json"
    recover_dev_pending(settings)
    PHASE = "branch-and-rollback-record-check"
    assert_latest("dev", sha)
    if not current_path.exists() and not settings.get("bootstrap_record"):
        raise ValueError("no current dev record to roll back to")
    previous = validated_dev_record(read_json(current_path if current_path.exists() else settings["bootstrap_record"]), settings)
    PHASE = "live-app-env-check"
    env_bytes = read_live_app_env(settings)
    env_hash = digest(env_bytes)
    if dev_record_mode(previous) == "app" and (previous["sha"], previous["tree"], previous["app_manifest_digest"], previous["app_config_digest"], previous["env_sha256"]) == (sha, tree, manifest_digest, config_digest, env_hash):
        PHASE = "idempotent-app-release-health"
        verify_app_release(previous, settings)
        atomic_json(current_path, previous)
        print("already healthy: dev app " + sha)
        return
    PHASE = "rollback-snapshot-health"
    candidate_dev_record(previous, uid, gid)
    with tempfile.TemporaryDirectory(prefix="build-", dir=STATE) as temporary:
        source = Path(temporary) / "source"
        PHASE = "fixed-source-fetch"
        run(["/usr/bin/git", "clone", "--quiet", "--no-checkout", "--single-branch", "--branch", "dev", REPOSITORY, str(source)])
        run(["/usr/bin/git", "-C", str(source), "checkout", "--quiet", "--detach", sha])
        if run(["/usr/bin/git", "-C", str(source), "rev-parse", "HEAD"]) != sha or run(["/usr/bin/git", "-C", str(source), "rev-parse", "HEAD^{tree}"]) != tree:
            raise ValueError("fixed source identity or tree mismatch")
        public = source / "frontend" / "public"
        PHASE = "front-source-policy"
        if any(p.is_symlink() for p in source.rglob("*")) or public.is_symlink() or not public.is_dir():
            raise ValueError("source symlinks are forbidden")
        if any(not (p.is_file() or p.is_dir()) for p in public.rglob("*")) or not (public / "try" / "index.html").is_file():
            raise ValueError("frontend/public must hold only regular files and /try/")
        try_hash = digest((public / "try" / "index.html").read_bytes())

        PHASE = "registry-manifest"
        reference = APP_IMAGE_REPOSITORY + "@" + manifest_digest
        # Anonymous registry access: each call gets its own fresh, empty Docker config directory.
        manifest = json.loads(run([DOCKER, "--config", tempfile.mkdtemp(prefix="registry-", dir=temporary), "manifest", "inspect", reference], timeout=120))
        validate_app_manifest(manifest, config_digest)
        PHASE = "registry-pull"
        run([DOCKER, "--config", tempfile.mkdtemp(prefix="registry-", dir=temporary), "pull", "--quiet", "--platform", "linux/amd64", reference], timeout=900)
        PHASE = "app-image-policy"
        info = json.loads(run([DOCKER, "image", "inspect", "--format", "{{json .}}", reference]))
        validate_app_image(info, sha, tree, manifest_digest, settings)
        app_id = info["Id"]

        PHASE = "front-image-build"
        context = Path(temporary) / "front"
        context.mkdir(mode=0o700)
        shutil.copytree(public, context / "public", symlinks=True)
        (context / "default.conf").write_text(DEV_FRONT_NGINX_CONF)
        os.chmod(context / "default.conf", 0o644)
        dockerfile = Path(temporary) / "Dockerfile.front"
        dockerfile.write_text("FROM " + FRONT_NGINX_BASE + "\nCOPY public/ /usr/share/nginx/html/\nCOPY default.conf /etc/nginx/conf.d/default.conf\n")
        tag = "pieceofdays-dev-front:" + sha
        run([DOCKER, "build", "--network=none", "--pull", "-f", str(dockerfile), "-t", tag, str(context)], timeout=600)
        front_id = run([DOCKER, "image", "inspect", "--format", "{{.Id}}", tag])
        if not is_digest(front_id):
            raise ValueError("unexpected front image identity")

        PHASE = "candidate-health"
        front_candidate(front_id, try_hash)
        app_candidate(app_id, uid, gid)
        PHASE = "dedicated-network-check"
        check_dedicated_networks(settings)

        PHASE = "release-directory-policy"
        releases = STATE / "releases"
        for path in (releases, releases / "dev"):
            path.mkdir(mode=0o700, exist_ok=True)
            trusted_file(path)
        release_id = sha + "-" + uuid.uuid4().hex
        release_dir = release_path(release_id)
        release_dir.mkdir(mode=0o700)
        trusted_file(release_dir)
        compose_bytes = (json.dumps(runtime_compose_app(front_id, app_id, release_id, uid, gid, settings), indent=2) + "\n").encode()
        write_new_private_file(release_dir / "app.env", env_bytes)
        write_new_private_file(release_dir / "compose.json", compose_bytes)
        fsync_directory(release_dir)
        record = {
            "mode": "app",
            "status": "success",
            "sha": sha,
            "tree": tree,
            "release_id": release_id,
            "front_image_id": front_id,
            "app_image_id": app_id,
            "app_manifest_digest": manifest_digest,
            "app_config_digest": config_digest,
            "try_html_sha256": try_hash,
            "compose_sha256": digest(compose_bytes),
            "env_sha256": env_hash,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        record = validate_app_record(record, settings)
        PHASE = "final-branch-check-and-dev-sync"
        assert_latest("dev", sha)
        sync_dev_clone(sha, source, settings)
        assert_latest("dev", sha)
        atomic_json(pending_path, previous)
        try:
            PHASE = "service-switch"
            compose_up_dev(release_dir / "compose.json", settings)
            PHASE = "live-app-health"
            verify_app_release(record, settings)
            PHASE = "success-record"
            record["timestamp"] = datetime.now(timezone.utc).isoformat()
            atomic_json(current_path, record)
            clear_pending(pending_path)
        except BaseException:
            failed_phase = PHASE
            PHASE = "rollback"
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            # Previous frozen env, compose and local image IDs only; no registry and no live env.
            restore_dev_record(previous, settings)
            atomic_json(current_path, previous)
            clear_pending(pending_path)
            PHASE = "rollback-complete-after-" + failed_phase
            raise
    print("deployed: dev app " + sha)


def revert_static(settings):
    global PHASE
    validate_app_settings(settings, require_enabled=False)
    uid, gid = deployment_ids()
    current_path = STATE / "dev-current.json"
    pending_path = STATE / "dev-pending.json"
    static_path = STATE / "dev-static-last.json"
    recover_dev_pending(settings)
    PHASE = "static-record-check"
    if not static_path.exists():
        raise ValueError("no static dev record to revert to")
    static = read_json(static_path)
    if dev_record_mode(static) != "static":
        raise ValueError("dev-static-last is not a static record")
    static = validate_record(static, "dev")
    previous = validated_dev_record(read_json(current_path), settings)
    PHASE = "static-candidate-health"
    candidate("dev", static["image_id"], static["serving_html_sha256"])
    candidate_dev_record(previous, uid, gid)
    atomic_json(pending_path, previous)
    try:
        PHASE = "service-switch"
        compose_up_dev(static["compose_path"], settings)
        PHASE = "live-https-health"
        verify_release(static, "dev", settings)
        PHASE = "success-record"
        atomic_json(current_path, static)
        clear_pending(pending_path)
    except BaseException:
        failed_phase = PHASE
        PHASE = "rollback"
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        restore_dev_record(previous, settings)
        atomic_json(current_path, previous)
        clear_pending(pending_path)
        PHASE = "rollback-complete-after-" + failed_phase
        raise
    print("reverted to static: dev " + static["sha"])


def interrupted(signum, frame):
    raise RuntimeError("deployment interrupted")


def main():
    global PHASE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--allowed-environment", required=True, choices=ENVIRONMENTS)
    args = parser.parse_args()
    command = os.environ.get("SSH_ORIGINAL_COMMAND")
    probe = command == "probe " + args.allowed_environment
    app_request = None
    if not probe:
        if isinstance(command, str) and command.split(" ", 1)[0] in {"deploy-app", "revert-static"}:
            # App commands exist only for dev; refuse other keys before any config, registry or Docker access.
            app_request = parse_app_request(command)
            env = app_request[1]
        else:
            env, sha = parse_request(command)
        if env != args.allowed_environment:
            raise ValueError("key is not authorized for this environment")
    PHASE = "trusted-config"
    config = read_json(args.config)
    if set(config) != {"state_dir", "environments"} or config["state_dir"] != str(STATE) or set(config["environments"]) != set(ENVIRONMENTS):
        raise ValueError("unexpected deployment config")
    settings = config["environments"][args.allowed_environment]
    allowed_settings = STATIC_SETTINGS | (APP_SETTINGS if args.allowed_environment == "dev" else frozenset())
    if not isinstance(settings, dict) or set(settings) - allowed_settings or settings.get("runtime_working_dir") != str(ENVIRONMENTS[args.allowed_environment][6]) or settings.get("health_url") != ENVIRONMENTS[args.allowed_environment][7]:
        raise ValueError("unexpected environment config")
    if app_request is not None:
        validate_app_settings(settings, require_enabled=app_request[0] == "deploy-app")
    # The existing dev clone is group writable. It is only a working directory;
    # no source, dotenv, executable, or Compose file is loaded from that clone.
    runtime = Path(settings["runtime_working_dir"])
    if not runtime.is_dir() or runtime.resolve() != runtime:
        raise ValueError("invalid runtime working directory")
    trusted_file(STATE)
    if probe:
        print("probe ok: " + args.allowed_environment)
        return
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    lock_path = STATE / "deploy.lock"
    if lock_path.is_symlink():
        raise ValueError("unsafe lock")
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if app_request is None:
            deploy(env, sha, settings)
        elif app_request[0] == "deploy-app":
            deploy_app(*app_request[2:], settings)
        else:
            revert_static(settings)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("deployment failed during " + PHASE + ": " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
