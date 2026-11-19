# 계정 기록 화면 — 합성 자료 시각 확인

2026-11-08 메인이 read·empty·compose·delete·settings × 375/768/1440, PNG 15장을 모두 직접 확인했다. D 핸드오프의 색·2/3/4열 격자·오른쪽 하루 한 줄·모바일 상단·팝업·포커스와 대조했고 잘림·겹침·가독성 문제를 발견하지 않았다.

- 제품: PR64 `573afd1d931a5e2166f2604a0be3f1880feb7d3a`, 캡처 소스: [PR67](https://github.com/kindsr/devscent-pieceofdays-main/pull/67) `d2c551fbbe5f6e148b47005e796fc7b563c3a44e`.
- 실행: [Actions 42480581708](https://github.com/kindsr/devscent-pieceofdays-main/actions/runs/42480581708), 실제 checkout `cb6bc848533eda9b1ed3f3d0a771c49e512625a0`.
- artifact: `13617531151`, ZIP SHA256 `41b9852976e797beb0d367b4436fd08ac7fb74d66610a9b8bb6cded74a60b112`. 정확한 PNG 15개·regular file·signature·폭을 확인하고 원본 바이트 그대로 보존했다.
- 실제 계정 컴포넌트·D CSS는 제품과 바이트 동일하다. 임시 렌더 사본의 셸은 실제 RootLayout의 사용자/글꼴 조회를 실행하지 않는다. 합성 날짜·본문·기록 id만 사용하며 실제 사용자·계정·OAuth·세션·DB는 없다.
- CI에서 action POST·외부 요청·쿠키 0, 제품/CSS 원본 무변경, PNG 외 artifact 0을 확인했다. 캡처 도구와 격리 경계의 독립 검토도 PASS다.

이 PNG는 화면 구성 자료이며 실제 인증·저장·충돌·권한 검사를 대신하지 않는다. 실제 mock 로그인과 일회용 PG18의 동작은 PR64 인증·기록 33개 검사에서 확인했다. pending·conflict 화면을 만들기 위한 제품 DI나 액션 대체는 추가하지 않았다. 시스템 명조·손글씨의 기기별 재현은 별도 한계다. 실제 개발 앱은 아직 배포하지 않았다.

파일명은 `account-{read,empty,compose,delete,settings}-{375,768,1440}.png`다.
