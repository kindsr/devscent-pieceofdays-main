import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

const MAX_BYTES = 4 * 1024 * 1024;
const KEY = /^photos\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg$/;
const unavailable = () => new Error("photo_store_unavailable");

/** 자격은 명시한 전용 설정만 쓴다. SDK 자동 재시도·기본 자격 탐색은 사용하지 않는다. */
export function createS3BlobStore(config) {
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 5000, requestTimeout: 10_000,
      httpAgent: new HttpAgent({ keepAlive: false, maxSockets: 1 }),
      httpsAgent: new HttpsAgent({ keepAlive: false, maxSockets: 1 }) },
  });

  async function bounded(key, signal, run) {
    if (typeof key !== "string" || key.length !== 47 || !KEY.test(key) || signal?.aborted) throw unavailable();
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
    const abort = () => { controller.abort(); rejectDeadline(unavailable()); };
    const timer = setTimeout(abort, 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      return await Promise.race([run(controller.signal), deadline]);
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    destroy() { client.destroy(); },
    async put(key, photo, signal) {
      if (!Buffer.isBuffer(photo?.bytes) || photo.bytes.length < 1 || photo.bytes.length > MAX_BYTES || photo.contentType !== "image/jpeg") throw unavailable();
      await bounded(key, signal, (abortSignal) => client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: photo.bytes, ContentLength: photo.bytes.length, ContentType: "image/jpeg",
      }), { abortSignal }));
    },
    async get(key, signal) {
      return bounded(key, signal, async (abortSignal) => {
        let response;
        try {
          response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal });
        } catch (error) {
          if (!abortSignal.aborted && error?.name === "NoSuchKey") return null;
          throw unavailable();
        }
        const body = response.Body;
        const destroy = () => body?.destroy();
        abortSignal.addEventListener("abort", destroy, { once: true });
        try {
          if (!body || !body[Symbol.asyncIterator] || abortSignal.aborted || response.ContentLength > MAX_BYTES) throw unavailable();
          const chunks = [];
          let size = 0;
          for await (const chunk of body) {
            if (abortSignal.aborted || !(chunk instanceof Uint8Array)) throw unavailable();
            size += chunk.byteLength;
            if (size > MAX_BYTES) throw unavailable();
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks, size);
        } finally {
          abortSignal.removeEventListener("abort", destroy);
          destroy();
        }
      });
    },
    async delete(key, signal) {
      await bounded(key, signal, (abortSignal) => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal }));
    },
  };
}
