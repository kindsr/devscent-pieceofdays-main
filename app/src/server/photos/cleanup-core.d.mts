import type { Db } from "../db/pool";
import type { BlobStore } from "./blob-store";

export type PhotoCleanupStats = { processed: number; deleted: number; failed: number; busy: number };
export function cleanupPhotos(db: Db, blobs: BlobStore, options: { limit: number; now?: Date }): Promise<PhotoCleanupStats>;
