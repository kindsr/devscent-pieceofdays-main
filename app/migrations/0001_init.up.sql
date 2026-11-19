-- 0001_init: DATA_CONTRACT §2~§6. 실행기가 BEGIN·advisory lock·SET LOCAL ROLE owner 안에서 실행한다.
-- role 이름은 pod_meta.db_environment에서 읽어 format('%I')로 GRANT한다(환경과 무관한 같은 파일).

CREATE SCHEMA pod;
REVOKE ALL ON SCHEMA pod FROM PUBLIC;

-- §4.1
CREATE TABLE pod.users (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  first_login_at timestamptz NULL
);

-- §4.2
CREATE TABLE pod.auth_identities (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  subject    text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX auth_identities_user_id_idx ON pod.auth_identities (user_id);

-- §4.7 (preferences의 복합 외래키 대상이라 먼저 만든다)
CREATE TABLE pod.design_versions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id   uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  manifest   jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND manifest ? 'schema' AND manifest ? 'base'),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id)
);
CREATE INDEX design_versions_owner_created_idx ON pod.design_versions (owner_id, created_at DESC);

-- §4.3
CREATE TABLE pod.preferences (
  user_id                   uuid PRIMARY KEY REFERENCES pod.users (id) ON DELETE CASCADE,
  font_key                  text NOT NULL DEFAULT 'gothic' CHECK (font_key IN ('gothic', 'serif', 'hand')),
  applied_design_version_id uuid NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (applied_design_version_id, user_id) REFERENCES pod.design_versions (id, owner_id)
    ON DELETE SET NULL (applied_design_version_id)
);

-- §4.4
CREATE TABLE pod.diary_moments (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  local_date  date NOT NULL,
  occurred_at timestamptz NOT NULL,
  time_zone   text NOT NULL DEFAULT 'Asia/Seoul' CHECK (time_zone = 'Asia/Seoul'),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300 AND btrim(body) <> ''),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX diary_moments_user_day_idx ON pod.diary_moments (user_id, local_date, occurred_at, id);

-- §4.5
CREATE TABLE pod.day_summaries (
  user_id    uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  local_date date NOT NULL,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300 AND btrim(body) <> ''),
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, local_date)
);

-- §4.8
CREATE TABLE pod.credit_accounts (
  user_id    uuid PRIMARY KEY REFERENCES pod.users (id) ON DELETE RESTRICT,
  balance    integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pod.emotion_ledger (
  entry_id   uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES pod.credit_accounts (user_id) ON DELETE RESTRICT,
  delta      integer NOT NULL CHECK (delta <> 0),
  reason     text NOT NULL CHECK (reason IN ('first_login_grant')),
  grant_key  text NOT NULL UNIQUE CHECK (char_length(grant_key) BETWEEN 1 AND 200),
  ref_type   text NULL,
  ref_id     uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'first_login_grant'
         OR (delta = 10 AND grant_key = 'first_login:' || user_id::text AND ref_type IS NULL AND ref_id IS NULL))
);
CREATE UNIQUE INDEX emotion_ledger_first_login_grant_uidx ON pod.emotion_ledger (user_id) WHERE reason = 'first_login_grant';
CREATE INDEX emotion_ledger_user_created_idx ON pod.emotion_ledger (user_id, created_at);

-- append-only 보호(owner 포함 모든 role). RAISE EXCEPTION 기본 SQLSTATE는 P0001이다.
CREATE FUNCTION pod.emotion_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'emotion_ledger is append-only';
END
$fn$;
REVOKE ALL ON FUNCTION pod.emotion_ledger_append_only() FROM PUBLIC;

CREATE TRIGGER emotion_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON pod.emotion_ledger
  FOR EACH ROW EXECUTE FUNCTION pod.emotion_ledger_append_only();
CREATE TRIGGER emotion_ledger_no_truncate
  BEFORE TRUNCATE ON pod.emotion_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION pod.emotion_ledger_append_only();

-- §5 권한: PUBLIC 회수 후 app role에 계약 표의 권한만 준다.
REVOKE ALL ON pod.users, pod.auth_identities, pod.preferences, pod.diary_moments, pod.day_summaries,
  pod.design_versions, pod.credit_accounts, pod.emotion_ledger FROM PUBLIC;

DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('GRANT USAGE ON SCHEMA pod TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.users TO %I', app);
  EXECUTE format('GRANT UPDATE (first_login_at) ON pod.users TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.auth_identities TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.preferences TO %I', app);
  EXECUTE format('GRANT UPDATE (font_key, applied_design_version_id, updated_at) ON pod.preferences TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON pod.diary_moments TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON pod.day_summaries TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.design_versions TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.credit_accounts TO %I', app);
  EXECUTE format('GRANT UPDATE (balance, updated_at) ON pod.credit_accounts TO %I', app);
  EXECUTE format('GRANT SELECT, INSERT ON pod.emotion_ledger TO %I', app);
END
$grant$;
