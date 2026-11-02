# PLAN — 디자인 시안 3안 + 개발 도메인 미리보기

- 상태: 구현 중(Cloud 하위 담당). 기준 `dev` `808b15c`. 메인 검토·dev 통합·배포 확인 전.
- 범위: 선택을 돕는 **독립 정적 HTML/CSS/소량 JS 콘셉트**. 앱 스택 선택·앱 구현이 아니다.

## 1. 사용자 목적

사용자 질문: "시안은 어디서 확인하지? dev.pieceofdays.com 같은 곳에서 시안확인해도 되지않나".
→ 개발 도메인 `https://dev.pieceofdays.com/design/`에서 서로 다른 시안 3안을 실제 화면으로 비교하고 하나를 고르게 한다.
운영 도메인(`pieceofdays.com`) 반영은 범위 밖이다.

## 2. 입력과 공통 가정

- 제품 정의 [확정]: "개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 일기장"(README).
- PRD 초안(PR #3, `4a6c54f`의 `docs/PRD.md`, 사용자 미확정)과 [UI/UX 조사](../product/UI_UX_RESEARCH_2026-11-02.md)를 읽기만 했다.
- 3안 공통 가정: **순간 기록 → 하루 정리 → 날짜별 다시 보기**. 같은 샘플 하루, 같은 화면(오늘·작성·다시 보기·첫날 빈 상태·토큰).
- 사진+짧은 글, 본인만 보기, 하루 정리는 사용자가 직접 씀(PRD §7 A안 권고)은 **시안용 가정**이다.
  감정 기록·AI 자동 스토리·공유는 그리지 않으며 확정했다고 쓰지 않는다.

## 3. 파일 변경 경계

| 파일 | 변경 |
|---|---|
| `docs/plans/PLAN_design-preview.md` | 신규(이 문서) |
| `docs/product/04_STORYBOARD.md`, `docs/product/05_DESIGN_PROMPTS.md` | 신규 초안 |
| `docs/design/concepts/**` | **정본**: 비교판 `index.html`, `a-warm/`·`b-calm/`·`c-pieces/`, 공통 `shared/`, `README.md` |
| `frontend/public/design/**` | 정본의 byte-for-byte 게시 사본(배포 이미지가 `frontend/public`만 COPY). 직접 수정 금지, symlink 금지 |
| `frontend/public/index.html` | `/design/` 링크 추가, "1분 폴링" 설명을 GitHub Actions로 정정. noindex 유지 |
| `CHANGELOG.md`, `README.md` | 한 항목 / 한두 줄 |

변경 금지: AGENTS·CLAUDE·PRD·기존 리서치·배포 helper(`scripts/ops`)·Compose·Dockerfile·CI·nginx·시험.

## 4. 정적 시안의 동작 한계(비목표)

- 로그인·DB·서버 저장·AI API·공유·분석/추적·외부 CDN·외부 폰트 없음. `localStorage` 등 브라우저 영구 저장도 하지 않는다.
- "작성"은 화면 안 샘플 목록에만 추가되고 새로고침하면 사라진다. 각 화면에 "시안·예시 기록, 저장되지 않음"을 한 줄로 표시한다.
- 가짜 저장 성공·AI 생성 성공·죽은 버튼·가짜 통계·KPI를 넣지 않는다.
- 샘플 이미지는 직접 그린 SVG이며 그림 안과 캡션에 "예시 이미지"를 표시한다. 사진이라고 하지 않는다.
- 글꼴은 동봉하지 않는다(OFL 한국어 글꼴 원본이 파일당 3~8MB, 서브셋 도구 미설치). 안별로 서로 다른 시스템 글꼴 스택을 쓰고 기기별 렌더 차이를 한계로 기록한다.

## 5. 검증

```bash
git diff --check
diff -r docs/design/concepts frontend/public/design && echo SAME
(cd docs/design/concepts && find . -type f -exec sha256sum {} + | sort -k2) > /tmp/a
(cd frontend/public/design && find . -type f -exec sha256sum {} + | sort -k2) > /tmp/b && cmp /tmp/a /tmp/b
find docs/design frontend/public -type l   # 출력이 없어야 함
node --check docs/design/concepts/**/*.js
python3 -B -m unittest discover -s tests -p 'test_*.py' -v   # 기존 배포 시험 회귀
```

- 상대 링크·로컬 자원 존재, 외부 URL 로드 없음(출처 링크 `<a>`만 허용)을 스크립트로 확인.
- 사용 가능한 브라우저(Cloud VM의 Chromium/Playwright)로 375·768·1440px 수평 넘침, 비교판↔시안 이동, 작성 폼·빈 상태·토큰 화면, 콘솔 오류를 확인하고 캡처한다.
- Cloud VM의 한국어 글꼴은 사용자 기기와 다르다. 실제 기기 렌더 확인은 메인/사용자가 dev 도메인에서 한다.

## 6. dev 배포 영향과 복귀

- 메인이 이 PR을 `dev`에 병합하면 기존 Actions 파이프라인이 `frontend/`를 정적 이미지로 다시 빌드한다. 새 경로 `/design/`만 늘고 Dockerfile·Compose·nginx는 그대로다.
- 루트 `index.html`이 바뀌므로 배포 helper의 `serving_html_sha256`도 새 값이 된다(정상 동작).
- dev 도메인은 기존 접근 제한(IP 허용 또는 basic auth)과 `X-Robots-Tag: noindex`가 그대로 적용된다. 각 HTML에도 `noindex, nofollow` meta를 둔다.
- 문제 시 기존 절차대로 직전 성공 이미지로 복귀하거나 `dev`에서 이 병합을 되돌린다([deploy/README.md](../../deploy/README.md)).
- 운영(`main`, `pieceofdays.com`) 승격은 이 작업에서 하지 않는다. 시안 선택 뒤 메인이 별도로 판단한다.

## 7. 다음 단계(선택 뒤)

사용자가 A/B/C 중 하나(또는 조합)를 고르면 선택안 하이파이 아트보드와 `docs/design/README.md` 핸드오프(확정 토큰·타입·대비 검사)를 작성한다(공통 09 §2.4).
