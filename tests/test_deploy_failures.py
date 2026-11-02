"""scripts/ops/deploy.py 실패 경계 계약 시험.

Docker·git·네트워크·SSH를 실제로 부르지 않는다. 외부 효과(명령 실행·compose 반영·검증·상태 파일)를
mock과 임시 상태 폴더로 관찰해 아래 경계를 확인한다.
  1) 환경 고정 키에 다른 환경 요청이 오면 설정·git·docker를 건드리기 전에 거부한다.
  2) 환경 probe는 배포·잠금·외부 명령을 부르지 않는다.
  3) 새 릴리스 반영 후 검증이 실패하면 이전 compose로 복귀하고, 검증 전에는 성공 기록을 남기지 않는다.
  4) 복귀마저 실패하면 pending 기록을 보존한다.
"""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEPLOY_PATH = ROOT / "scripts" / "ops" / "deploy.py"

deploy = None


def setUpModule():
    global deploy
    spec = importlib.util.spec_from_file_location("pieceofdays_ops_deploy_failures", DEPLOY_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"배포 스크립트를 불러올 수 없다: {DEPLOY_PATH}")
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)


SHA = "0123456789abcdef0123456789abcdef01234567"
OLD_SHA = "fedcba9876543210fedcba9876543210fedcba98"
TREE = "1111111111111111111111111111111111111111"
OLD_TREE = "2222222222222222222222222222222222222222"
NEW_IMAGE = "sha256:" + "a" * 64
OLD_IMAGE = "sha256:" + "b" * 64
HEALTH = {
    "test": ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:80/ || exit 1"],
    "interval": "30s",
    "timeout": "5s",
    "retries": 3,
}


def side_effect_mocks(test):
    """외부 효과 지점을 모두 기록용 mock으로 바꾼다."""
    mocks = {}
    for name in ("read_json", "run", "deploy", "compose_up", "verify_release", "atomic_json"):
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


class EnvironmentPinnedKeyTests(unittest.TestCase):
    """(1) 환경 고정 키는 다른 환경·형식 밖 요청을 어떤 외부 효과보다 먼저 거부한다."""

    def assertRefusedBeforeAnySideEffect(self, allowed_env, command):
        mocks = side_effect_mocks(self)
        with self.assertRaises(Exception) as caught:
            run_main(self, allowed_env, command)
        self.assertNotIsInstance(caught.exception, SystemExit, "인자 오류가 아니라 요청 거부여야 한다")
        for name, m in mocks.items():
            if name == "signal.signal":  # 신호 처리기 등록은 외부 효과가 아니다
                continue
            with self.subTest(side_effect=name):
                self.assertEqual(m.call_count, 0, f"거부 전에 {name}가 호출됐다")

    def test_dev_key_refuses_production_request_without_reading_config_or_running_commands(self):
        self.assertRefusedBeforeAnySideEffect("dev", f"deploy production {SHA}")

    def test_production_key_refuses_dev_request_without_reading_config_or_running_commands(self):
        self.assertRefusedBeforeAnySideEffect("production", f"deploy dev {SHA}")

    def test_probe_for_the_other_environment_is_refused_without_side_effects(self):
        self.assertRefusedBeforeAnySideEffect("dev", "probe production")
        self.assertRefusedBeforeAnySideEffect("production", "probe dev")

    def test_malformed_or_missing_command_is_refused_without_side_effects(self):
        for command in (None, "", f"deploy dev {SHA}; id", f"deploy dev {SHA.upper()}", "bash -i"):
            with self.subTest(command=command):
                self.assertRefusedBeforeAnySideEffect("dev", command)


class ProbeTests(unittest.TestCase):
    """(2) probe는 설정만 확인하고 배포·잠금·외부 명령을 부르지 않는다."""

    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="pieceofdays-probe-")))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        environments = {}
        settings = {}
        for env, values in deploy.ENVIRONMENTS.items():
            runtime = self.tmp / ("runtime-" + env)
            runtime.mkdir()
            # 환경 표의 경로 값만 임시 폴더로 바꾼다(실제 ~/development·~/deployment를 보지 않기 위해)
            environments[env] = tuple(runtime if isinstance(v, Path) else v for v in values)
            url = next(v for v in values if isinstance(v, str) and v.startswith("https://") and v != deploy.REPOSITORY)
            settings[env] = {"runtime_working_dir": str(runtime), "health_url": url}
        self.config = {"state_dir": str(self.tmp), "environments": settings}
        for target, value in (("ENVIRONMENTS", environments), ("STATE", self.tmp)):
            patcher = mock.patch.object(deploy, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(deploy, "trusted_file", side_effect=lambda p: Path(p))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_probe_succeeds_without_deploying_locking_or_running_commands(self):
        for env in deploy.ENVIRONMENTS:
            with self.subTest(env=env):
                mocks = side_effect_mocks(self)
                mocks["read_json"].return_value = json.loads(json.dumps(self.config))
                run_main(self, env, "probe " + env)
                for name in ("deploy", "run", "compose_up", "verify_release", "atomic_json", "subprocess.run", "fcntl.flock", "urllib.request.urlopen"):
                    self.assertEqual(mocks[name].call_count, 0, f"probe가 {name}를 호출했다")
                self.assertFalse((self.tmp / "deploy.lock").exists(), "probe가 잠금 파일을 만들었다")


class ReleaseRollbackTests(unittest.TestCase):
    """(3)(4) 운영 배포: 새 릴리스 검증 실패 시 이전 compose 복귀, 복귀 실패 시 pending 보존."""

    ENV = "production"

    def setUp(self):
        self.state = Path(os.path.realpath(tempfile.mkdtemp(prefix="pieceofdays-state-")))
        self.addCleanup(lambda: shutil.rmtree(self.state, ignore_errors=True))
        self.current = self.state / f"{self.ENV}-current.json"
        self.pending = self.state / f"{self.ENV}-pending.json"
        old_compose = self.state / "old-compose.json"
        old_compose.write_text("{}\n")
        self.previous = {
            "status": "success",
            "sha": OLD_SHA,
            "tree": OLD_TREE,
            "image_id": OLD_IMAGE,
            "serving_html_sha256": "c" * 64,
            "compose_path": str(old_compose),
            "compose_sha256": "d" * 64,
            "timestamp": "2026-11-01T00:00:00+00:00",
        }
        self.current.write_text(json.dumps(self.previous))
        self.settings = {"runtime_working_dir": str(self.state), "health_url": "https://pieceofdays.com/"}
        self.unexpected = []
        self.observed = []

        patches = {
            "STATE": self.state,
            "trusted_file": mock.Mock(side_effect=lambda p: Path(p)),
            "assert_latest": mock.Mock(return_value=None),
            "validated_dev_tree": mock.Mock(return_value=None),
            "sync_dev_clone": mock.Mock(return_value=None),
            "candidate": mock.Mock(return_value=None),
            "validate_record": mock.Mock(side_effect=lambda record, env: record),
            "run": mock.Mock(side_effect=self.fake_run),
            "compose_up": mock.Mock(side_effect=self.fake_compose_up),
            "verify_release": mock.Mock(side_effect=self.fake_verify_release),
        }
        for name, value in patches.items():
            patcher = mock.patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # 실제 프로세스·네트워크 호출은 시험 실패로 만들고, 신호 처리기 등록은 시험 프로세스에 남기지 않는다
        for patcher in (
            mock.patch.object(deploy.subprocess, "run", side_effect=AssertionError("실제 subprocess.run 호출")),
            mock.patch.object(deploy.urllib.request, "urlopen", side_effect=AssertionError("실제 urlopen 호출")),
            mock.patch.object(deploy.signal, "signal"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.compose_up = patches["compose_up"]
        self.verify_release = patches["verify_release"]
        self.new_verify_fails = True
        self.rollback_fails = False

    # --- 가짜 GitHub 소스(저장소의 정적 이미지 계약)와 docker ---
    def write_source(self, source):
        source = Path(source)
        compose = {
            "name": "devscent-pieceofdays-main",
            "services": {
                "pieceofdays-comingsoon": {
                    "build": {"context": "./deploy/comingsoon", "dockerfile": "Dockerfile"},
                    "image": "pieceofdays-comingsoon:local",
                    "container_name": "pieceofdays-comingsoon",
                    "restart": "unless-stopped",
                    "expose": ["80"],
                    "healthcheck": HEALTH,
                    "networks": {"edge": None},
                }
            },
            "networks": {"edge": {"name": "edge", "external": True}},
        }
        (source / "deploy" / "comingsoon" / "html").mkdir(parents=True)
        (source / "docker-compose.yml").write_text(json.dumps(compose))
        (source / "deploy" / "comingsoon" / "Dockerfile").write_text("FROM nginx:stable-alpine\nCOPY html/ /usr/share/nginx/html/\n")
        (source / "deploy" / "comingsoon" / "html" / "index.html").write_text("<!doctype html><title>new</title>\n")

    def fake_run(self, args, *unused_args, **unused_kwargs):
        args = [str(a) for a in args]
        if args[0].endswith("git") and "clone" in args:
            self.write_source(args[-1])
            return ""
        if args[0].endswith("git") and "rev-parse" in args:
            return TREE if any(a.endswith("^{tree}") for a in args) else SHA
        if args[0].endswith("git") and "checkout" in args:
            return ""
        if args[0].endswith("docker") and "build" in args:
            return ""
        if args[0].endswith("docker") and "inspect" in args:
            return NEW_IMAGE
        self.unexpected.append(args)
        raise AssertionError("예상 밖 외부 명령: " + " ".join(args[:3]))

    def recorded_current_sha(self):
        return json.loads(self.current.read_text()).get("sha") if self.current.exists() else None

    def fake_compose_up(self, path, env, settings):
        self.observed.append(("compose_up", str(path), self.recorded_current_sha(), self.pending.exists()))
        if str(path) == self.previous["compose_path"] and self.rollback_fails:
            raise RuntimeError("rollback compose failed")

    def fake_verify_release(self, record, env, settings):
        self.observed.append(("verify", record["sha"], self.recorded_current_sha(), self.pending.exists()))
        if record["sha"] == SHA and self.new_verify_fails:
            raise RuntimeError("new release unhealthy")

    def run_deploy(self):
        with contextlib.redirect_stdout(io.StringIO()):
            deploy.deploy(self.ENV, SHA, self.settings)

    # --- 시험 ---
    def test_successful_release_is_recorded_only_after_verification(self):
        self.new_verify_fails = False
        self.run_deploy()
        self.assertEqual(self.unexpected, [])
        new_steps = [o for o in self.observed if o[0] == "verify" and o[1] == SHA]
        self.assertEqual(len(new_steps), 1)
        self.assertNotEqual(new_steps[0][2], SHA, "검증 전에 새 릴리스가 current로 기록됐다")
        self.assertTrue(new_steps[0][3], "새 릴리스 반영·검증 중에는 pending(이전 기록)이 있어야 한다")
        self.assertEqual(self.recorded_current_sha(), SHA)
        self.assertFalse(self.pending.exists())

    def test_failed_verification_restores_previous_compose_and_keeps_previous_record(self):
        with self.assertRaises(Exception):
            self.run_deploy()
        self.assertEqual(self.unexpected, [])
        compose_paths = [o[1] for o in self.observed if o[0] == "compose_up"]
        self.assertGreaterEqual(len(compose_paths), 2, "새 릴리스 반영 뒤 복귀 반영이 있어야 한다")
        self.assertNotEqual(compose_paths[0], self.previous["compose_path"], "먼저 새 릴리스를 반영해야 한다")
        self.assertEqual(compose_paths[-1], self.previous["compose_path"], "마지막 반영은 이전 compose여야 한다")
        self.assertIn(OLD_SHA, [o[1] for o in self.observed if o[0] == "verify"], "복귀한 이전 릴리스를 검증해야 한다")
        for step in self.observed:
            self.assertNotEqual(step[2], SHA, f"{step[0]} 시점에 실패한 새 릴리스가 current로 기록돼 있었다")
        self.assertEqual(self.recorded_current_sha(), OLD_SHA)
        self.assertEqual(json.loads(self.current.read_text())["status"], "success")
        self.assertFalse(self.pending.exists(), "복귀 검증까지 끝나면 pending을 정리한다")

    def test_failed_rollback_preserves_pending_previous_record(self):
        self.rollback_fails = True
        with self.assertRaises(Exception):
            self.run_deploy()
        self.assertTrue(self.pending.exists(), "복귀 실패 시 다음 배포가 복구할 pending이 남아야 한다")
        self.assertEqual(json.loads(self.pending.read_text())["sha"], OLD_SHA)
        self.assertNotEqual(self.recorded_current_sha(), SHA, "실패한 새 릴리스가 current로 기록됐다")

    def test_failed_rollback_verification_also_preserves_pending(self):
        def verify(record, env, settings):
            self.observed.append(("verify", record["sha"], self.recorded_current_sha(), self.pending.exists()))
            raise RuntimeError("everything unhealthy")

        self.verify_release.side_effect = verify
        with self.assertRaises(Exception):
            self.run_deploy()
        self.assertTrue(self.pending.exists())
        self.assertEqual(json.loads(self.pending.read_text())["sha"], OLD_SHA)
        self.assertNotEqual(self.recorded_current_sha(), SHA)


if __name__ == "__main__":
    unittest.main()
