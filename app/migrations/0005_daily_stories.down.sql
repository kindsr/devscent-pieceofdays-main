-- 빈 CI DB에서만 리허설한다. 실행기 guard와 별도로 이 SQL 자체도 사용자 자료가 있으면 거부한다.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pod_meta.db_environment WHERE name = 'ci') THEN
    RAISE EXCEPTION '0005_daily_stories down refused: db_environment.name is not ci';
  END IF;
  IF EXISTS (SELECT 1 FROM pod.users)
     OR EXISTS (SELECT 1 FROM pod.auth_identities)
     OR EXISTS (SELECT 1 FROM pod.preferences)
     OR EXISTS (SELECT 1 FROM pod.diary_moments)
     OR EXISTS (SELECT 1 FROM pod.day_summaries)
     OR EXISTS (SELECT 1 FROM pod.design_versions)
     OR EXISTS (SELECT 1 FROM pod.credit_accounts)
     OR EXISTS (SELECT 1 FROM pod.emotion_ledger)
     OR EXISTS (SELECT 1 FROM pod.photo_uploads)
     OR EXISTS (SELECT 1 FROM pod.moment_photos)
     OR EXISTS (SELECT 1 FROM pod.photo_deletions)
     OR EXISTS (SELECT 1 FROM pod.story_versions) THEN
    RAISE EXCEPTION '0005_daily_stories down refused: pod user data exists';
  END IF;
END
$guard$;

DROP TABLE pod.story_versions;
