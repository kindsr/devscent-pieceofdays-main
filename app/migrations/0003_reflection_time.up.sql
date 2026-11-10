-- 0003_reflection_time: 계정별 회고 시각. 기존 설정·기록의 날짜와 시각은 보존한다.
ALTER TABLE pod.preferences
  ADD COLUMN reflection_time text NOT NULL DEFAULT '20:00'
    CONSTRAINT preferences_reflection_time_check CHECK (
      length(reflection_time) = 5 AND reflection_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    );

DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('GRANT UPDATE (reflection_time) ON pod.preferences TO %I', app);
END
$grant$;
