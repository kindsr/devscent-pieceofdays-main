#!/usr/bin/env bash
# pieceofdays 전체 검사(.claude/tdd.conf FULL_CHECK). 배포 시험 42 + app lint/typecheck/unit/build/prod-smoke/E2E/DB.
#
# 실행 위치: 그 실행 전용 Cloud VM·GitHub CI·개발 PC만. 일회용 PostgreSQL 18 컨테이너(또는 그 실행 전용 클러스터)가 필요하다.
# 공유 운영 서버에서 실행하지 않는다(next dev E2E·next start·DB 시험이 포트와 DB를 쓴다).
#
# fail closed: 아래 환경 검사가 모두 통과하기 전에는 어떤 시험 명령도, 서버도 띄우지 않는다.
# 비밀값(관리자 URL·비밀번호)은 출력하지 않는다.
set -euo pipefail

fail() {
  echo "full-check: refused - $1" >&2
  exit 2
}

# 1) 격리 플래그와 필요한 환경이 없으면 즉시 실패(고정 문구).
if [[ "${POD_FULL_CHECK_ISOLATED:-}" != "1" || "${POD_TEST_DB_DISPOSABLE:-}" != "1" || -z "${POD_TEST_ADMIN_URL:-}" ]]; then
  fail "POD_FULL_CHECK_ISOLATED=1, POD_TEST_DB_DISPOSABLE=1 and POD_TEST_ADMIN_URL are required (isolated Cloud/CI/dev machine only)"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/app"

# 2) Node 지원 버전(app/package.json engines: ^24.22.2 || >=26.13.0).
command -v node >/dev/null 2>&1 || fail "node not found"
node -e '
  const [a, b, c] = process.versions.node.split(".").map(Number);
  const ok = (a === 24 && (b > 22 || (b === 22 && c >= 2))) || a > 26 || (a === 26 && (b > 13 || (b === 13 && c >= 0)));
  process.exit(ok ? 0 : 1);
' || fail "unsupported Node version (need ^24.22.2 || >=26.13.0)"

# 3) 관리자 URL: postgres 프로토콜, loopback 호스트, 쿼리·조각 없음. 값은 출력하지 않는다.
node -e '
  let u;
  try { u = new URL(process.env.POD_TEST_ADMIN_URL); } catch { process.exit(3); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") process.exit(4);
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") process.exit(5);
  if (u.search !== "" || u.hash !== "") process.exit(6);
' || fail "POD_TEST_ADMIN_URL must be postgres://<user>:<pw>@localhost|127.0.0.1:<port>/<db> without query"

[[ -d "$APP/node_modules" ]] || fail "app/node_modules missing (run npm ci in app first)"

# 4) 시험. 하나라도 실패하면 set -e로 중단한다.
cd "$ROOT"
python3 -B -m unittest discover -s tests -p "test_*.py" -v
cd "$APP"
export NEXT_TELEMETRY_DISABLED=1
npm run lint
npm run typecheck
npm test
npm run build
npm run test:prod-smoke
npm run test:e2e
npm run test:db
echo "full-check: all passed"
