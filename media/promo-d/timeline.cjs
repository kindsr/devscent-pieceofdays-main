/* 영상 타이밍 정본(초). build.cjs(index.html 생성)와 sfx.cjs(클릭음 트랙)가 함께 읽는다.
   좌표는 실제 D 화면 캡처(assets/capture/manifest.json)의 페이지 CSS px를 쓰고 여기서는 시간만 정한다. */
"use strict";
module.exports = {
  duration: 20,
  fps: 30,
  // 카피는 이 문자열 그대로(줄바꿈만 허용). build.cjs가 화면 텍스트와 대조한다.
  copy: "개인의 일상에서 순간을 기록하고 하루를 정리하여 스토리텔링을 만들어가는 감정정리 장소, pieceofdays",
  copyLines: ["개인의 일상에서", "순간을 기록하고", "하루를 정리하여", "스토리텔링을 만들어가는", "감정정리 장소, pieceofdays"],
  // 진행 중 의미 단위 자막(copyLines[0..3]) 구간
  captions: [
    { line: 0, start: 0.2, end: 2.45 },
    { line: 1, start: 2.45, end: 7.0 },
    { line: 2, start: 7.0, end: 12.45 },
    { line: 3, start: 12.45, end: 15.2 }
  ],
  // 화면 상태(still)와 구간. 다음 상태는 앞 클릭의 release 프레임에 바뀐다.
  states: [
    { id: "s0_board", start: 0 },
    { id: "s1_compose", start: 2.4 },
    { id: "s2_added", start: 6.2 },
    { id: "s3_editing", start: 8.55 },
    { id: "s4_summary", start: 11.95 },
    { id: "s5_days", start: 13.25 },
    { id: "s6_picked", start: 14.25 }
  ],
  // 카드 안 페이지 스크롤(CSS px). 클릭 중에는 움직이지 않는다.
  scroll: [
    { t0: 0.8, t1: 2.0, to: 484 },
    { t0: 7.0, t1: 7.7, to: 0 },
    { t0: 14.35, t1: 14.95, to: 931 } // 앱이 scrollIntoView로 옮기는 실제 위치
  ],
  // 실제 클릭(capture.cjs의 action id). arrive: 커서 도착, press: 0.1s 압축 시작, release = press+0.1
  clicks: [
    { id: "c1_addtile", moveFrom: 1.25, arrive: 2.15, press: 2.3, ease: "power3.out" },
    { id: "c2_submit", moveFrom: 5.35, arrive: 5.95, press: 6.1 },
    { id: "c3_sumedit", moveFrom: 7.75, arrive: 8.3, press: 8.45 },
    { id: "c4_apply", moveFrom: 11.15, arrive: 11.7, press: 11.85 },
    { id: "c5_days", moveFrom: 12.45, arrive: 13.0, press: 13.15 },
    { id: "c6_nov1", moveFrom: 13.45, arrive: 14.0, press: 14.15 }
  ],
  pressDur: 0.1,
  releaseDur: 0.2,
  // 커서가 타이핑 중 비켜서는 등 클릭 외 이동(루트 px, 포인터 끝 기준)
  cursorMoves: [
    { t0: 0, t1: 0, to: [720, 2060] },
    { t0: 2.65, t1: 3.25, to: [990, 1250] },
    { t0: 6.35, t1: 6.95, to: [430, 1745] },
    { t0: 8.7, t1: 9.2, to: [992, 1430] },
    { t0: 14.5, t1: 15.1, to: [330, 2080], ease: "power2.in" }
  ],
  // 실제 타이핑 crop 재생 시작과 음절당 간격
  typing: [
    { id: "t1_memo", start: 3.05, step: 0.1 },
    { id: "t2_summary", start: 9.05, step: 0.1 }
  ],
  outro: { cardStart: 15.1, cardDur: 0.8, cardScale: 0.66, linesStart: 15.45, lineStagger: 0.14, lineDur: 0.6, squiggleStart: 16.35, squiggleDur: 0.6 }
};
