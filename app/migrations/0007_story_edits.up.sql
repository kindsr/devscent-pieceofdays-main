-- 0007_story_edits: PLAN_story-edit-regenerate §1. AI 하루 이야기의 직접 수정·같은 입력 재생성을 다음 version으로 보존한다.
-- 새 표는 없다. 기존 행은 UPDATE·DELETE하지 않고 origin 'ai'·base NULL로 읽힌다. 새 GRANT도 없다(app은 SELECT·INSERT 그대로,
-- story_jobs.base_version은 enqueue snapshot이라 UPDATE 권한에 넣지 않는다).
ALTER TABLE pod.story_versions
  ADD COLUMN origin text NOT NULL DEFAULT 'ai',
  ADD COLUMN base_version integer NULL,
  ADD CONSTRAINT story_versions_origin_check CHECK (origin IN ('ai', 'user_edit')),
  ADD CONSTRAINT story_versions_base_check CHECK (base_version IS NULL OR (base_version >= 1 AND base_version < version)),
  ADD CONSTRAINT story_versions_edit_base CHECK (origin <> 'user_edit' OR base_version IS NOT NULL),
  ADD CONSTRAINT story_versions_base_fk FOREIGN KEY (user_id, local_date, base_version)
    REFERENCES pod.story_versions (user_id, local_date, version);

-- 0005의 전체 UNIQUE(user_id, local_date, source_revision)를 최초 생성(base NULL)만의 부분 UNIQUE로 바꾼다.
-- 수정·재생성은 같은 실제 입력 revision을 승계하므로 같은 revision의 여러 version을 허용해야 한다. 제약은 열 목록으로 찾는다.
DO $swap$
DECLARE
  old name;
BEGIN
  SELECT con.conname INTO STRICT old
    FROM pg_constraint con
   WHERE con.conrelid = 'pod.story_versions'::regclass AND con.contype = 'u'
     AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
         = ARRAY['user_id', 'local_date', 'source_revision'];
  EXECUTE format('ALTER TABLE pod.story_versions DROP CONSTRAINT %I', old);
END
$swap$;
CREATE UNIQUE INDEX story_versions_first_per_revision ON pod.story_versions (user_id, local_date, source_revision)
  WHERE base_version IS NULL;

-- 재생성 job은 base_version(요청 때 최신 version)을 가진 manual job이다. 같은 base의 재생성은 진행·성공 중 한 번만.
ALTER TABLE pod.story_jobs
  ADD COLUMN base_version integer NULL,
  ADD CONSTRAINT story_jobs_base_version_check CHECK (base_version >= 1),
  ADD CONSTRAINT story_jobs_base_manual CHECK (base_version IS NULL OR kind = 'manual');
DROP INDEX pod.story_jobs_manual_once;
CREATE UNIQUE INDEX story_jobs_manual_once ON pod.story_jobs (user_id, local_date, source_revision)
  WHERE kind = 'manual' AND state IN ('queued', 'running', 'succeeded') AND base_version IS NULL;
CREATE UNIQUE INDEX story_jobs_regen_once ON pod.story_jobs (user_id, local_date, base_version)
  WHERE base_version IS NOT NULL AND state IN ('queued', 'running', 'succeeded');
