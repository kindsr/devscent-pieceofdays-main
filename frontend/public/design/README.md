# 디자인 시안 3안 — 선택 대기

- 상태: **선택 대기.** 확정 디자인·토큰이 아니다. 선택 뒤 `docs/design/README.md`에 핸드오프를 새로 쓴다.
- 보기: 개발 도메인 `https://dev.pieceofdays.com/design/` (접근 제한·noindex). 로컬은 `python3 -m http.server --bind 127.0.0.1 -d docs/design/concepts` 후 `http://127.0.0.1:8000/`.
- 근거: [계획](../../plans/PLAN_design-preview.md), [스토리보드](../../product/04_STORYBOARD.md), [브리프](../../product/05_DESIGN_PROMPTS.md).

| 경로 | 내용 |
|---|---|
| `index.html` | 비교판: 3안 실제 미리보기(iframe), 화면·폭 전환, 레퍼런스·장점·주의 |
| `a-warm/` | A 따뜻한 기록장 (Warm Editorial 출발, 메인 추천·가설) |
| `b-calm/` | B 차분한 일기장 (kami 출발) |
| `c-pieces/` | C 조각 모음 (Doodle 출발) |
| `shared/` | 같은 샘플 하루(`sample.js`), 리뷰 바·라우팅(`review.*`), 예시 이미지(`img/`) |

각 안 화면 주소: `#today` 오늘, `#write` 작성, `#days` 다시 보기(`#days/2026-11-01` 특정 날), `#empty` 첫날 빈 상태, `#tokens` 토큰 카드. `?embed=1`은 비교판 미리보기용으로 리뷰 바를 숨긴다.

## 동작 범위

- 입력은 화면 메모리 안에서만 추가·반영된다. 서버·외부 API·`localStorage` 등 어떤 저장도 없고 새로고침하면 사라진다.
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
