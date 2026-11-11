/**
 * AI 하루 이야기 동의 설정(PLAN_ai-story-live-generation §4.5).
 *
 * - 수동(직접 만들기)과 자동(회고 시간)은 따로 명시 동의하며 둘 다 기본 꺼짐이다.
 * - consent_version은 고지문(정책) 버전, consent_revision은 사용자 동의 epoch다. 저장할 때마다 epoch가 1 오르므로
 *   저장 전에 만든 job은 claim·송신 직전·완료 fence에서 모두 거부된다(다시 동의해도 옛 job은 보내거나 저장하지 않는다).
 * - auto_enabled_at은 자동을 새로 켤 때만 지금으로 정하고, 같은 정책에서 켜진 채 저장하면 유지한다.
 */
import "server-only";
import type { SessionSubject } from "../account/lifecycle";
import { withTransaction, type Db } from "../db/pool";
import type { Result } from "../result";
import { STORY_CONSENT_VERSION } from "@/shared/stories";
import { isStorySubject } from "./store.pg";

export type StoryAiSettings = { manualEnabled: boolean; autoEnabled: boolean };

const OFF: StoryAiSettings = { manualEnabled: false, autoEnabled: false };

function isInput(value: unknown): value is { manual: boolean; auto: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  const v = value as Record<string, unknown>;
  return keys.length === 2 && keys.includes("manual") && keys.includes("auto") && typeof v.manual === "boolean" && typeof v.auto === "boolean";
}

/** 행이 없거나 다른 정책 버전의 동의이면 둘 다 꺼진 것으로 본다. */
export async function getStoryAiSettings(db: Pick<Db, "query">, userId: string): Promise<StoryAiSettings> {
  const r = await db.query<{ manual_enabled: boolean; auto_enabled: boolean }>(
    "SELECT manual_enabled, auto_enabled FROM pod.story_ai_settings WHERE user_id = $1::uuid AND consent_version = $2",
    [userId, STORY_CONSENT_VERSION],
  );
  const row = r.rows[0];
  return row ? { manualEnabled: row.manual_enabled, autoEnabled: row.auto_enabled } : { ...OFF };
}

export async function saveStoryAiSettings(
  db: Db,
  subject: SessionSubject,
  input: unknown,
): Promise<Result<StoryAiSettings, "not_signed_in" | "invalid_input">> {
  if (!isStorySubject(subject)) return { ok: false, error: "not_signed_in" };
  if (!isInput(input)) return { ok: false, error: "invalid_input" };
  return withTransaction(db, async (tx) => {
    const locked = await tx.query(
      "SELECT 1 FROM pod.users WHERE id = $1::uuid AND status = 'active' AND auth_generation::bigint = $2::bigint FOR UPDATE",
      [subject.userId, subject.gen],
    );
    if (locked.rowCount !== 1) return { ok: false, error: "not_signed_in" } as const;
    const r = await tx.query<{ manual_enabled: boolean; auto_enabled: boolean }>(
      `INSERT INTO pod.story_ai_settings AS s (user_id, consent_version, consent_revision, manual_enabled, auto_enabled, auto_enabled_at, updated_at)
       VALUES ($1::uuid, $2, 1, $3::boolean, $4::boolean, CASE WHEN $4::boolean THEN now() END, now())
       ON CONFLICT (user_id) DO UPDATE SET
         consent_version = EXCLUDED.consent_version,
         consent_revision = s.consent_revision + 1,
         manual_enabled = EXCLUDED.manual_enabled,
         auto_enabled = EXCLUDED.auto_enabled,
         auto_enabled_at = CASE
           WHEN NOT EXCLUDED.auto_enabled THEN NULL
           WHEN s.auto_enabled AND s.consent_version = EXCLUDED.consent_version THEN s.auto_enabled_at
           ELSE now()
         END,
         updated_at = now()
       RETURNING manual_enabled, auto_enabled`,
      [subject.userId, STORY_CONSENT_VERSION, input.manual, input.auto],
    );
    const row = r.rows[0]!;
    return { ok: true, value: { manualEnabled: row.manual_enabled, autoEnabled: row.auto_enabled } } as const;
  });
}
