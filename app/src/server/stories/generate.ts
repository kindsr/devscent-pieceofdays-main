/**
 * 하루 이야기 생성(PLAN_ai-daily-story-storage §2). 생성기는 호출자가 주입한다. S1 제품 경로는 null이다.
 *
 * - 순서: subject → 날짜·미래(서울)·expectedInputRevision 형식 → active+gen → capture → 예상 revision →
 *   같은 revision 재사용 → 닫힌 생성기 → 20초 signal로 생성 → 결과 검사 → append(잠금·fence 재확인).
 * - stale·pending 계정은 capture와 생성기 전에 거부한다. 생성 중에는 DB 트랜잭션·잠금이 없다.
 * - 생성기에는 식별자 없는 {date, moments:[{time,text}]}만 넘긴다. 실패해도 기존 이야기·원본은 그대로다.
 * - 예상 밖 오류는 unavailable이다. 원문·stack을 결과나 로그에 남기지 않는다.
 */
import "server-only";
import { verifyActiveAccount, type SessionSubject } from "../account/lifecycle";
import type { Db } from "../db/pool";
import type { Result } from "../result";
import { parseLocalDate, seoulLocalDate } from "@/shared/local-date";
import { STORY_MAX, type StoryError, type StoryRef } from "@/shared/stories";
import type { StoryGenerator, StoryGeneratorError } from "./generator";
import { captureStoryInput, storyPayload } from "./input.pg";
import { appendStoryVersion, findStoryByRevision, isStorySubject } from "./store.pg";

export const STORY_GENERATE_TIMEOUT_MS = 20_000;

const REVISION = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const PORT_ERRORS: readonly string[] = ["unavailable", "timeout", "invalid_output"] satisfies StoryGeneratorError[];

const fail = <E extends string>(error: E) => ({ ok: false, error }) as const;

/** 일반 객체 또는 null-prototype 객체만 받는다. 배열·class 인스턴스·상속 객체는 거부한다. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 생성기 결과에서 자기 데이터 속성 body만 읽어 trim한 본문을 돌려준다. */
function storyBody(result: unknown): Result<string, StoryGeneratorError> {
  if (!isPlainRecord(result)) return fail("invalid_output");
  if (result.ok === false) {
    const error = result.error;
    return typeof error === "string" && PORT_ERRORS.includes(error) ? fail(error as StoryGeneratorError) : fail("unavailable");
  }
  if (result.ok !== true || !isPlainRecord(result.value)) return fail("invalid_output");
  const raw = Object.getOwnPropertyDescriptor(result.value, "body")?.value;
  if (typeof raw !== "string") return fail("invalid_output");
  // trim이 VT·FF 같은 제어 문자를 먼저 지우지 않도록 원본에서 검사한다(LF·CR·TAB만 허용).
  if (CONTROL.test(raw)) return fail("invalid_output");
  const body = raw.trim();
  if (body === "" || Array.from(body).length > STORY_MAX) return fail("invalid_output");
  return { ok: true, value: body };
}

export async function generateDailyStory(
  db: Db,
  generator: StoryGenerator | null,
  subject: SessionSubject,
  args: { date: string; expectedInputRevision: string | null },
  opts: { now?: () => Date } = {},
): Promise<Result<{ story: StoryRef; replayed: boolean }, StoryError>> {
  try {
    if (!isStorySubject(subject)) return fail("not_signed_in");
    const date = args?.date;
    const expected = args?.expectedInputRevision;
    const now = opts?.now ?? (() => new Date());
    if (typeof date !== "string" || parseLocalDate(date) === null || date > seoulLocalDate(now())) return fail("invalid_date");
    if (expected !== null && (typeof expected !== "string" || !REVISION.test(expected))) return fail("conflict");
    if (!(await verifyActiveAccount(db, subject))) return fail("not_signed_in");
    const input = await captureStoryInput(db, subject.userId, date);
    if (!input.ok) return input;
    const { revision } = input.value;
    if (expected !== null && expected !== revision) return fail("conflict");
    const existing = await findStoryByRevision(db, subject.userId, date, revision);
    if (existing) return { ok: true, value: { story: existing, replayed: true } };
    if (generator === null) return fail("unavailable");
    const result = await generator.generate(storyPayload(input.value), AbortSignal.timeout(STORY_GENERATE_TIMEOUT_MS));
    const body = storyBody(result);
    if (!body.ok) return body;
    return await appendStoryVersion(db, subject, date, revision, body.value);
  } catch {
    return fail("unavailable");
  }
}
