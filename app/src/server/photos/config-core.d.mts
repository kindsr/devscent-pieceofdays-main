export type PhotoConfig = Readonly<{
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;
export function parsePhotoConfig(env: Record<string, string | undefined>):
  { ok: true; value: PhotoConfig | null } | { ok: false; error: "invalid_photo_config" };
