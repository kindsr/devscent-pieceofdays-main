-- 0001_init down: 빈 CI DB 리허설 전용(PLAN_mvp-database §3, DATA_CONTRACT §6).
-- 첫 문장이 실행기 사전 확인과 같은 보호를 다시 한다. 실행기를 거치지 않고 실행해도
-- db_environment가 'ci'가 아니거나 사용자 데이터가 한 행이라도 있으면 P0001로 전체를 거부한다.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pod_meta.db_environment WHERE name = 'ci') THEN
    RAISE EXCEPTION '0001_init down refused: db_environment.name is not ci';
  END IF;
  IF EXISTS (SELECT 1 FROM pod.users)
     OR EXISTS (SELECT 1 FROM pod.auth_identities)
     OR EXISTS (SELECT 1 FROM pod.preferences)
     OR EXISTS (SELECT 1 FROM pod.diary_moments)
     OR EXISTS (SELECT 1 FROM pod.day_summaries)
     OR EXISTS (SELECT 1 FROM pod.design_versions)
     OR EXISTS (SELECT 1 FROM pod.credit_accounts)
     OR EXISTS (SELECT 1 FROM pod.emotion_ledger) THEN
    RAISE EXCEPTION '0001_init down refused: pod user data exists';
  END IF;
END
$guard$;

DROP TABLE pod.emotion_ledger;
DROP FUNCTION pod.emotion_ledger_append_only();
DROP TABLE pod.credit_accounts;
DROP TABLE pod.day_summaries;
DROP TABLE pod.diary_moments;
DROP TABLE pod.preferences;
DROP TABLE pod.design_versions;
DROP TABLE pod.auth_identities;
DROP TABLE pod.users;
DROP SCHEMA pod;
