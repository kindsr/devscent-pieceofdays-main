-- 0005_daily_stories: PLAN_ai-daily-story-storage §1. 날짜별 AI 하루 이야기 버전만 저장한다. 기존 0001~0004는 보존한다.
-- 같은 입력(source_revision)은 같은 날 한 번만 저장하고, 새 입력은 다음 version으로 쌓는다. 탈퇴 purge는 users CASCADE로 지운다.
CREATE TABLE pod.story_versions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES pod.users (id) ON DELETE CASCADE,
  local_date      date NOT NULL,
  version         integer NOT NULL CHECK (version >= 1),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-f]{64}$'),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND btrim(body) <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, local_date, version),
  UNIQUE (user_id, local_date, source_revision)
);

REVOKE ALL ON pod.story_versions FROM PUBLIC;
DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('GRANT SELECT, INSERT ON pod.story_versions TO %I', app);
END
$grant$;
