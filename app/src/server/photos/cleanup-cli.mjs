/** 별도 purge 자격으로 한 batch만 실행한다. 스케줄/SET ROLE/meta 직접 조회는 하지 않는다. */
import pg from "pg";
import { parsePhotoConfig } from "./config-core.mjs";
import { createS3BlobStore } from "./blob-store.s3-core.mjs";
import { cleanupPhotos } from "./cleanup-core.mjs";

async function main(argv) {
  let db;
  let blobs;
  let stats;
  try {
    if (argv.length !== 2 || argv[0] !== "--limit" || !/^[0-9]{1,3}$/.test(argv[1])) throw new Error("invalid_limit");
    const limit = Number(argv[1]);
    if (limit < 1 || limit > 100) throw new Error("invalid_limit");
    const url = process.env.POD_PHOTO_CLEANUP_DATABASE_URL;
    const config = parsePhotoConfig(process.env);
    if (!url || !config.ok || !config.value) throw new Error("invalid_config");
    db = new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 5000, application_name: "pod-photo-cleanup" });
    db.on("error", () => undefined);
    blobs = createS3BlobStore(config.value);
    stats = await cleanupPhotos(db, blobs, { limit });
  } catch {
    console.error("photo-cleanup: unavailable");
    return 1;
  } finally {
    try { blobs?.destroy?.(); } catch { /* 종료 오류의 원문도 출력하지 않는다. */ }
    if (db) await db.end().catch(() => undefined);
  }
  console.log(JSON.stringify(stats));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
