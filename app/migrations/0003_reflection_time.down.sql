-- 0003_reflection_time down: 빈 CI DB 리허설 전용. 실제 서비스는 열을 남긴 채 앱 코드를 복귀한다.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pod_meta.db_environment WHERE name = 'ci') THEN
    RAISE EXCEPTION '0003_reflection_time down refused: db_environment.name is not ci';
  END IF;
  IF EXISTS (SELECT 1 FROM pod.users)
     OR EXISTS (SELECT 1 FROM pod.auth_identities)
     OR EXISTS (SELECT 1 FROM pod.preferences)
     OR EXISTS (SELECT 1 FROM pod.diary_moments)
     OR EXISTS (SELECT 1 FROM pod.day_summaries)
     OR EXISTS (SELECT 1 FROM pod.design_versions)
     OR EXISTS (SELECT 1 FROM pod.credit_accounts)
     OR EXISTS (SELECT 1 FROM pod.emotion_ledger) THEN
    RAISE EXCEPTION '0003_reflection_time down refused: pod user data exists';
  END IF;
END
$guard$;

DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('REVOKE UPDATE (reflection_time) ON pod.preferences FROM %I', app);
END
$grant$;

ALTER TABLE pod.preferences
  DROP CONSTRAINT preferences_reflection_time_check,
  DROP COLUMN reflection_time;
