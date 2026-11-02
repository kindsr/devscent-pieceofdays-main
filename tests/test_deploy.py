"""scripts/ops/deploy.py 계약 시험(RED).

목적: GitHub Actions → SSH forced-command 배포 경로에서
  1) 명령 주입·형식 일탈 차단(parse_request)
  2) 허용된 단일 서비스 외 배포·위험 설정 차단(validate_compose)
  3) dev 검증을 통과하지 않은 tree의 운영 승격 차단(require_dev_validation)
을 요구 문장 그대로 확인한다. 실제 Docker·네트워크·SSH 없이 dict(JSON 형태) 입력만 쓴다.

compose 자료는 `docker compose config --format json` 정규화 형태(서비스 networks는 dict,
volumes는 {type, source, target} dict 목록, top-level networks.edge.external)를 기준으로 한다.
"""

import copy
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEPLOY_PATH = ROOT / "scripts" / "ops" / "deploy.py"


def _load_deploy():
    spec = importlib.util.spec_from_file_location("pieceofdays_ops_deploy", DEPLOY_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"배포 스크립트를 불러올 수 없다: {DEPLOY_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = None


def setUpModule():
    global deploy
    deploy = _load_deploy()


SHA = "0123456789abcdef0123456789abcdef01234567"
SHA2 = "fedcba9876543210fedcba9876543210fedcba98"
HEALTHCHECK = {
    "test": ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:80/ || exit 1"],
    "interval": "30s",
    "timeout": "5s",
    "retries": 3,
}
EDGE_NETWORKS = {"edge": {"name": "edge", "external": True}}


def prod_compose():
    return {
        "name": "pieceofdays",
        "services": {
            "pieceofdays-comingsoon": {
                "image": f"pieceofdays-comingsoon:{SHA}",
                "container_name": "pieceofdays-comingsoon",
                "restart": "unless-stopped",
                "expose": ["80"],
                "healthcheck": copy.deepcopy(HEALTHCHECK),
                "networks": {"edge": None},
            }
        },
        "networks": copy.deepcopy(EDGE_NETWORKS),
    }


def dev_compose():
    return {
        "name": "pieceofdays-dev",
        "services": {
            "pieceofdays-frontend-dev": {
                "build": {"context": "/home/kindsr/development/pieceofdays/frontend", "dockerfile": "Dockerfile"},
                "image": "pieceofdays-dev-pieceofdays-frontend-dev",
                "container_name": "pieceofdays-frontend-dev",
                "restart": "unless-stopped",
                "expose": ["80"],
                "healthcheck": copy.deepcopy(HEALTHCHECK),
                "networks": {"edge": None},
            }
        },
        "networks": copy.deepcopy(EDGE_NETWORKS),
    }


def prod_service(data):
    return data["services"]["pieceofdays-comingsoon"]


def dev_service(data):
    return data["services"]["pieceofdays-frontend-dev"]


class ParseRequestTests(unittest.TestCase):
    def test_deploy_dev_with_lowercase_40_hex_returns_dev_and_sha(self):
        self.assertEqual(deploy.parse_request(f"deploy dev {SHA}"), ("dev", SHA))

    def test_deploy_production_with_lowercase_40_hex_returns_production_and_sha(self):
        self.assertEqual(deploy.parse_request(f"deploy production {SHA2}"), ("production", SHA2))

    def test_anything_other_than_the_exact_grammar_is_rejected(self):
        rejected = {
            "빈 명령": "",
            "동사만": "deploy",
            "sha 없음": "deploy dev",
            "환경 없음": f"deploy {SHA}",
            "다른 동사": f"build dev {SHA}",
            "대문자 동사": f"DEPLOY dev {SHA}",
            "대문자 환경": f"deploy Dev {SHA}",
            "prod 약어": f"deploy prod {SHA}",
            "알 수 없는 환경": f"deploy staging {SHA}",
            "status 등 다른 명령": "status",
            "셸 로그인 시도": "bash -i",
            "인자 추가": f"deploy dev {SHA} extra",
            "환경 두 번": f"deploy dev production {SHA}",
        }
        for label, command in rejected.items():
            with self.subTest(label=label, command=command):
                with self.assertRaises(ValueError):
                    deploy.parse_request(command)

    def test_extra_or_unusual_whitespace_is_rejected(self):
        rejected = {
            "앞 공백": f" deploy dev {SHA}",
            "뒤 공백": f"deploy dev {SHA} ",
            "이중 공백": f"deploy  dev {SHA}",
            "탭 구분": f"deploy\tdev\t{SHA}",
            "끝 줄바꿈": f"deploy dev {SHA}\n",
            "끝 CR": f"deploy dev {SHA}\r",
            "중간 줄바꿈": f"deploy dev\n{SHA}",
        }
        for label, command in rejected.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    deploy.parse_request(command)

    def test_shell_injection_attempts_are_rejected(self):
        rejected = [
            f"deploy dev {SHA}; rm -rf ~",
            f"deploy dev {SHA} && curl evil.example",
            f"deploy dev {SHA}|sh",
            f"deploy dev $(id)",
            f"deploy dev `id`",
            f"deploy dev {SHA}\nrm -rf ~",
            f"deploy dev {SHA[:-1]};",
            f"deploy dev ../../{SHA[:34]}",
            f"deploy dev {SHA} > /tmp/x",
        ]
        for command in rejected:
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    deploy.parse_request(command)

    def test_sha_must_be_exactly_40_lowercase_ascii_hex(self):
        rejected = {
            "39자": SHA[:-1],
            "41자": SHA + "0",
            "7자 축약": SHA[:7],
            "대문자 섞임": SHA[:-1] + "A",
            "전부 대문자": SHA.upper(),
            "hex 밖 문자": SHA[:-1] + "g",
            "0x 접두": "0x" + SHA[:38],
            "전각 숫자": "０" + SHA[1:],
            "아랍-인도 숫자": "٠" + SHA[1:],
            "하이픈": SHA[:20] + "-" + SHA[21:],
        }
        for label, sha in rejected.items():
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    deploy.parse_request(f"deploy dev {sha}")
                with self.assertRaises(ValueError):
                    deploy.parse_request(f"deploy production {sha}")

    def test_missing_ssh_original_command_is_rejected(self):
        # forced-command에서 SSH_ORIGINAL_COMMAND가 없으면 None이 들어올 수 있다
        with self.assertRaises(ValueError):
            deploy.parse_request(None)


class ValidateComposeTests(unittest.TestCase):
    def assertRejected(self, data, env):
        with self.assertRaises(ValueError):
            deploy.validate_compose(data, env)

    # --- 통과 ---
    def test_valid_production_compose_passes_and_returns_none(self):
        self.assertIsNone(deploy.validate_compose(prod_compose(), "production"))

    def test_valid_dev_compose_with_build_context_passes_and_returns_none(self):
        self.assertIsNone(deploy.validate_compose(dev_compose(), "dev"))

    # --- 환경·입력 형태 ---
    def test_unknown_environment_is_rejected(self):
        for env in ("prod", "staging", "", None, "Production"):
            with self.subTest(env=env):
                self.assertRejected(prod_compose(), env)

    def test_non_dict_or_service_less_data_is_rejected(self):
        for data in (None, [], "services: {}", {"services": {}}, {"services": None}, {"networks": EDGE_NETWORKS}):
            with self.subTest(data=data):
                self.assertRejected(data, "production")

    # --- 다른 서비스 배포 방지 ---
    def test_dev_service_cannot_be_deployed_as_production(self):
        self.assertRejected(dev_compose(), "production")

    def test_production_service_cannot_be_deployed_as_dev(self):
        self.assertRejected(prod_compose(), "dev")

    def test_any_additional_service_is_rejected(self):
        data = prod_compose()
        extra = copy.deepcopy(prod_service(data))
        extra["container_name"] = "pieceofdays-sidecar"
        data["services"]["pieceofdays-sidecar"] = extra
        self.assertRejected(data, "production")

    def test_container_name_must_equal_the_allowed_service_name(self):
        for name in ("other-app", "pieceofdays-frontend-dev", "", None):
            with self.subTest(name=name):
                data = prod_compose()
                prod_service(data)["container_name"] = name
                self.assertRejected(data, "production")
        data = prod_compose()
        del prod_service(data)["container_name"]
        self.assertRejected(data, "production")

    # --- 네트워크 ---
    def test_service_attached_to_network_other_than_edge_is_rejected(self):
        for networks in ({"edge": None, "default": None}, {"default": None}, {"internal": None}, {}):
            with self.subTest(networks=networks):
                data = prod_compose()
                prod_service(data)["networks"] = networks
                self.assertRejected(data, "production")

    def test_host_network_mode_is_rejected(self):
        for mode in ("host", "container:nginx"):
            with self.subTest(mode=mode):
                data = prod_compose()
                prod_service(data)["network_mode"] = mode
                prod_service(data).pop("networks", None)
                self.assertRejected(data, "production")

    def test_edge_network_must_be_declared_external(self):
        for edge in ({"name": "edge"}, {"name": "edge", "external": False}, {"name": "edge", "external": "true"}):
            with self.subTest(edge=edge):
                data = prod_compose()
                data["networks"]["edge"] = edge
                self.assertRejected(data, "production")
        data = prod_compose()
        del data["networks"]
        self.assertRejected(data, "production")

    def test_additional_top_level_network_is_rejected(self):
        data = prod_compose()
        data["networks"]["backdoor"] = {"name": "backdoor"}
        self.assertRejected(data, "production")

    # --- 호스트 노출·권한 상승 ---
    def test_published_host_ports_are_rejected(self):
        for ports in (
            [{"target": 80, "published": "8080", "protocol": "tcp", "mode": "ingress"}],
            [{"target": 80, "published": "80", "host_ip": "0.0.0.0", "protocol": "tcp"}],
            ["8080:80"],
        ):
            with self.subTest(ports=ports):
                data = prod_compose()
                prod_service(data)["ports"] = ports
                self.assertRejected(data, "production")

    def test_privileged_devices_and_cap_add_are_rejected(self):
        dangerous = {
            "privileged": True,
            "devices": ["/dev/sda:/dev/sda"],
            "cap_add": ["SYS_ADMIN"],
        }
        for key, value in dangerous.items():
            with self.subTest(key=key):
                data = dev_compose()
                dev_service(data)[key] = value
                self.assertRejected(data, "dev")

    def test_bind_mounts_including_docker_socket_are_rejected(self):
        volumes_cases = {
            "소스 bind(현재 live mount)": [
                {"type": "bind", "source": "/home/kindsr/projects/x/html", "target": "/usr/share/nginx/html", "read_only": True}
            ],
            "docker.sock dict": [
                {"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}
            ],
            "docker.sock 짧은 형식": ["/var/run/docker.sock:/var/run/docker.sock"],
            "호스트 루트": [{"type": "bind", "source": "/", "target": "/host"}],
        }
        for label, volumes in volumes_cases.items():
            with self.subTest(label=label):
                data = prod_compose()
                prod_service(data)["volumes"] = volumes
                self.assertRejected(data, "production")

    # --- 이미지·헬스체크 ---
    def test_image_must_be_a_nonempty_string(self):
        for image in ("", None, 123, ["nginx"]):
            with self.subTest(image=image):
                data = prod_compose()
                prod_service(data)["image"] = image
                self.assertRejected(data, "production")
        data = prod_compose()
        del prod_service(data)["image"]
        self.assertRejected(data, "production")

    def test_healthcheck_command_is_required(self):
        cases = {
            "healthcheck 없음": None,
            "test 없음": {"interval": "30s"},
            "빈 test": {"test": []},
            "disable": {"disable": True},
            "NONE": {"test": ["NONE"]},
        }
        for label, healthcheck in cases.items():
            with self.subTest(label=label):
                data = prod_compose()
                if healthcheck is None:
                    del prod_service(data)["healthcheck"]
                else:
                    prod_service(data)["healthcheck"] = healthcheck
                self.assertRejected(data, "production")

    def test_validation_does_not_require_the_dev_only_build_field_for_production(self):
        # 운영은 이미지 사실값으로만 배포한다 — build가 없어도 통과(위 정상 예), 서비스 dict는 변하지 않는다
        data = prod_compose()
        before = copy.deepcopy(data)
        deploy.validate_compose(data, "production")
        self.assertEqual(data, before)


class RequireDevValidationTests(unittest.TestCase):
    def test_success_record_for_same_tree_passes_and_returns_none(self):
        self.assertIsNone(deploy.require_dev_validation(SHA, {"tree": SHA, "status": "success"}))

    def test_missing_record_blocks_promotion(self):
        with self.assertRaises(ValueError):
            deploy.require_dev_validation(SHA, None)

    def test_non_success_status_blocks_promotion(self):
        for status in ("failure", "failed", "pending", "cancelled", "", "Success", "SUCCESS", None, True):
            with self.subTest(status=status):
                with self.assertRaises(ValueError):
                    deploy.require_dev_validation(SHA, {"tree": SHA, "status": status})

    def test_record_for_a_different_tree_blocks_promotion(self):
        for record_tree in (SHA2, SHA[:7], SHA + "0", "", None):
            with self.subTest(record_tree=record_tree):
                with self.assertRaises(ValueError):
                    deploy.require_dev_validation(SHA, {"tree": record_tree, "status": "success"})

    def test_record_missing_fields_blocks_promotion(self):
        for record in ({"status": "success"}, {"tree": SHA}, {}):
            with self.subTest(record=record):
                with self.assertRaises(ValueError):
                    deploy.require_dev_validation(SHA, record)

    def test_malformed_record_type_blocks_promotion(self):
        for record in ([SHA, "success"], f"{SHA} success", 1, (SHA, "success")):
            with self.subTest(record=record):
                with self.assertRaises(ValueError):
                    deploy.require_dev_validation(SHA, record)

    def test_tree_argument_must_be_40_hex(self):
        for tree in (SHA[:39], SHA + "0", SHA[:-1] + "g", "", None, 0, f"{SHA}\n"):
            with self.subTest(tree=tree):
                with self.assertRaises(ValueError):
                    deploy.require_dev_validation(tree, {"tree": tree, "status": "success"})


if __name__ == "__main__":
    unittest.main()
