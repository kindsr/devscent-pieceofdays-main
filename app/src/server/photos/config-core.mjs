/** Node CLI와 앱이 공유한다. env는 인자로만 받고 값·오류 원문을 기록하지 않는다. */
const KEYS = ["POD_PHOTOS_S3_ENDPOINT", "POD_PHOTOS_S3_REGION", "POD_PHOTOS_S3_BUCKET", "POD_PHOTOS_S3_ACCESS_KEY_ID", "POD_PHOTOS_S3_SECRET_ACCESS_KEY"];
const invalid = () => ({ ok: false, error: "invalid_photo_config" });
const validValue = (value) => typeof value === "string" && value !== "" && value === value.trim() && !/[\u0000-\u0020\u007f]/.test(value);

// PLAN_dev-minio-story-runtime §1.4: 명시 flag가 있을 때만 dev front 내부 relay의 HTTP 한 형태를 허용한다.
const RELAY_FLAG = "POD_PHOTOS_INTERNAL_DEV_HTTP";
const DEV_ORIGIN = "https://dev.pieceofdays.com";
const RELAY = /^http:\/\/(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.11:8081\/$/;

/** 정규형 RFC1918 IPv4의 끝 octet 11·port 8081·root만. 이름·다른 주소·path/query/userinfo는 거부한다. */
function isRelayEndpoint(endpoint) {
  const match = RELAY.exec(endpoint);
  if (!match) return false;
  const [a, b, c] = match.slice(1).map(Number);
  if (b > 255 || c > 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function parsePhotoConfig(env) {
  const values = KEYS.map((key) => env[key]);
  const flag = env[RELAY_FLAG];
  if (flag !== undefined && flag !== "1") return invalid();
  if (values.every((value) => value === undefined)) return flag === undefined ? { ok: true, value: null } : invalid();
  if (!values.every(validValue)) return invalid();
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket.includes("..") || /\.-|-\./.test(bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) return invalid();
  if (flag === "1") {
    if (env.NODE_ENV !== "production" || env.POD_AUTH_BASE_URL !== DEV_ORIGIN || !isRelayEndpoint(endpoint)) return invalid();
    return { ok: true, value: { endpoint, region, bucket, accessKeyId, secretAccessKey } };
  }
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || /^https?:\/\/[^/?#]*@/.test(endpoint) || url.search || url.hash || url.pathname !== "/" || !/^https?:\/\/[^/?#]+\/?$/.test(endpoint)) return invalid();
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    const isolated = ["development", "test"].includes(env.NODE_ENV) && env.POD_FULL_CHECK_ISOLATED === "1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && isolated)) return invalid();
  } catch {
    return invalid();
  }
  return { ok: true, value: { endpoint, region, bucket, accessKeyId, secretAccessKey } };
}
