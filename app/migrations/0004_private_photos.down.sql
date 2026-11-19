-- 빈 CI DB에서만 리허설한다. ownerless journal/삭제 tombstone도 사용자 자료다.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pod_meta.db_environment WHERE name = 'ci') THEN
    RAISE EXCEPTION '0004_private_photos down refused: db_environment.name is not ci';
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
     OR EXISTS (SELECT 1 FROM pod.photo_deletions) THEN
    RAISE EXCEPTION '0004_private_photos down refused: pod user data exists';
  END IF;
END
$guard$;

DROP TRIGGER photo_uploads_journal_orphan ON pod.photo_uploads;
DROP TRIGGER moment_photos_journal_delete ON pod.moment_photos;
DROP FUNCTION pod.journal_orphaned_photo_upload();
DROP FUNCTION pod.journal_deleted_photo();
DROP FUNCTION pod.is_photo_cleanup_role();
DROP TABLE pod.photo_deletions;
DROP TABLE pod.moment_photos;
DROP TABLE pod.photo_uploads;
ALTER TABLE pod.diary_moments DROP CONSTRAINT diary_moments_id_user_unique;
