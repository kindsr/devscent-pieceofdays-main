import type { PhotoConfig } from "./config-core.mjs";
import type { BlobStore } from "./blob-store";
export function createS3BlobStore(config: PhotoConfig): BlobStore;
