-- 0002_account_lifecycle down: 빈 CI DB 리허설 전용(PLAN_account-lifecycle §10).
-- 첫 문장이 실행기 사전 확인과 같은 보호를 다시 한다. 실행기를 거치지 않고 실행해도
-- db_environment가 'ci'가 아니거나 사용자 데이터가 한 행이라도 있으면 P0001로 전체를 거부한다.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pod_meta.db_environment WHERE name = 'ci') THEN
    RAISE EXCEPTION '0002_account_lifecycle down refused: db_environment.name is not ci';
  END IF;
  IF EXISTS (SELECT 1 FROM pod.users)
     OR EXISTS (SELECT 1 FROM pod.auth_identities)
     OR EXISTS (SELECT 1 FROM pod.preferences)
     OR EXISTS (SELECT 1 FROM pod.diary_moments)
     OR EXISTS (SELECT 1 FROM pod.day_summaries)
     OR EXISTS (SELECT 1 FROM pod.design_versions)
     OR EXISTS (SELECT 1 FROM pod.credit_accounts)
     OR EXISTS (SELECT 1 FROM pod.emotion_ledger) THEN
    RAISE EXCEPTION '0002_account_lifecycle down refused: pod user data exists';
  END IF;
END
$guard$;

-- purge role 권한 회수 → 함수 삭제. meta 열(purge_role)은 provisioning 소유라 남긴다.
DO $purge$
DECLARE
  v_purge name;
BEGIN
  SELECT purge_role INTO STRICT v_purge FROM pod_meta.db_environment;
  EXECUTE format('REVOKE EXECUTE ON FUNCTION pod.list_purge_due(integer) FROM %I', v_purge);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION pod.purge_user_if_due(uuid) FROM %I', v_purge);
  EXECUTE format('REVOKE USAGE ON SCHEMA pod FROM %I', v_purge);
END
$purge$;

DROP FUNCTION pod.list_purge_due(integer);
DROP FUNCTION pod.purge_user_if_due(uuid);

-- 원장 트리거 함수를 0001 본문으로 되돌린다(PUBLIC 회수 유지).
CREATE OR REPLACE FUNCTION pod.emotion_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'emotion_ledger is append-only';
END
$fn$;
REVOKE ALL ON FUNCTION pod.emotion_ledger_append_only() FROM PUBLIC;

-- app의 새 4열 UPDATE 권한 회수(first_login_at 권한은 유지).
DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('REVOKE UPDATE (status, deletion_requested_at, purge_after, auth_generation) ON pod.users FROM %I', app);
END
$grant$;

DROP INDEX pod.users_purge_due_idx;
ALTER TABLE pod.users
  DROP CONSTRAINT users_lifecycle_consistency,
  DROP CONSTRAINT users_auth_generation_check,
  DROP CONSTRAINT users_status_check,
  DROP COLUMN auth_generation,
  DROP COLUMN purge_after,
  DROP COLUMN deletion_requested_at,
  DROP COLUMN status;
