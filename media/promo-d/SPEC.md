# pieceofdays D 세로 홍보영상 — SPEC

콘셉트 시연 영상이다. 시안 D 프로토타입(`docs/design/concepts/d-warm-pieces`)의 실제 화면을 브라우저에서 마우스로 조작해
캡처하고, HyperFrames HTML 컴포지션으로 20초 9:16 영상을 만든다. 제품 요구·기술 스택·디자인 확정을 뜻하지 않는다.
이 폴더의 Node 도구(HyperFrames)는 영상 제작용이며 앱 스택 선택이 아니다.

## 출력

| 항목 | 값 |
| --- | --- |
| 공개 산출물 | `frontend/public/promo/pieceofdays-d-vertical.mp4`, `poster.jpg`, `index.html`(플레이어) |
| 규격 | 1080×1920, 30fps, 20.0초(600프레임), H.264 High yuv420p, AAC 48kHz 스테레오, faststart |
| 카피(정확히) | `개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소, pieceofdays` — 줄바꿈만 넣는다 |

카피는 `timeline.cjs`의 `copy`가 정본이며 `scripts/build.cjs`가 `copyLines.join(" ") === copy`를 검사한다.
화면 끝 카피 `<p id="copy">`의 textContent도 이 문자열과 같다(줄은 블록 span으로만 나눈다).

## 흐름(원테이크, 실제 D 화면)

| 시간 | 화면(실제 still) | 동작 | 자막(카피의 의미 단위) |
| --- | --- | --- | --- |
| 0–2.4 | 오늘 보드(조각 4개, 한 줄 비어 있음) | 아래로 스크롤해 조각들을 지나 `+ 조각 추가` 타일 클릭 | 개인의 일상에서 |
| 2.4–6.2 | 작성 팝업(embed 실제 배치) | 커서는 오른쪽으로 비켜서고 메모 타이핑 → `붙이기` 클릭 | 순간을 기록하고 |
| 6.2–8.55 | 새 조각(22:30, 점선 강조)이 붙은 보드 | 위로 스크롤 → `한 줄 쓰기` 클릭 | 하루를 정리하여(7.0~) |
| 8.55–11.95 | 한 줄 편집 | 한 줄 타이핑 → `반영` 클릭 | 하루를 정리하여 |
| 11.95–13.25 | 한 줄이 묶인 오늘 | `모아보기` 탭 클릭 | 스토리텔링을 만들어가는(12.45~) |
| 13.25–14.25 | 모아보기 달력 | 11월 1일 칸 클릭 | 스토리텔링을 만들어가는 |
| 14.25–20 | 11월 1일 다시 보기(앱의 scrollIntoView 위치 931px) | 커서 아래로 퇴장, 15.1부터 화면 카드가 아래로 물러남 | 15.45~ 전체 카피 5줄, 16.35 `pieceofdays` 밑줄 |

- 마켓·크레딧·그림 편집·개별 조각 수정은 화면에 없다(현재 D에 없음).
- 준비 단계(화면 밖): 샘플 오늘의 한 줄을 실제 UI(`고쳐 쓰기` → 비우기 → `반영`)로 비워 "아직 정리하지 않은 하루"에서 시작한다.
- 시계는 2026-11-02 22:30(Asia/Seoul)로 고정해 새 조각·팝업 시각이 `22:30`으로 재현된다.
- 타이핑 메모 `자기 전 보리차 한 잔, 오늘은 여기까지.`, 한 줄 `찬 공기로 시작해 따뜻하게 끝난 하루.`는 예시 문장이다(개인정보 없음).
- 앱의 페이지 이동은 실제로는 즉시 스크롤이지만 영상에서는 0.6~1.2초 부드러운 스크롤로 보인다(화면 내용·배치는 그대로).

## 모션 원칙

- 원테이크: 장면 전환은 커서 클릭과 실제 UI 변화(still 교체)로만 잇는다. crossfade 없음.
- ledger: 자막·끝 카피는 모두 아래→위(세로축), 스크롤도 세로축만. 카드 퇴장은 아래쪽 기준 축소.
- calm: 이동 0.5~1.2초 power2/power3 감속, 무의미한 float·wobble·회전 없음.
- 커서: 레지스트리 `oversized-cursor`의 macOS형 포인터 경로(흰 채움·검은 외곽선)와 클릭 문법(0.1s 압축/0.2s 해제)을 따른다.
  상자 100px(포인터 높이 약 79px ≈ 화면 너비 7%), 화면 아래 밖에서 진입, 끝(tip)을 manifest의 실제 대상 중심에 맞춘다.
  press 프레임에 커서 압축·작은 테라코타 원형 효과·실제 `:active`/hover crop·클릭음이 함께 시작하고, release 프레임에 다음 화면이 된다.
- 안전 영역: 자막·카피는 80% title-safe(x 108–972, y 192–1728), 폰 화면 카드는 90% action-safe(x 54–1026, y 96–1824) 안.

## 소스 구조와 재현

```
media/promo-d/
  timeline.cjs            시간 정본(상태·클릭·스크롤·자막·끝 카피)
  scripts/capture.cjs     실제 D 화면 조작·캡처 → assets/capture/*.png, manifest.json
  scripts/sfx.cjs         ffmpeg 수식으로 클릭음 합성 → assets/audio/clicks.m4a
  scripts/build.cjs       timeline + manifest → index.html(HyperFrames 컴포지션, 생성 파일)
  index.html              root data-duration=20, paused GSAP timeline → window.__timelines.root
  assets/                 capture / fonts(서브셋+OFL) / vendor(GSAP) / audio
  ASSETS.md               자산 대장, REVIEW.md 검증 기록
```

필요: Node 22+, ffmpeg, Playwright Chromium(캡처), 시스템에 `Noto Sans KR`·`Nanum Pen`(나눔손글씨 펜) 설치(캡처 때 D 글꼴 스택이 이 글꼴로 해석된다).

```bash
cd media/promo-d
npm ci --ignore-scripts                 # hyperframes 0.8.179 (영상 도구만)
export HYPERFRAMES_NO_TELEMETRY=1
node scripts/capture.cjs                # D 화면을 바꾼 경우에만 다시 캡처
node scripts/sfx.cjs
node scripts/build.cjs                  # assets/audio/bgm.(mp3|wav|m4a)가 있으면 BGM 트랙을 자동 포함
npx hyperframes check --json
npx hyperframes snapshot --at 0.5,2.3,4.2,6.6,8.5,10.5,11.9,13.15,14.15,15.6,19.5
npx hyperframes render --quality delivery --fps 30 --output /tmp/pod-promo.mp4
ffmpeg -i /tmp/pod-promo.mp4 -c copy -movflags +faststart ../../frontend/public/promo/pieceofdays-d-vertical.mp4
ffmpeg -ss 19.5 -i /tmp/pod-promo.mp4 -frames:v 1 -q:v 3 ../../frontend/public/promo/poster.jpg
```

중간 렌더·snapshot·`.hyperframes/`·`node_modules/`는 Git에 넣지 않는다.

## 오디오

- BGM `assets/audio/bgm.mp3`: 메인 서버의 Sunra MCP로 생성한 20초 연주곡(출처·해시는 ASSETS.md). 원본은 15초부터 스스로 잦아든다.
  컴포지션에서 0–20초로 자르고 `data-volume=0.56`, fade-in 0.6초, fade-out 1.6초.
- 클릭음 `assets/audio/clicks.m4a`: `data-volume=1.8`, press 프레임 6회.
- 결과: 통합 -18.4 LUFS, 최대 -6.6 dBFS. 클릭 구간은 BGM보다 약 4 dB 높아 들리되 튀지 않는다.
