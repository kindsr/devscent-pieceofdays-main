import type { SampleImageKey } from "@/shared/diary";

/** 앱 동봉 예시 이미지(D 시안에서 직접 그린 SVG). 실제 사진이 아니다. */
export const SAMPLE_IMAGES: Record<SampleImageKey, { src: string; alt: string; name: string }> = {
  window: { src: "/sample/window.svg", alt: "예시 이미지: 아침 햇빛이 드는 창가와 커튼, 창밖 지붕", name: "창가" },
  noodle: { src: "/sample/noodle.svg", alt: "예시 이미지: 나무 식탁 위 멸치국수 한 그릇과 젓가락", name: "국수" },
  ginkgo: { src: "/sample/ginkgo.svg", alt: "예시 이미지: 반쯤 노랗게 물든 은행나무 길과 벤치", name: "은행나무" },
};
