-- 0006_story_generation: PLAN_ai-story-live-generation §2. AI 이야기 동의·생성 작업·익명 사용량 원장. 기존 0001~0005는 보존한다.
-- 동의(consent_version=정책 버전, consent_revision=사용자 동의 epoch)와 job은 users CASCADE로 지우고,
-- 사용량 원장은 사용자 FK·user_id·본문이 없어 purge 뒤에도 남는다. job의 gen·동의 snapshot은 app이 바꿀 수 없다.
CREATE TABLE pod.story_ai_settings (
  user_id          uuid PRIMARY KEY REFERENCES pod.users (id) ON DELETE CASCADE,
  consent_version  integer NOT NULL CHECK (consent_version >= 1),
  consent_revision bigint NOT NULL DEFAULT 1 CHECK (consent_revision >= 1),
  manual_enabled   boolean NOT NULL DEFAULT false,
  auto_enabled     boolean NOT NULL DEFAULT false,
  auto_enabled_at  timestamptz NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_ai_settings_auto_at CHECK (auto_enabled = (auto_enabled_at IS NOT NULL))
);

CREATE TABLE pod.story_jobs (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id          uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  local_date       date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  state            text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  source_revision  text NULL CHECK (source_revision ~ '^[0-9a-f]{64}$'),
  auth_generation  bigint NOT NULL CHECK (auth_generation >= 1),
  consent_version  integer NOT NULL CHECK (consent_version >= 1),
  consent_revision bigint NOT NULL CHECK (consent_revision >= 1),
  lease_token      uuid NULL,
  lease_until      timestamptz NULL,
  story_id         uuid NULL REFERENCES pod.story_versions (id) ON DELETE SET NULL,
  error            text NULL CHECK (error IN ('no_input', 'input_too_large', 'invalid_input', 'photo_unavailable',
                     'consent_missing', 'not_signed_in', 'input_changed', 'unavailable', 'timeout', 'invalid_output',
                     'lease_expired', 'already_current')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT story_jobs_lease CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT story_jobs_manual_rev CHECK (kind <> 'manual' OR source_revision IS NOT NULL),
  CONSTRAINT story_jobs_rev_running CHECK (state NOT IN ('running', 'succeeded') OR source_revision IS NOT NULL),
  CONSTRAINT story_jobs_error CHECK ((state IN ('failed', 'skipped')) = (error IS NOT NULL))
);
CREATE UNIQUE INDEX story_jobs_scheduled_once ON pod.story_jobs (user_id, local_date) WHERE kind = 'scheduled';
CREATE UNIQUE INDEX story_jobs_one_inflight ON pod.story_jobs (user_id) WHERE state IN ('queued', 'running');
CREATE UNIQUE INDEX story_jobs_manual_once ON pod.story_jobs (user_id, local_date, source_revision)
  WHERE kind = 'manual' AND state IN ('queued', 'running', 'succeeded');
CREATE INDEX story_jobs_queue ON pod.story_jobs (state, created_at);
CREATE INDEX story_jobs_by_day ON pod.story_jobs (user_id, local_date, created_at DESC);

CREATE TABLE pod.story_usage (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  job_id        uuid NOT NULL UNIQUE,
  usage_month   date NOT NULL CHECK (extract(day FROM usage_month) = 1),
  model         text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
  state         text NOT NULL CHECK (state IN ('sent', 'settled', 'unknown', 'not_sent')),
  input_tokens  integer NULL CHECK (input_tokens >= 0),
  output_tokens integer NULL CHECK (output_tokens >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz NULL,
  CONSTRAINT story_usage_tokens CHECK ((state = 'settled') = (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CONSTRAINT story_usage_settled CHECK ((state = 'sent') = (settled_at IS NULL))
);

REVOKE ALL ON pod.story_ai_settings, pod.story_jobs, pod.story_usage FROM PUBLIC;
DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('GRANT SELECT, INSERT ON pod.story_ai_settings, pod.story_jobs, pod.story_usage TO %I', app);
  EXECUTE format('GRANT UPDATE (consent_version, consent_revision, manual_enabled, auto_enabled, auto_enabled_at, updated_at) ON pod.story_ai_settings TO %I', app);
  EXECUTE format('GRANT UPDATE (state, source_revision, lease_token, lease_until, story_id, error, updated_at) ON pod.story_jobs TO %I', app);
  EXECUTE format('GRANT UPDATE (state, input_tokens, output_tokens, settled_at) ON pod.story_usage TO %I', app);
END
$grant$;
