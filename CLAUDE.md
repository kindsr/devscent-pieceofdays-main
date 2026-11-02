# CLAUDE.md — DevScent pieceofdays

@../_template/CLAUDE.md
@AGENTS.md

첫 줄은 DevScent 공통 진입점(공통 `AGENTS.md` 포함)을, 둘째 줄은 이 repo의 서비스 경계를 불러온다.
`~/development/_template`는 `~/projects/_template`의 symlink라 개발 체크아웃에서도 같은 상대경로가 동작한다.
공통 절은 `_template`에서만 고치고, 이 repo에는 서비스 고유 계약만 `AGENTS.md`에 둔다.
가져오기로 상세 절차(09·10·12 문서)가 함께 들어오지 않는다. 작업 표가 가리키는 절은 실제로 읽는다.
새 세션에서 외부 파일 가져오기 신뢰 확인이 나오면 사용자가 판단한다. 하위 에이전트가 대신 승인하지 않는다.
가져오기가 허용되기 전에는 `AGENTS.md`의 경로로 공통 정본을 직접 읽고, 자동 로드됐다고 보고하지 않는다.
