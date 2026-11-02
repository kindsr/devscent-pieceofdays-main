#!/usr/bin/env python3
"""Reviewed forced-command helper, installed outside the repository."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

REPOSITORY = "https://github.com/kindsr/pieceofdays.git"
HOME = Path(pwd.getpwuid(os.getuid()).pw_dir)
STATE = HOME / "deployment/pieceofdays"
ENVIRONMENTS = {
    "dev": ("dev", "pieceofdays-dev", "pieceofdays-frontend-dev", "docker-compose.dev.yml", "frontend", "public", HOME / "development/devscent-pieceofdays-main", "https://dev.pieceofdays.com/"),
    "production": ("main", "devscent-pieceofdays-main", "pieceofdays-comingsoon", "docker-compose.yml", "deploy/comingsoon", "html", STATE, "https://pieceofdays.com/"),
}
HEALTH = {"test": ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:80/ || exit 1"], "interval": "30s", "timeout": "5s", "retries": 3}
SAFE_ENV = {"PATH": "/usr/bin:/bin", "HOME": str(HOME), "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "DOCKER_CONFIG": str(STATE / "docker-config")}
PHASE = "request"


def is_hex(value, length=40):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{%d}" % length, value) is not None


def parse_request(command):
    match = re.fullmatch(r"deploy (dev|production) ([0-9a-f]{40})", command) if isinstance(command, str) else None
    if match is None:
        raise ValueError("expected deploy <dev|production> <40 lowercase hex SHA>")
    return match.group(1), match.group(2)


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
    if (STATE / "dev-pending.json").exists():
        raise ValueError("dev has an interrupted deployment; recover dev first")
    record = validate_record(read_json(STATE / "dev-current.json"), "dev")
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
    if pending_path.exists():
        PHASE = "interrupted-release-recovery"
        previous = validate_record(read_json(pending_path), env)
        compose_up(previous["compose_path"], env, settings)
        verify_release(previous, env, settings)
        atomic_json(current_path, previous)
        clear_pending(pending_path)
    PHASE = "branch-and-rollback-record-check"
    assert_latest(env, sha)
    previous = validate_record(read_json(current_path if current_path.exists() else settings["bootstrap_record"]), env)
    if previous["sha"] == sha:
        if env == "production":
            validated_dev_tree(previous["tree"])
        PHASE = "idempotent-release-health"
        verify_release(previous, env, settings)
        atomic_json(current_path, previous)
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
        release_dir = STATE / "releases" / env / (sha + "-" + uuid.uuid4().hex)
        release_dir.mkdir(parents=True, mode=0o700)
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
    print("deployed: " + env + " " + sha)


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
    if not probe:
        env, sha = parse_request(command)
        if env != args.allowed_environment:
            raise ValueError("key is not authorized for this environment")
    PHASE = "trusted-config"
    config = read_json(args.config)
    if set(config) != {"state_dir", "environments"} or config["state_dir"] != str(STATE) or set(config["environments"]) != set(ENVIRONMENTS):
        raise ValueError("unexpected deployment config")
    settings = config["environments"][args.allowed_environment]
    if set(settings) - {"runtime_working_dir", "bootstrap_record", "health_url", "health_headers_file"} or settings.get("runtime_working_dir") != str(ENVIRONMENTS[args.allowed_environment][6]) or settings.get("health_url") != ENVIRONMENTS[args.allowed_environment][7]:
        raise ValueError("unexpected environment config")
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
        deploy(env, sha, settings)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("deployment failed during " + PHASE + ": " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
