import Link from "next/link";
import { dateLabel, seoulLocalDate, seoulTime } from "@/shared/local-date";
import type { StoryDay } from "@/shared/stories";

/*
 * AI 하루 이야기 읽기 영역(PLAN_ai-daily-story-view §1·§2, docs/design/story). 화면 자료만 받는다.
 * - data=null은 읽기 실패다. 저장된 글은 React text로만 렌더한다(HTML 해석 없음).
 * - 생성·수정·삭제 버튼은 없다. 생성은 동의·예약·비용 한도(후속 계약) 뒤에 연결한다.
 */
export function DailyStory({ date, data, reflectionTime, hasMoments, headingLevel = 2 }: {
  date: string;
  data: StoryDay | null;
  reflectionTime: string | null;
  hasMoments: boolean;
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
      ) : (
        <p className="hint">AI 하루 이야기는 아직 준비 중이에요. 남긴 조각은 그대로 저장돼요.</p>
      )}
      <div className="row story-time">
        <p className="hint">{reflectionTime ? `회고 시간 ${reflectionTime} (한국 시간)` : "회고 시간을 확인하지 못했어요."}</p>
        <Link className="text-btn" href="/settings">{reflectionTime ? "회고 시간 바꾸기" : "설정에서 확인하기"}</Link>
      </div>
    </section>
  );
}
