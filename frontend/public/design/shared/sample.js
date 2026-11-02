/* pieceofdays 시안 공통 샘플 — 3안이 같은 하루를 그린다. 실제 사용자 기록이 아닌 예시다. */
(function () {
  "use strict";
  var IMG = {
    window: { src: "../shared/img/window.svg", alt: "예시 이미지: 아침 햇빛이 드는 창가와 커튼, 창밖 지붕" },
    noodle: { src: "../shared/img/noodle.svg", alt: "예시 이미지: 나무 식탁 위 멸치국수 한 그릇과 젓가락" },
    ginkgo: { src: "../shared/img/ginkgo.svg", alt: "예시 이미지: 반쯤 노랗게 물든 은행나무 길과 벤치" }
  };

  window.POD_SAMPLE = {
    today: "2026-11-02",
    images: IMG,
    days: [
      {
        date: "2026-11-02",
        summary: "쌀쌀해진 아침으로 시작해 따뜻한 국수와 노란 은행나무 길로 이어진 하루. 저녁에는 엄마와 통화하며 김장 날짜를 정했다. 겨울 준비를 시작한 날로 기억하고 싶다.",
        moments: [
          { time: "07:40", text: "창문을 열었더니 공기가 차가워졌다. 올해 처음으로 두꺼운 가디건을 꺼냈다.", img: "window" },
          { time: "12:15", text: "동네 국숫집 줄이 생각보다 짧았다. 멸치 국물 한 그릇에 몸이 풀렸다.", img: "noodle" },
          { time: "16:30", text: "공원 은행나무 길이 반쯤 노랗다. 다음 주면 다 물들 것 같다.", img: "ginkgo" },
          { time: "21:10", text: "엄마와 20분 통화. 김장은 셋째 주 토요일로 정했다.", img: null }
        ]
      },
      {
        date: "2026-11-01",
        summary: "늦잠을 자고 오후 내내 책을 읽었다. 아무것도 하지 않은 일요일이 오랜만에 좋았다.",
        moments: [
          { time: "10:20", text: "알람 없이 일어났다. 커튼 사이로 해가 길게 들어왔다.", img: "window" },
          { time: "15:05", text: "읽다 만 소설을 끝까지 읽었다. 마지막 장에서 한참 멈췄다.", img: null }
        ]
      },
      {
        date: "2026-10-30",
        summary: "",
        moments: [
          { time: "19:45", text: "퇴근길 버스에서 본 노을. 사진은 못 찍었지만 오래 기억날 것 같다.", img: null }
        ]
      },
      {
        date: "2026-10-28",
        summary: "회의가 길었던 수요일. 점심 산책 덕분에 버텼다.",
        moments: [
          { time: "09:10", text: "오전 회의가 예상보다 두 시간 길어졌다.", img: null },
          { time: "12:40", text: "점심 먹고 공원을 한 바퀴. 은행잎이 막 노래지기 시작했다.", img: "ginkgo" },
          { time: "22:00", text: "내일 할 일 세 가지만 적고 잤다.", img: null }
        ]
      }
    ]
  };
})();
