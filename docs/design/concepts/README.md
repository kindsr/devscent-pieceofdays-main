# 디자인 시안 4안 — D 선택 완료

- 상태: **2026-11-02 사용자가 D를 기본 UI/UX·테마로 선택.** 핸드오프는 [`docs/design/README.md`](../README.md). 앱 구현은 아직 없다.
- A/B/C는 비교 기록으로 원본 그대로 둔다(A의 "메인 추천 (가설)"은 선택 전 추천 표시이며 선택 결과가 아니다).
- 보기: 개발 도메인 `https://dev.pieceofdays.com/design/` (접근 제한·noindex). 로컬은 `python3 -m http.server --bind 127.0.0.1 -d docs/design/concepts` 후 `http://127.0.0.1:8000/`.
- 근거: [계획](../../plans/PLAN_design-preview.md), [스토리보드](../../product/04_STORYBOARD.md), [브리프](../../product/05_DESIGN_PROMPTS.md).

| 경로 | 내용 |
|---|---|
| `index.html` | 비교판: 4안 실제 미리보기(iframe), 화면·폭 전환, 레퍼런스·장점·주의 |
| `a-warm/` | A 따뜻한 기록장 (Warm Editorial 출발, 메인 추천·가설) |
| `b-calm/` | B 차분한 일기장 (kami 출발) |
| `c-pieces/` | C 조각 모음 (Doodle 출발) |
| `d-warm-pieces/` | **D 따뜻한 조각 모음 — 선택안.** C의 화면·동작 + A의 색 값. 선택 뒤 개별 조각 `수정`, `#settings` 기록 글꼴 설정을 동작 아트보드로 추가 |
| `shared/` | 같은 샘플 하루(`sample.js`), 리뷰 바·라우팅(`review.*`), 예시 이미지(`img/`) |

각 안 화면 주소: `#today` 오늘, `#write` 작성, `#days` 다시 보기(`#days/2026-11-01` 특정 날), `#empty` 첫날 빈 상태, `#tokens` 토큰 카드. D에만 `#settings` 설정(기록 글꼴). `?embed=1`은 비교판 미리보기용으로 리뷰 바를 숨긴다.

## 동작 범위

- 입력(D의 조각 수정·기록 글꼴 선택 포함)은 화면 메모리 안에서만 추가·반영된다. 서버·외부 API·`localStorage` 등 어떤 저장도 없고 새로고침하면 사라진다.
- 외부 라이브러리·CDN·글꼴·분석 도구 없음. 외부 URL은 출처 링크(`<a>`)뿐이다.

## 자산·글꼴

- `shared/img/*.svg`: 이 작업에서 직접 그린 그림. 그림 안과 화면 캡션에 "예시 이미지"를 표시한다. 사진이 아니다.
- 글꼴은 동봉하지 않는다. 안별 시스템 글꼴 스택(A 명조 제목+고딕 본문, B 명조 본문, C 고딕+작은 손글씨 이름표)을 쓰므로
  설치된 글꼴에 따라 렌더가 다르다. 손글씨(나눔손글씨 펜)가 없으면 고딕으로 대체된다.

## 게시 사본 갱신 (정본은 이 폴더)

배포 이미지는 `frontend/public`만 복사하므로 `frontend/public/design/`에 같은 파일을 둔다. 사본을 직접 고치지 않는다. symlink 금지(배포 helper가 거부).

```bash
rm -rf frontend/public/design && cp -a docs/design/concepts frontend/public/design
diff -r docs/design/concepts frontend/public/design && echo SAME
(cd docs/design/concepts && find . -type f -exec sha256sum {} + | sort -k2) > /tmp/pod-src.sha
(cd frontend/public/design && find . -type f -exec sha256sum {} + | sort -k2) > /tmp/pod-pub.sha
cmp /tmp/pod-src.sha /tmp/pod-pub.sha && echo HASH-SAME
```
