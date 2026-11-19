/**
 * 페이지용 이야기 읽기(PLAN_ai-daily-story-view §2). React 컴포넌트가 아닌 일반 서버 함수다.
 *
 * - 사용자는 요청에서 cache된 getViewer로만 얻고, 반환값에는 화면 자료(StoryDay·회고 시각·날짜 목록)만 넣는다.
 *   Pool·subject·userId·gen과 원문 오류는 반환하지 않는다. 읽기 실패는 null(고정 안내용)이다.
 * - 읽는 중 세션이 무효화되면 signed_out을 돌려준다. 페이지는 try 밖에서 기존 login returnTo로 이동한다.
 */
import "server-only";
import { getReflectionTime } from "../account/reflection-time.pg";
import { getViewer } from "../context";
import { getAppDb } from "../db/pool";
import { dateParts } from "@/shared/local-date";
import type { StoryDay, StoryGenerationView } from "@/shared/stories";
import { listStoryDates } from "./calendar.pg";
import { parseClaudeConfig } from "./claude";
import { readStoryGeneration } from "./jobs.pg";
import { readStoryDay } from "./read";

/** generation은 생성 상태(PLAN_ai-story-live-generation §3). 읽지 못하면 null이며 버튼을 보이지 않는다. */
export type StoryView =
  | { kind: "signed_out" }
  | { kind: "ok"; data: StoryDay | null; reflectionTime: string | null; generation: StoryGenerationView | null };
export type StoryDatesView = { kind: "signed_out" } | { kind: "ok"; dates: string[] | null };

const pad = (n: number) => String(n).padStart(2, "0");

export async function readStoryView(date: string): Promise<StoryView> {
  const viewer = await getViewer();
  if (viewer.kind === "signed_out") return { kind: "signed_out" };
  if (viewer.kind !== "user") return { kind: "ok", data: null, reflectionTime: null, generation: null };
  const subject = { userId: viewer.userId, gen: viewer.gen };
  let data: StoryDay | null = null;
  try {
    const r = await readStoryDay(getAppDb(), subject, date);
    if (!r.ok && r.error === "not_signed_in") return { kind: "signed_out" };
    data = r.ok ? r.value : null;
  } catch {
    data = null;
  }
  let reflectionTime: string | null = null;
  try {
    reflectionTime = await getReflectionTime(getAppDb(), viewer.userId);
  } catch {
    // 조회 실패를 기본20:00으로 꾸미지 않는다.
  }
  let generation: StoryGenerationView | null = null;
  try {
    const claude = parseClaudeConfig(process.env);
    generation = await readStoryGeneration(getAppDb(), viewer.userId, date, claude.ok && claude.value !== null);
  } catch {
    // 생성 상태를 읽지 못하면 버튼·상태를 보이지 않는다. 저장된 글 읽기는 그대로다.
  }
  return { kind: "ok", data, reflectionTime, generation };
}

/** 달력 두 달(지난달 1일 ~ 다음 달 1일 전)의 이야기 날짜. 범위는 기존 thisMonth·lastMonth와 같다. */
export async function readStoryDates(today: string): Promise<StoryDatesView> {
  const viewer = await getViewer();
  if (viewer.kind === "signed_out") return { kind: "signed_out" };
  if (viewer.kind !== "user") return { kind: "ok", dates: null };
  const t = dateParts(today);
  const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
  const next = t.m === 12 ? { y: t.y + 1, m: 1 } : { y: t.y, m: t.m + 1 };
  try {
    const r = await listStoryDates(getAppDb(), { userId: viewer.userId, gen: viewer.gen }, `${prev.y}-${pad(prev.m)}-01`, `${next.y}-${pad(next.m)}-01`);
    if (!r.ok && r.error === "not_signed_in") return { kind: "signed_out" };
    return { kind: "ok", dates: r.ok ? r.value : null };
  } catch {
    return { kind: "ok", dates: null };
  }
}
