-- 아티팩트 중복 삽입 방지.
-- lease_huai_outbox 는 동시 리스 획득만 막는다. locked_until 만료 후에는
-- 첫 워커의 persistCollectedArtifacts 가 아직 in-flight 인 상태에서 같은 행이
-- 재리스될 수 있고, 그러면 두 호출이 각각 "없음"을 확인한 뒤 각각 INSERT 한다.
-- read-before-write 로는 막을 수 없으므로 DB 제약으로 차단한다.

create unique index if not exists huai_artifacts_task_uri_version_unique
  on huai_artifacts (task_id, uri, version);
