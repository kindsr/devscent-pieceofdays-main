/** 사진 journal의 짧은 DB 단계. 객체 I/O는 이 모듈의 트랜잭션 밖에서 한다. */
import "server-only";
import { randomUUID } from "node:crypto";
import type { PhotoError } from "@/shared/photos";
import { seoulLocalDate } from "@/shared/local-date";
import { withTransaction, type Db, type Tx } from "../db/pool";
import type { SessionSubject } from "../account/lifecycle";
import type { MomentRef } from "../diary/store";
import type { Result } from "../result";
import type { NormalizedPhoto } from "./blob-store";

export type UploadReservation = { id: string; key: string; token: string };
type Reserved = { kind: "reserved"; upload: UploadReservation } | { kind: "replayed"; moment: MomentRef };
type UploadRow = { id: string; object_key: string; lease_token: string; fingerprint: string; status: string; live: boolean };

async function lockActiveUser(tx: Tx, viewer: SessionSubject): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM pod.users
      WHERE id = $1::uuid AND status = 'active' AND auth_generation::bigint = $2::bigint FOR UPDATE`,
    [viewer.userId, viewer.gen],
  );
  return r.rowCount === 1;
}

async function enqueue(tx: Tx, id: string, key: string): Promise<void> {
  // 앱에는 INSERT만 있다. 충돌 때 기존 tombstone을 읽거나 갱신하지 않는다.
  await tx.query("INSERT INTO pod.photo_deletions (photo_id, object_key) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING", [id, key]);
}

export async function reservePhotoUpload(
  db: Db, viewer: SessionSubject, requestId: string, fingerprint: string,
): Promise<Result<Reserved, PhotoError>> {
  return withTransaction(db, async (tx) => {
    if (!(await lockActiveUser(tx, viewer))) return { ok: false, error: "not_signed_in" };
    const history = await tx.query<UploadRow>(
      `SELECT id::text, object_key, lease_token::text, fingerprint, status,
              lease_until > clock_timestamp() AS live
         FROM pod.photo_uploads WHERE user_id = $1::uuid AND request_id = $2::uuid
        ORDER BY created_at, id FOR UPDATE`,
      [viewer.userId, requestId],
    );
    if (history.rows.some((row) => row.fingerprint !== fingerprint)) return { ok: false, error: "conflict" };
    const ready = history.rows.find((row) => row.status === "ready");
    if (ready) {
      const result = await tx.query<{ id: string }>(
        "SELECT moment_id::text AS id FROM pod.moment_photos WHERE id = $1::uuid AND user_id = $2::uuid",
        [ready.id, viewer.userId],
      );
      const moment = result.rows[0];
      // 삭제한 조각을 불확실한 재전송으로 되살리지 않는다. 최초 확정 ref의 버전은 1이다.
      if (!moment) return { ok: false, error: "unavailable" };
      return { ok: true, value: { kind: "replayed", moment: { id: moment.id, version: 1 } } };
    }
    if (history.rows.some((row) => row.status === "staged" && row.live)) return { ok: false, error: "busy" };
    for (const row of history.rows.filter((row) => row.status === "staged")) {
      await tx.query("UPDATE pod.photo_uploads SET status = 'abandoned', updated_at = clock_timestamp() WHERE id = $1::uuid", [row.id]);
      await enqueue(tx, row.id, row.object_key);
    }
    const upload = { id: randomUUID(), key: `photos/${randomUUID()}.jpg`, token: randomUUID() };
    await tx.query(
      `INSERT INTO pod.photo_uploads (id, user_id, request_id, fingerprint, object_key, status, lease_token, lease_until)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'staged', $6::uuid, clock_timestamp() + interval '1 minute')`,
      [upload.id, viewer.userId, requestId, fingerprint, upload.key, upload.token],
    );
    return { ok: true, value: { kind: "reserved", upload } };
  });
}

export async function completePhotoUpload(
  db: Db, viewer: SessionSubject, upload: UploadReservation, memo: string, photo: NormalizedPhoto,
): Promise<Result<MomentRef, PhotoError>> {
  return withTransaction(db, async (tx) => {
    if (!(await lockActiveUser(tx, viewer))) return { ok: false, error: "not_signed_in" };
    const current = await tx.query(
      `SELECT 1 FROM pod.photo_uploads
        WHERE id = $1::uuid AND user_id = $2::uuid AND lease_token = $3::uuid
          AND status = 'staged' AND lease_until > clock_timestamp() FOR UPDATE`,
      [upload.id, viewer.userId, upload.token],
    );
    if (current.rowCount !== 1) return { ok: false, error: "unavailable" };
    const occurredAt = new Date();
    const result = await tx.query<MomentRef>(
      `INSERT INTO pod.diary_moments (user_id, local_date, occurred_at, time_zone, body)
       VALUES ($1::uuid, $2::date, $3::timestamptz, 'Asia/Seoul', $4) RETURNING id::text AS id, version`,
      [viewer.userId, seoulLocalDate(occurredAt), occurredAt.toISOString(), memo],
    );
    const moment = result.rows[0];
    if (!moment) throw new Error("photo_store_unavailable");
    await tx.query(
      `INSERT INTO pod.moment_photos (id, user_id, moment_id, sha256, mime_type, byte_length, width, height)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'image/jpeg', $5, $6, $7)`,
      [upload.id, viewer.userId, moment.id, photo.sha256, photo.bytes.length, photo.width, photo.height],
    );
    await tx.query(
      "UPDATE pod.photo_uploads SET status = 'ready', lease_until = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1::uuid",
      [upload.id],
    );
    return { ok: true, value: moment };
  });
}

/** COMMIT 응답 손실 때 이미 ready인 객체를 삭제 대상으로 바꾸지 않는다. 실패해도 원래 journal은 남는다. */
export async function abandonPhotoUpload(db: Db, upload: UploadReservation): Promise<void> {
  await withTransaction(db, async (tx) => {
    const abandoned = await tx.query(
      `UPDATE pod.photo_uploads SET status = 'abandoned', updated_at = clock_timestamp()
        WHERE id = $1::uuid AND lease_token = $2::uuid AND status = 'staged' RETURNING id`,
      [upload.id, upload.token],
    );
    if (abandoned.rowCount === 1) await enqueue(tx, upload.id, upload.key);
  });
}

export type OwnedPhoto = {
  id: string; object_key: string; sha256: string; byte_length: number; width: number; height: number;
};

export async function findOwnedPhoto(db: Pick<Db, "query">, viewer: SessionSubject, id: string): Promise<OwnedPhoto | null> {
  const result = await db.query<OwnedPhoto>(
    `SELECT p.id::text, u.object_key, p.sha256, p.byte_length, p.width, p.height
       FROM pod.moment_photos p
       JOIN pod.photo_uploads u ON u.id = p.id AND u.user_id = p.user_id AND u.status = 'ready'
       JOIN pod.diary_moments m ON m.id = p.moment_id AND m.user_id = p.user_id
       JOIN pod.users a ON a.id = p.user_id
      WHERE p.id = $1::uuid AND p.user_id = $2::uuid AND a.status = 'active'
        AND a.auth_generation::bigint = $3::bigint`,
    [id, viewer.userId, viewer.gen],
  );
  return result.rows[0] ?? null;
}
