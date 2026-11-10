/** Node CLI와 앱이 공유한다. env는 인자로만 받고 값·오류 원문을 기록하지 않는다. */
const KEYS = ["POD_PHOTOS_S3_ENDPOINT", "POD_PHOTOS_S3_REGION", "POD_PHOTOS_S3_BUCKET", "POD_PHOTOS_S3_ACCESS_KEY_ID", "POD_PHOTOS_S3_SECRET_ACCESS_KEY"];
const invalid = () => ({ ok: false, error: "invalid_photo_config" });
const validValue = (value) => typeof value === "string" && value !== "" && value === value.trim() && !/[\u0000-\u0020\u007f]/.test(value);

export function parsePhotoConfig(env) {
  const values = KEYS.map((key) => env[key]);
  if (values.every((value) => value === undefined)) return { ok: true, value: null };
  if (!values.every(validValue)) return invalid();
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket.includes("..") || /\.-|-\./.test(bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) return invalid();
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
