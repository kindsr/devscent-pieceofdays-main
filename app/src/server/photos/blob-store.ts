import "server-only";

export type NormalizedPhoto = {
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
  contentType: "image/jpeg";
};

/** key는 서버가 생성한 photos/<UUID>.jpg다. 저장소 오류는 원문 없는 예외다. */
export interface BlobStore {
  put(key: string, photo: NormalizedPhoto, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Buffer | null>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  destroy?(): void;
}
