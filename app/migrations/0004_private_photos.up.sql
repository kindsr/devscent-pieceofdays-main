-- 비공개 사진: journal은 객체가 늦게 도착해도 key를 잃지 않는다. 기존 0001~0003은 보존한다.
ALTER TABLE pod.diary_moments ADD CONSTRAINT diary_moments_id_user_unique UNIQUE (id, user_id);

CREATE TABLE pod.photo_uploads (
  id          uuid PRIMARY KEY,
  user_id     uuid NULL REFERENCES pod.users (id) ON DELETE SET NULL,
  request_id  uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  object_key  text NOT NULL UNIQUE CHECK (object_key ~ '^photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  status      text NOT NULL CHECK (status IN ('staged', 'ready', 'abandoned')),
  lease_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX photo_uploads_live_request_idx ON pod.photo_uploads (user_id, request_id)
  WHERE status IN ('staged', 'ready');
CREATE INDEX photo_uploads_request_history_idx ON pod.photo_uploads (user_id, request_id);
CREATE INDEX photo_uploads_staging_idx ON pod.photo_uploads (lease_until) WHERE status = 'staged';

CREATE TABLE pod.moment_photos (
  id          uuid PRIMARY KEY REFERENCES pod.photo_uploads (id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  moment_id   uuid NOT NULL UNIQUE,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type   text NOT NULL CHECK (mime_type = 'image/jpeg'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 4194304),
  width       integer NOT NULL CHECK (width BETWEEN 1 AND 2560),
  height      integer NOT NULL CHECK (height BETWEEN 1 AND 2560),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (moment_id, user_id) REFERENCES pod.diary_moments (id, user_id) ON DELETE CASCADE
);
CREATE INDEX moment_photos_user_idx ON pod.moment_photos (user_id);

-- 완료는 최근 부재 확인이다. 성공 뒤에도 행을 남겨 늦은 PUT을 다시 회수한다.
CREATE TABLE pod.photo_deletions (
  photo_id        uuid PRIMARY KEY,
  object_key      text NOT NULL UNIQUE CHECK (object_key ~ '^photos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_absent_at  timestamptz NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX photo_deletions_due_idx ON pod.photo_deletions (next_attempt_at, photo_id);

CREATE FUNCTION pod.journal_deleted_photo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  INSERT INTO pod.photo_deletions (photo_id, object_key)
    SELECT id, object_key FROM pod.photo_uploads WHERE id = OLD.id
    ON CONFLICT DO NOTHING;
  RETURN OLD;
END
$fn$;
REVOKE ALL ON FUNCTION pod.journal_deleted_photo() FROM PUBLIC;
CREATE TRIGGER moment_photos_journal_delete AFTER DELETE ON pod.moment_photos
  FOR EACH ROW EXECUTE FUNCTION pod.journal_deleted_photo();

-- metadata 확정 전의 계정 purge도 journal을 남긴다. 원본 메모/사용자 식별자는 남기지 않는다.
CREATE FUNCTION pod.journal_orphaned_photo_upload() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  INSERT INTO pod.photo_deletions (photo_id, object_key) VALUES (NEW.id, NEW.object_key)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION pod.journal_orphaned_photo_upload() FROM PUBLIC;
CREATE TRIGGER photo_uploads_journal_orphan AFTER UPDATE OF user_id ON pod.photo_uploads
  FOR EACH ROW WHEN (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL)
  EXECUTE FUNCTION pod.journal_orphaned_photo_upload();

CREATE FUNCTION pod.is_photo_cleanup_role() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT SESSION_USER::name = purge_role FROM pod_meta.db_environment
$fn$;
REVOKE ALL ON FUNCTION pod.is_photo_cleanup_role() FROM PUBLIC;

REVOKE ALL ON pod.photo_uploads, pod.moment_photos, pod.photo_deletions FROM PUBLIC;
DO $grant$
DECLARE
  app name;
  purge name;
BEGIN
  SELECT app_role, purge_role INTO STRICT app, purge FROM pod_meta.db_environment;
  EXECUTE format('GRANT SELECT, INSERT ON pod.photo_uploads TO %I', app);
  EXECUTE format('GRANT UPDATE (status, updated_at, lease_until) ON pod.photo_uploads TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.moment_photos TO %I', app);
  EXECUTE format('GRANT INSERT ON pod.photo_deletions TO %I', app);
  EXECUTE format('GRANT SELECT ON pod.photo_uploads, pod.moment_photos, pod.photo_deletions TO %I', purge);
  EXECUTE format('GRANT UPDATE (status, updated_at) ON pod.photo_uploads TO %I', purge);
  EXECUTE format('GRANT INSERT ON pod.photo_deletions TO %I', purge);
  EXECUTE format('GRANT UPDATE (next_attempt_at, last_absent_at, attempts) ON pod.photo_deletions TO %I', purge);
  EXECUTE format('REVOKE ALL ON FUNCTION pod.is_photo_cleanup_role() FROM %I', app);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pod.is_photo_cleanup_role() TO %I', purge);
END
$grant$;
