import Link from "next/link";
import { dateLabel, seoulLocalDate, seoulTime } from "@/shared/local-date";
import type { StoryDay, StoryGenerationView } from "@/shared/stories";

/*
 * AI 하루 이야기 읽기 영역(PLAN_ai-daily-story-view §1·§2, docs/design/story). 화면 자료만 받는다.
 * - data=null은 읽기 실패다. 저장된 글은 React text로만 렌더한다(HTML 해석 없음).
 * - 수정·삭제 버튼은 없다. generation(생성 상태)이 주어질 때만 생성 버튼·진행·실패·한도 안내를 더한다
 *   (PLAN_ai-story-live-generation §5). generation이 없으면 기존 읽기 화면과 같다.
 * - 버튼은 동의(ready 또는 재시도 가능한 실패)·조각 있음·현재 이야기가 아님일 때만 보인다(같은 입력의 유료 재생성 0).
 */
export function DailyStory({ date, data, reflectionTime, hasMoments, generation = null, requestAction, headingLevel = 2 }: {
  date: string;
  data: StoryDay | null;
  reflectionTime: string | null;
  hasMoments: boolean;
  generation?: StoryGenerationView | null;
  requestAction?: (formData: FormData) => void | Promise<void>;
  headingLevel?: 2 | 3;
}) {
  const story = data?.story ?? null;
  if (data && !story && !hasMoments) return null;
  const H = headingLevel === 3 ? "h3" : "h2";
  const id = `story-h-${date}`;
  const created = story ? new Date(story.createdAt) : null;
  return (
    <section className="story" aria-labelledby={id}>
      <H id={id}>AI 하루 이야기</H>
      {!data ? (
        <div className="diary-error">
          <p className="err">AI 하루 이야기를 불러오지 못했어요. 남긴 조각은 그대로예요.</p>
          <div className="row">
            <a className="text-btn" href={`/days/${date}`}>다시 불러오기</a>
          </div>
        </div>
      ) : story && created ? (
        <>
          <p className="hint">
            {data.state === "current"
              ? "AI가 이날 조각의 메모로 쓴 글이에요. 원본 조각은 아래에 그대로 있어요."
              : hasMoments
                ? "이 이야기를 만든 뒤 조각이 바뀌었어요. 지금 조각과 다를 수 있어요."
                : "이 날의 조각을 모두 지웠지만, 이전에 만든 이야기는 남아 있어요."}
            {` · ${dateLabel(seoulLocalDate(created))} ${seoulTime(created)}에 만들었어요`}
          </p>
          <p className="story-body">{story.body}</p>
        </>
      ) : generation && generation.state !== "off" && generation.state !== "unavailable" ? (
        <p className="hint">아직 만든 AI 하루 이야기가 없어요. 남긴 조각은 그대로 저장돼요.</p>
      ) : (
        <p className="hint">AI 하루 이야기는 아직 준비 중이에요. 남긴 조각은 그대로 저장돼요.</p>
      )}
      {data && generation ? (
        <StoryGeneration date={date} generation={generation} canMake={hasMoments && data.state !== "current"} requestAction={requestAction} />
      ) : null}
      <div className="row story-time">
        <p className="hint">{reflectionTime ? `회고 시간 ${reflectionTime} (한국 시간)` : "회고 시간을 확인하지 못했어요."}</p>
        <Link className="text-btn" href="/settings">{reflectionTime ? "회고 시간 바꾸기" : "설정에서 확인하기"}</Link>
      </div>
    </section>
  );
}

const FAILURE_TEXT: Partial<Record<string, string>> = {
  photo_unavailable: "사진을 읽지 못해 만들지 못했어요. 사진과 메모는 그대로예요.",
  input_changed: "만드는 동안 조각이 바뀌어 저장하지 않았어요.",
  consent_missing: "설정이 바뀌어 이번 이야기는 만들지 않았어요.",
};

/** 생성 상태 안내와 버튼. 서버 자료(generation)만 받고 원문 오류·식별자는 보이지 않는다. */
function StoryGeneration({ date, generation, canMake, requestAction }: {
  date: string;
  generation: StoryGenerationView;
  canMake: boolean;
  requestAction?: (formData: FormData) => void | Promise<void>;
}) {
  const button = requestAction && canMake && (generation.state === "ready" || (generation.state === "failed" && generation.canRetry)) ? (
    <form action={requestAction}>
      <button className="btn-ghost" type="submit">AI 이야기 만들기</button>
    </form>
  ) : null;
  switch (generation.state) {
    case "unavailable":
      return null;
    case "off":
      return (
        <div className="row story-generation">
          <Link className="text-btn" href="/settings#story-ai">AI 이야기 설정</Link>
        </div>
      );
    case "ready":
      return button ? <div className="row story-generation">{button}</div> : null;
    case "queued":
    case "running":
      return (
        <div className="row story-generation">
          <p className="hint" role="status">AI 하루 이야기를 만드는 중이에요. 1분쯤 뒤에 <a className="text-btn" href={`/days/${date}`}>새로고침</a>해 주세요.</p>
        </div>
      );
    case "failed":
      return (
        <div className="row story-generation">
          <p className="hint" role="status">{FAILURE_TEXT[generation.failure] ?? "AI 하루 이야기를 만들지 못했어요. 남긴 조각은 그대로예요."}</p>
          {button}
        </div>
      );
    case "limited":
      return (
        <div className="row story-generation">
          <p className="hint">오늘은 더 만들 수 없어요. 내일 다시 만들 수 있어요.</p>
        </div>
      );
  }
}
