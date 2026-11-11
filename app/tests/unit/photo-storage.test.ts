// PLAN_dev-minio-story-runtime §1.4 RED. dev 전용 내부 relay HTTP 예외(정확 1형태)만 시험한다.
// 기존 HTTPS/격리 loopback 계약은 photo-input.test.ts가 고정한다. 가짜 설정만 쓴다.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "./auth-b1-support";

type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };
type PhotoConfig = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
type ParseConfig = (env: Record<string, string | undefined>) => Result<PhotoConfig | null, "invalid_photo_config">;

const CONFIG = path.join(APP_DIR, "src", "server", "photos", "config.ts");
const INVALID = { ok: false, error: "invalid_photo_config" };
const FLAG = "POD_PHOTOS_INTERNAL_DEV_HTTP";
const DEV_BASE = "https://dev.pieceofdays.com";
const RELAY = "http://10.231.17.11:8081/";
const PHOTOS = {
  POD_PHOTOS_S3_ENDPOINT: RELAY,
  POD_PHOTOS_S3_REGION: "us-east-1",
  POD_PHOTOS_S3_BUCKET: "pieceofdays-photos-dev",
  POD_PHOTOS_S3_ACCESS_KEY_ID: "ci-only-relay-access",
  POD_PHOTOS_S3_SECRET_ACCESS_KEY: "ci-only-relay-secret-not-production",
};
/** 배포 앱 컨테이너와 같은 실행 조건(이미지 NODE_ENV=production, dev origin, 명시 flag). */
const RUNTIME = { NODE_ENV: "production", POD_AUTH_BASE_URL: DEV_BASE, [FLAG]: "1", ...PHOTOS };

async function parser(): Promise<ParseConfig> {
  let mod: Record<string, unknown> = {};
  try {
    mod = await import(/* @vite-ignore */ CONFIG);
  } catch (err) {
    if (existsSync(CONFIG)) throw err;
  }
  expect(typeof mod.parsePhotoConfig, "server/photos/config.ts must export function parsePhotoConfig").toBe("function");
  return mod.parsePhotoConfig as ParseConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dev-only internal relay HTTP photo endpoint", () => {
  it("accepts exactly the explicit dev relay endpoint and returns only the five server-side fields", async () => {
    const parse = await parser();
    const expected = { ok: true, value: { endpoint: RELAY, region: PHOTOS.POD_PHOTOS_S3_REGION, bucket: PHOTOS.POD_PHOTOS_S3_BUCKET,
      accessKeyId: PHOTOS.POD_PHOTOS_S3_ACCESS_KEY_ID, secretAccessKey: PHOTOS.POD_PHOTOS_S3_SECRET_ACCESS_KEY } };
    expect(parse(RUNTIME)).toEqual(expected);
    // 다른 RFC1918 /24의 +11도 같은 형태다(실제 front_subnet 값은 helper가 정확 비교).
    for (const endpoint of ["http://172.20.5.11:8081/", "http://192.168.77.11:8081/", "http://10.0.0.11:8081/"]) {
      expect(parse({ ...RUNTIME, POD_PHOTOS_S3_ENDPOINT: endpoint }), endpoint).toEqual({ ...expected, value: { ...expected.value, endpoint } });
    }
  });

  it("keeps ordinary HTTPS working without the flag and refuses the relay endpoint without the exact flag", async () => {
    const parse = await parser();
    expect(parse({ ...RUNTIME, [FLAG]: undefined, POD_PHOTOS_S3_ENDPOINT: "https://photos.example/" })).toMatchObject({ ok: true, value: { endpoint: "https://photos.example/" } });
    expect(parse({ ...RUNTIME, [FLAG]: undefined }), "relay HTTP without flag").toEqual(INVALID);
    for (const value of ["0", "true", "yes", "01", "1 ", " 1", "", "11"]) {
      expect(parse({ ...RUNTIME, [FLAG]: value }), `flag ${JSON.stringify(value)}`).toEqual(INVALID);
    }
    // 오타 키는 flag가 아니다.
    expect(parse({ ...RUNTIME, [FLAG]: undefined, POD_PHOTOS_INTERNAL_DEV_HTTPS: "1" }), "flag typo").toEqual(INVALID);
  });

  it("refuses the flag when photos are unconfigured or the endpoint is HTTPS", async () => {
    const parse = await parser();
    expect(parse({ NODE_ENV: "production", POD_AUTH_BASE_URL: DEV_BASE, [FLAG]: "1" }), "flag without photo settings").toEqual(INVALID);
    for (const endpoint of ["https://photos.example/", "https://10.231.17.11:8081/"]) {
      expect(parse({ ...RUNTIME, POD_PHOTOS_S3_ENDPOINT: endpoint }), `flag with ${endpoint}`).toEqual(INVALID);
    }
  });

  it("allows the relay only in the production image runtime with the exact dev origin", async () => {
    const parse = await parser();
    for (const NODE_ENV of ["development", "test", "staging", undefined]) {
      expect(parse({ ...RUNTIME, NODE_ENV }), `NODE_ENV ${NODE_ENV}`).toEqual(INVALID);
      expect(parse({ ...RUNTIME, NODE_ENV, POD_FULL_CHECK_ISOLATED: "1" }), `isolated NODE_ENV ${NODE_ENV}`).toEqual(INVALID);
    }
    for (const base of [undefined, "https://pieceofdays.com", "https://dev.pieceofdays.com/", "http://dev.pieceofdays.com", "https://DEV.pieceofdays.com", "https://dev.pieceofdays.com:443", "https://dev.pieceofdays.com.evil.example"]) {
      expect(parse({ ...RUNTIME, POD_AUTH_BASE_URL: base }), `base ${base}`).toEqual(INVALID);
    }
  });

  it("refuses names, non-RFC1918 or non-canonical addresses, other octets/ports and any path, query, fragment or userinfo", async () => {
    const parse = await parser();
    for (const endpoint of [
      "http://pieceofdays-frontend-dev:8081/", "http://minio:9000/", "http://localhost:8081/",
      "http://10.231.17.10:8081/", "http://10.231.17.12:8081/", "http://10.231.17.111:8081/", "http://10.231.17.1:8081/",
      "http://10.231.17.11:8080/", "http://10.231.17.11:80/", "http://10.231.17.11/", "http://10.231.17.11:08081/", "http://10.231.17.11:9000/",
      "http://8.8.8.11:8081/", "http://100.64.0.11:8081/", "http://172.32.0.11:8081/", "http://172.15.0.11:8081/", "http://169.254.0.11:8081/",
      "http://127.0.0.11:8081/", "http://0.0.0.11:8081/", "http://192.169.0.11:8081/",
      "http://010.231.17.11:8081/", "http://10.231.017.11:8081/", "http://10.231.17.011:8081/", "http://0x0a.231.17.11:8081/",
      "http://182915339:8081/", "http://10.231.4363:8081/", "http://[::ffff:10.231.17.11]:8081/", "http://[fd00::11]:8081/",
      "http://10.231.17.11:8081/pieceofdays-photos-dev", "http://10.231.17.11:8081//", "http://10.231.17.11:8081/?x-id=GetObject",
      "http://10.231.17.11:8081/#f", "http://user:ci-only-pass@10.231.17.11:8081/", "http://@10.231.17.11:8081/",
      "HTTP://10.231.17.11:8081/", "http://10.231.17.11.:8081/", "http://10.231.17.11:8081/%2e/",
    ]) expect(parse({ ...RUNTIME, POD_PHOTOS_S3_ENDPOINT: endpoint }), endpoint).toEqual(INVALID);
  });

  it("never logs the relay credentials while accepting or refusing", async () => {
    const parse = await parser();
    const logs: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
    parse(RUNTIME);
    parse({ ...RUNTIME, [FLAG]: undefined });
    parse({ ...RUNTIME, POD_PHOTOS_S3_ENDPOINT: "http://8.8.8.11:8081/" });
    expect(JSON.stringify(logs)).not.toContain(PHOTOS.POD_PHOTOS_S3_SECRET_ACCESS_KEY);
    expect(JSON.stringify(logs)).not.toContain(PHOTOS.POD_PHOTOS_S3_ACCESS_KEY_ID);
  });
});
