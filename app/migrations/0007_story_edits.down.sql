-- 빈 CI DB에서만 리허설한다. 실행기 guard와 별도로 이 SQL 자체도 사용자 자료나 사용량 원장이 있으면 거부한다.
-- dev·운영에서는 down하지 않는다(PLAN_story-edit-regenerate §1). 0006 스키마로 정확히 되돌린다.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pod_meta.db_environment WHERE name = 'ci') THEN
    RAISE EXCEPTION '0007_story_edits down refused: db_environment.name is not ci';
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
     OR EXISTS (SELECT 1 FROM pod.story_versions)
     OR EXISTS (SELECT 1 FROM pod.story_ai_settings)
     OR EXISTS (SELECT 1 FROM pod.story_jobs)
     OR EXISTS (SELECT 1 FROM pod.story_usage) THEN
    RAISE EXCEPTION '0007_story_edits down refused: pod user data exists';
  END IF;
END
$guard$;

DROP INDEX pod.story_jobs_regen_once;
DROP INDEX pod.story_jobs_manual_once;
CREATE UNIQUE INDEX story_jobs_manual_once ON pod.story_jobs (user_id, local_date, source_revision)
  WHERE kind = 'manual' AND state IN ('queued', 'running', 'succeeded');
ALTER TABLE pod.story_jobs
  DROP CONSTRAINT story_jobs_base_manual,
  DROP CONSTRAINT story_jobs_base_version_check,
  DROP COLUMN base_version;

DROP INDEX pod.story_versions_first_per_revision;
ALTER TABLE pod.story_versions
  DROP CONSTRAINT story_versions_base_fk,
  DROP CONSTRAINT story_versions_edit_base,
  DROP CONSTRAINT story_versions_base_check,
  DROP CONSTRAINT story_versions_origin_check,
  DROP COLUMN base_version,
  DROP COLUMN origin,
  -- 0005가 이름 없이 만든 UNIQUE의 PostgreSQL 자동 이름(53자)을 그대로 복구한다.
  ADD CONSTRAINT story_versions_user_id_local_date_source_revision_key UNIQUE (user_id, local_date, source_revision);
