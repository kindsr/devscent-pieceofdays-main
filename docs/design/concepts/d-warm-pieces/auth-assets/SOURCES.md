# 인증 아트보드 공급자 에셋 — 출처와 권리 표기

`auth.html`(B4-d 정적 아트보드)이 쓰는 공급자 로그인 버튼 에셋이다. 공식 배포 번들의 파일을 **바이트 그대로** 복사했다.
다시 그리거나 색·비율을 바꾸지 않았다. 파일 이름만 경로 공백을 피하려고 바꿨다(아래 대응표).
조회·내려받기: 2026-11-05 (Claude Cloud, 공식 URL 직접 GET).

## Google — Sign in with Google

- 규정: https://developers.google.com/identity/branding-guidelines (영문 primary)
- 번들: https://developers.google.com/static/identity/images/signin-assets.zip
  (sha256 `ba884069e12093b06bcfd776915081254a7c95094b80d50be2c5dc6bac1c1da1`, 855,303 bytes)

| 이 저장소 파일 | 번들 원본 경로 | sha256 |
|---|---|---|
| `google/signin-light-rect-text@4x.png` | `Android + Web/PNG @4x/Light/Theme=Light, Show text=Yes, Shape=Square, Platform=Android+Web@4x.png` | `e048546f162b43a5f3809796f88df02a8e13f07ca1280a9c1635018956e05c05` |
| `google/signin-light-rect-icon@4x.png` | `Android + Web/PNG @4x/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web@4x.png` | `2bc2ae8e4c67de66d74bf1deed12cd8f22981270266a487576b671b0b4df361c` |

- **권리:**
  - 규정 원문: "Use of Google brands in ways not expressly covered by this document is not allowed without prior written consent from Google."
  - 위 파일은 규정이 안내하는 "pre-approved Sign in with Google buttons" 번들에서 가져왔다.
  - 번들 안에 별도 라이선스 파일은 없었다(133개 항목 확인).
  - 규정 밖 용도(다른 화면 장식 등)로 쓰지 않는다.
- **글꼴:** 규정은 버튼 글꼴을 Google Sans Medium 14/20으로 정한다. google/fonts 저장소 `ofl/googlesans`를 직접 확인했다.
  - 라이선스: SIL Open Font License 1.1
  - `METADATA.pb` 문자 범위(subsets): korean이 **없다**. 한글 레이블은 Google Sans로 그릴 수 없다.
  - 이 아트보드는 글꼴 파일을 동봉하거나 원격으로 불러오지 않는다.

## Kakao — 카카오 로그인

- 규정: https://developers.kakao.com/docs/ko/kakaologin/design-guide
- 번들: https://developers.kakao.com/tool/resource/login 의 "전체 다운로드"(`/tool/download/Kakao%20Login.zip`)
  (sha256 `7664a07cdd88ac5219282a4580571a169683468e2efc06c8a962dd87068b5600`, 85,515 bytes)

| 이 저장소 파일 | 번들 원본 경로 | sha256 |
|---|---|---|
| `kakao/kakao_login_kr_medium.svg` | `Kakao Login/SVG/kakao_login_kr_medium.svg` (224×46, 완성형 "카카오 로그인", 글자는 외곽선 path) | `ab90ab44616f14a671844cd991b3fbb33277f42c5bb2cc5a9422344a854c9398` |

- **권리:**
  - 규정 페이지에 별도 사용 허가·라이선스 문구는 없었다.
  - 리소스 페이지 문구는 "전체 다운로드 시 모든 유형의 리소스(언어, 크기 등)를 ZIP 파일로 제공합니다."뿐이다.
  - 사이트 약관 링크(서비스 약관·운영 정책)는 열어 보지 않았다.
  - 이 문서는 원문에 없는 허용을 단정하지 않는다.
- **차이 관찰:** 규정 본문은 "컨테이너 박스의 radius는 12 픽셀"이라고 하지만, 번들 SVG는 `rx="8"`이다. 공식 에셋을 고치지 않고 그대로 쓴다. 메인 판단 항목이다.
