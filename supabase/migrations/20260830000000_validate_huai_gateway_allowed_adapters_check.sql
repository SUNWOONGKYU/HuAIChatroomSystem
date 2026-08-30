-- 20260829100000 에서 huai_gateway_instances_allowed_adapters_check 를 NOT VALID 로 추가했다.
-- 기존 행에 4종(claude_code|codex|gemini_web|antigravity) 밖의 값이 들어있을 가능성을
-- 배제할 수 없어서 — scripts/room-seed-derivation.mjs 가 LOCAL_GATEWAY_ALLOWED_ADAPTERS
-- 환경변수를 검증 없이 그대로 저장하는 경로가 있다 — 기존 행 검사를 건너뛰고 이후
-- INSERT/UPDATE 부터만 강제하도록 둔 것이다.
--
-- 그 뒤 운영 DB 의 huai_gateway_instances 전체(5행)를 실제로 조회해 전 행이 4종만
-- 쓰고 있음을 확인했다(위반 0건). 따라서 기존 행까지 포함해 완전히 검증된 상태로
-- 승격한다. validate constraint 는 테이블을 ACCESS EXCLUSIVE 로 잠그지 않고
-- (SHARE UPDATE EXCLUSIVE) 한 번 훑기만 하므로 읽기·쓰기를 막지 않는다.
alter table huai_gateway_instances
  validate constraint huai_gateway_instances_allowed_adapters_check;
