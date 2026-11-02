# 검증 기록 (2026-11-02, Claude Cloud VM)

## 실행 범위

- 캡처: `node scripts/capture.cjs` — 실제 D(embed=1, base `cb52350` = 개별 조각 수정·폰트 추가 PR #9 이전)를 Playwright Chromium으로 클릭·타이핑, still 7장·crop 58장, 페이지 오류 0.
  그 시점 D에는 마켓·크레딧·그림 편집·개별 조각 수정이 없었고 영상에도 없다. 핵심 기록 흐름 시연이라 이후 D 변경으로 MP4를 다시 캡처하지 않는다.
- HyperFrames 0.8.179(프로젝트 로컬 설치, `HYPERFRAMES_NO_TELEMETRY=1`):
  - `hyperframes check --json`: ok. lint 오류 0·경고 5, runtime/layout/motion/contrast 오류 0(대비 9/9 통과).
    남은 경고 5건은 `nested_structure_needs_subcomposition`(자막·끝 카피 clip 안 자식 노드). 계약상 clip 자체는 움직이지 않고 자식만 움직이도록 의도한 구조다.
  - `hyperframes snapshot --at 0.5,2.3,4.2,6.6,8.5,10.5,11.9,13.15,14.15,14.9,15.6,19.5`: 각 클릭 프레임에서 커서 끝이 실제 대상(조각 추가 타일·붙이기·한 줄 쓰기·반영·모아보기·11월 1일)에 닿아 있음, 한글 자막·UI 잘림 없음을 확인.
  - `hyperframes preview --background`: `http://localhost:3002/#project/promo-d` HTTP 200(이 VM 안에서만 열림).
  - `hyperframes render --quality delivery --fps 30`: 600프레임, beginframe 캡처, 약 55초.
- 공개 산출물 검증(`frontend/public/promo/pieceofdays-d-vertical.mp4`):
  - ffprobe: H.264 High yuv420p 1080×1920 30/1 600프레임, AAC LC 48kHz 스테레오, 20.000초, 3,505,574 bytes, moov 앞(faststart).
  - `ffmpeg -v error -f null` 전체 디코딩 오류 없음. 0·300·599번 프레임을 디코딩해 한글·커서·잘림을 직접 확인.
  - 음량: 통합 -18.4 LUFS, 최대 -6.6 dBFS.
  - sha256 mp4 `bda6a3a36a7a386d9eff771dfa7210ae8cb70dbeb3d948b7a8c9c36a875ff223`, poster `3c62176b648eb5b3515a0318c4d3c05b342c32e3d5a4f4405fed8d34129542d8`.
  - 플레이어 `frontend/public/promo/index.html`을 로컬 정적 서버로 열어 페이지·mp4·poster HTTP 200, 외부 URL 0개.
- 카피: 끝 카피 노드의 텍스트가 확정 문구와 정확히 같음(스크립트로 비교 True). 이전 카피 문구 없음.

## 제약·대체

- 공용 `../_template`, 서버, `hc`는 이 Cloud VM에 없어 읽거나 실행하지 않았다.
- HyperFrames 워크플로 스킬(`skills update`)은 외부 스킬 설치라서 실행하지 않았고, 패키지 동봉 문서와 메인이 준 계약으로 작성했다.
  임시 폴더에서 `hyperframes init` 형식을 확인하다가 이 명령이 VM 전역(`~/.claude/skills`, `~/.agents`)에 스킬 4개를 자동 설치한 것을 발견해 즉시 삭제했다(저장소와 무관).
- 시스템 Chrome이라 HyperFrames가 software GPU로 렌더했다(WebGL 미사용 컴포지션이라 결과 영향 없음).
- 폰트는 Google Fonts 저장소에서 OFL 원본을 받아 VM에만 설치했고, 영상 자막용 서브셋만 커밋했다.

## 메인 통합 검토 (2026-11-02)

- 전달된 MP4를 독립 ffprobe로 확인: H.264 yuv420p 1080×1920, 30fps, 600프레임, AAC 48kHz 스테레오, 20.000초, 3,505,574 bytes. ffmpeg 전체 디코딩 오류 0.
- `timeline.cjs`를 장면·프레임 대응 기준으로 사용하고, 2초 간격 디코딩 콘택트시트와 18초 원본 크기 프레임을 확인했다. 별도 episode packet/scene CSV는 없으며 SPEC·타이밍 정본으로 대조했다.
- 조각 추가·타이핑·하루 정리·지난 날 보기 / PASS. 끝 카피(frame 540) / PASS: 최신 문구와 일치하며 잘림 없이 읽힌다. 캡처와 D 색·구성이 일치한다.
- 공개 플레이어 설명의 옛 '선택 대기' 문구는 D 선택 완료로 정정했다. 렌더 파일 자체는 변경하지 않았다. 실제 HTTPS 재생 확인은 배포 후 수행한다.

## 후속 재현성 수정 (메인 리뷰 반영)

- 지적: `capture.cjs`가 `require("playwright")`를 쓰는데 `package.json`에 선언이 없었다(최초 캡처는 VM 전역 `NODE_PATH`의 Playwright 1.63.0으로 해석됨).
- 수정: `playwright` **1.63.0**(실제 사용 버전)을 정확 버전 devDependency로 `package.json`·`package-lock.json`에 고정.
- 확인: `rm -rf node_modules && npm ci --ignore-scripts` 후 `NODE_PATH` 없이
  - `require.resolve("playwright")` → `media/promo-d/node_modules/playwright` 1.63.0, `chromium.launch()` 성공(Chromium 153.0.8010.12, `/opt/pw-browsers`).
  - `npm run capture` 실행: 페이지 오류 0, 결과가 커밋된 `assets/capture/*`와 바이트 단위로 같음(git 변경 0). MP4는 다시 렌더하지 않았다.
