-- 결함(3차 감사) 대응 — 두 가지 별개 결함을 담는다. 둘 다 "제약/인덱스가 있어야
-- 하는데 없어서 조용히 틀리게 동작한다"는 같은 종류라 한 파일로 묶는다.

-- =====================================================================
-- 1. huai_outbox 방 단위 정리 쿼리를 못 받쳐주는 인덱스
-- =====================================================================
--
-- scripts/prune-archived-rows.mjs 의 아웃박스 정리 쿼리(room_id=eq.X&created_at=lt.Y)에
-- 걸리는 기존 인덱스는 20260815140000 이 만든
-- huai_outbox_target_room_created_idx (target_kind, room_id, created_at) 뿐이다.
-- room_id 가 선행 컬럼이 아니라서(target_kind 가 먼저다) 이 쿼리는 이 인덱스를 못 쓴다 —
-- B-tree 인덱스는 선행 컬럼을 등호로 고정해야 뒤 컬럼이 유효해지는데, 이 쿼리에는
-- target_kind 조건이 없다. room_id 를 선행 컬럼으로 둔 인덱스를 별도로 추가한다.
create index if not exists huai_outbox_room_created_idx
  on huai_outbox (room_id, created_at);

-- =====================================================================
-- 2. huai_gateway_instances.allowed_adapters 빈 배열 금지
-- =====================================================================
--
-- 20260829100000 이 추가한 huai_gateway_instances_allowed_adapters_check 는
-- "모든 원소가 4종(claude_code|codex|gemini_web|antigravity) 안에 있는가"만 검사한다.
-- jsonb 컨테인먼트 연산자(<@)는 빈 배열 []도 자연스럽게 통과시킨다 — 원소가 하나도
-- 없으니 "모든 원소가 부분집합"이라는 조건이 공허하게 참이 된다. 그 결과
-- allowed_adapters = '[]' 인 게이트웨이 행이 스키마상 유효해지는데, 그런 행은 애초에
-- 아무 실행도 못 맡는다(apps/bot-service/src/supabase-runtime-loader.ts 의
-- isAiAdapterType 필터를 통과할 원소 자체가 없다) — DB 가 이런 무의미한 상태를 막지
-- 못하고 있었다.
--
-- NOT VALID 로 추가한다 — 20260829100000 의 주석이 밝힌 것과 같은 이유로, 검증 없이
-- 쓰는 경로(scripts/room-seed-derivation.mjs 의 allowedAdaptersFromEnv 가
-- LOCAL_GATEWAY_ALLOWED_ADAPTERS 환경변수를 그대로 저장한다)가 있어, 기존 운영 행 중
-- 빈 배열이 이미 들어있을 가능성을 이 마이그레이션 작성 시점에는 배제할 수 없다.
-- VALID 로 바로 추가하면 기존 행이 위반할 경우 마이그레이션 자체가 실패한다.
--
-- 적용 전 운영 DB에서 아래 쿼리로 위반 행이 있는지 먼저 확인한다. 0건이면 바로 이어서
-- `alter table huai_gateway_instances validate constraint
-- huai_gateway_instances_allowed_adapters_nonempty_check;` 를 실행해 기존 행까지
-- 포함한 완전히 검증된 상태로 승격한다 — 20260830000000 이 첫 번째 제약을 승격한 것과
-- 같은 절차(validate constraint 는 ACCESS EXCLUSIVE 잠금 없이 한 번 훑기만 한다):
--
--   select gateway_id, allowed_adapters
--   from huai_gateway_instances
--   where jsonb_array_length(allowed_adapters) = 0;
alter table huai_gateway_instances
  drop constraint if exists huai_gateway_instances_allowed_adapters_nonempty_check;

alter table huai_gateway_instances
  add constraint huai_gateway_instances_allowed_adapters_nonempty_check
  check (jsonb_array_length(allowed_adapters) > 0) not valid;
