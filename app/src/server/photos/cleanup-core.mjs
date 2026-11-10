/** Node CLI와 server-only wrapper가 공유한다. DB/사진 port/시각을 인자로만 받는다. */
export async function cleanupPhotos(db, blobs, { limit, now = new Date() }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("photo_cleanup_unavailable");
  }
  // app/PUBLIC에는 EXECUTE가 없다. 실제 접속 역할을 확인하기 전에는 객체 I/O를 하지 않는다.
  const role = await db.query("SELECT pod.is_photo_cleanup_role() AS allowed");
  if (role.rows.length !== 1 || role.rows[0].allowed !== true) throw new Error("photo_cleanup_unavailable");
  const timestamp = now.toISOString();
  const stats = { processed: 0, deleted: 0, failed: 0, busy: 0 };
  const client = await db.connect();
  let candidates;
  let broken;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const selected = await client.query(
      `SELECT u.id::text, u.object_key, u.status, u.lease_until > $1::timestamptz AS live
         FROM pod.photo_uploads u
         LEFT JOIN pod.moment_photos p ON p.id = u.id
         LEFT JOIN pod.photo_deletions d ON d.photo_id = u.id
        WHERE p.id IS NULL AND (
          d.next_attempt_at <= $1::timestamptz
          OR (d.photo_id IS NULL AND (u.status = 'abandoned'
              OR (u.status = 'staged' AND u.lease_until <= $1::timestamptz))))
        ORDER BY COALESCE(d.next_attempt_at, u.lease_until), u.id LIMIT $2 FOR UPDATE OF u SKIP LOCKED`,
      [timestamp, limit],
    );
    candidates = [];
    for (const row of selected.rows) {
      stats.processed++;
      if (row.live) { stats.busy++; continue; }
      // 만료 token을 영구 fence한다. 확정 이력인 ready는 보존해 재전송이 조각을 되살리지 않는다.
      if (row.status === "staged") {
        await client.query("UPDATE pod.photo_uploads SET status = 'abandoned', updated_at = $2::timestamptz WHERE id = $1::uuid", [row.id, timestamp]);
      }
      await client.query("INSERT INTO pod.photo_deletions (photo_id, object_key) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING", [row.id, row.object_key]);
      await client.query(
        `UPDATE pod.photo_deletions SET attempts = attempts + 1,
                next_attempt_at = $2::timestamptz + interval '1 minute' WHERE photo_id = $1::uuid`,
        [row.id, timestamp],
      );
      candidates.push(row);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { broken = rollbackError instanceof Error ? rollbackError : new Error("photo_cleanup_unavailable"); }
    throw error;
  } finally { client.release(broken); }

  // 위의 journal fence/작업 예약을 커밋하고 모든 DB 잠금을 푼 뒤에만 S3를 호출한다.
  for (const row of candidates) {
    let absent = false;
    try {
      const signal = AbortSignal.timeout(15_000);
      await blobs.delete(row.object_key, signal);
      absent = await blobs.get(row.object_key, signal) === null;
    } catch {
      // 원문/사진/key를 출력하지 않는다. 실패도 tombstone의 다음 시도 대상으로 남는다.
    }
    await db.query(
      `UPDATE pod.photo_deletions SET last_absent_at = $2::timestamptz,
              next_attempt_at = $3::timestamptz + CASE WHEN $4::boolean THEN interval '1 day' ELSE interval '1 minute' END
        WHERE photo_id = $1::uuid`,
      [row.id, absent ? timestamp : null, timestamp, absent],
    );
    if (absent) stats.deleted++;
    else stats.failed++;
  }
  return stats;
}
