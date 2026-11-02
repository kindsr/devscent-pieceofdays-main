# 자산 대장 (asset ledger)

| 자산 | 출처 | 라이선스·조건 | 비고 |
| --- | --- | --- | --- |
| `assets/capture/*.png`, `manifest.json/js` | 이 저장소 시안 D 화면(base `cb52350`, 개별 조각 수정·폰트 추가 PR #9 이전)을 `scripts/capture.cjs`가 Playwright 1.63.0으로 캡처 | 저장소 자체 산출물 | embed=1(리뷰 바 숨김), 390×560 뷰포트, DPR 3. 그림은 기존 D의 직접 그린 SVG(`docs/design/concepts/shared/img`) 그대로, 기록은 예시(실사용자 정보 없음) |
| `assets/fonts/NotoSansKR-ExtraBold-promo-subset.woff2` | Google Fonts `ofl/notosanskr` 가변 글꼴을 wght 800으로 고정 후 카피 글자만 서브셋(fontTools) | SIL OFL 1.1, `assets/fonts/OFL-NotoSansKR.txt` | 영상 자막·끝 카피 전용 |
| 캡처 시 시스템 글꼴 Noto Sans KR, Nanum Pen Script | Google Fonts `ofl/notosanskr`, `ofl/nanumpenscript` | SIL OFL 1.1 | 캡처 VM에만 설치, 저장소에 넣지 않음. D의 글꼴 스택이 이 글꼴로 렌더됨 |
| `assets/vendor/gsap-3.13.0.min.js` | npm `gsap@3.13.0` dist | GSAP Standard "no charge" license (https://gsap.com/standard-license) | 네트워크 없이 로컬 로드 |
| `assets/audio/clicks.m4a` | `scripts/sfx.cjs`가 ffmpeg `aevalsrc` 사인 감쇠 수식으로 합성 | 저장소 자체 산출물 | 외부 음원 없음 |
| 커서 포인터 경로·클릭 타이밍 | HyperFrames 레지스트리 component `oversized-cursor`(v0.8.179 `hyperframes add`로 VM 임시 폴더에서 확인) | Apache-2.0 (hyperframes) | 경로 `M5 3 L5 19 L9 15 L12 22 L15 20.5 L11.5 14 L18 14 Z`, 흰 채움·#141414 외곽선을 index.html에 직접 사용 |
| `assets/audio/bgm.mp3` | 메인 서버의 Sunra MCP로 생성한 배경음악(연주곡 20초). model `elevenlabs-music`, task_id `4ae0454e-28fd-4209-8d1a-43409a2234c0`, 사용자 승인 비용 80 credit(1회). 공개 CDN 원본을 이 Cloud 세션이 내려받기만 함(추가 생성·유료 호출 없음) | 생성 공급자 이용 조건을 따른다(메인 기록 기준) | sha256 `381c28c932d14182b0c1dfa25c368bafec51d3f0e6a69c2e3d6b6f7967c736fb`, 321,036 bytes, MP3 128kbps 44.1kHz 스테레오, 20.062초, -13.4 LUFS(원본). 원본 그대로 두고 컴포지션에서 0–20초로 자르고 `data-volume`·fade로 작게 믹스 |

Sunra MCP는 **배경음악 생성에만** 쓰였다. 영상 화면은 생성형 이미지·영상이 아니라 실제 D 프로토타입을 브라우저에서 조작한 캡처다.
