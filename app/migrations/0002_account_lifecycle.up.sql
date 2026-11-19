-- 0002_account_lifecycle: PLAN_account-lifecycle §5·§6·§10·§11. 실행기가 BEGIN·advisory lock·SET LOCAL ROLE owner 안에서 실행한다.
-- role 이름은 pod_meta.db_environment에서 읽어 format('%I')로 GRANT한다. role을 만들거나 바꾸지 않는다.

-- §10 1: 계정 상태·탈퇴 기한·세션 generation. 기존 사용자는 active / gen 1 / 시각 NULL이 된다.
ALTER TABLE pod.users
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CONSTRAINT users_status_check CHECK (status IN ('active', 'pending_deletion')),
  ADD COLUMN deletion_requested_at timestamptz NULL,
  ADD COLUMN purge_after timestamptz NULL,
  ADD COLUMN auth_generation integer NOT NULL DEFAULT 1
    CONSTRAINT users_auth_generation_check CHECK (auth_generation >= 1),
  ADD CONSTRAINT users_lifecycle_consistency CHECK (
    (status = 'active' AND deletion_requested_at IS NULL AND purge_after IS NULL)
    OR (status = 'pending_deletion' AND deletion_requested_at IS NOT NULL AND purge_after IS NOT NULL
        AND purge_after = deletion_requested_at + interval '720 hours')
  );

-- §10 2
CREATE INDEX users_purge_due_idx ON pod.users (purge_after) WHERE status = 'pending_deletion';

-- §10 3: app은 새 4열만 UPDATE할 수 있다. DELETE는 주지 않는다.
DO $grant$
DECLARE
  app name;
BEGIN
  SELECT app_role INTO STRICT app FROM pod_meta.db_environment;
  EXECUTE format('GRANT UPDATE (status, deletion_requested_at, purge_after, auth_generation) ON pod.users TO %I', app);
END
$grant$;

-- §10 4: purge 함수 안의(owner, 같은 사용자 GUC) 원장 DELETE만 허용한다. UPDATE·TRUNCATE와 그 밖의 DELETE는 P0001이다.
-- 기존 두 트리거와 PUBLIC 회수는 그대로다.
CREATE OR REPLACE FUNCTION pod.emotion_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('pod.purge_user_id', true) = OLD.user_id::text
       AND current_user = (SELECT owner_role FROM pod_meta.db_environment) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'emotion_ledger is append-only';
END
$fn$;

-- §10 5: 기한이 지난 탈퇴 사용자 목록(잠금 없음). 실제 자격은 purge_user_if_due가 다시 확인한다.
CREATE FUNCTION pod.list_purge_due(p_limit integer) RETURNS SETOF uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  t timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'list_purge_due: limit must be between 1 and 1000';
  END IF;
  t := pg_catalog.clock_timestamp();
  RETURN QUERY
    SELECT u.id FROM pod.users u
     WHERE u.status = 'pending_deletion' AND u.purge_after <= t
     ORDER BY u.purge_after, u.id
     LIMIT p_limit;
END
$fn$;

-- §10 6·§5: 행 잠금 → t → 자격 → GUC → 원장 → 계정 → users(나머지 CASCADE) → GUC 비움. 실패하면 전체 롤백된다.
CREATE FUNCTION pod.purge_user_if_due(p_user uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_status text;
  v_purge_after timestamptz;
  t timestamptz;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'purge_user_if_due: user id is required';
  END IF;
  SELECT u.status, u.purge_after INTO v_status, v_purge_after
    FROM pod.users u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'absent';
  END IF;
  t := pg_catalog.clock_timestamp();
  IF v_status <> 'pending_deletion' OR v_purge_after IS NULL OR v_purge_after > t THEN
    RETURN 'not_due';
  END IF;
  PERFORM pg_catalog.set_config('pod.purge_user_id', p_user::text, true);
  DELETE FROM pod.emotion_ledger WHERE user_id = p_user;
  DELETE FROM pod.credit_accounts WHERE user_id = p_user;
  DELETE FROM pod.users WHERE id = p_user;
  PERFORM pg_catalog.set_config('pod.purge_user_id', '', true);
  RETURN 'purged';
END
$fn$;

-- §10 7: 새 함수의 기본 PUBLIC EXECUTE를 같은 트랜잭션에서 회수한다.
REVOKE ALL ON FUNCTION pod.list_purge_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION pod.purge_user_if_due(uuid) FROM PUBLIC;

-- §10 8·§11 A: 전용 purge role에만 스키마 USAGE와 두 함수 EXECUTE를 준다. 조건을 어기면 GRANT 없이 전체를 롤백한다.
DO $purge$
DECLARE
  v_purge name;
  v_app name;
  v_owner name;
BEGIN
  SELECT purge_role, app_role, owner_role INTO STRICT v_purge, v_app, v_owner FROM pod_meta.db_environment;
  IF v_purge IS NULL THEN
    RAISE EXCEPTION '0002_account_lifecycle refused: db_environment.purge_role is not set';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_purge) THEN
    RAISE EXCEPTION '0002_account_lifecycle refused: purge_role does not exist';
  END IF;
  IF v_purge = v_app OR v_purge = v_owner OR v_purge = session_user THEN
    RAISE EXCEPTION '0002_account_lifecycle refused: purge_role must differ from app, owner and migration roles';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA pod TO %I', v_purge);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pod.list_purge_due(integer) TO %I', v_purge);
  EXECUTE format('GRANT EXECUTE ON FUNCTION pod.purge_user_if_due(uuid) TO %I', v_purge);
END
$purge$;
