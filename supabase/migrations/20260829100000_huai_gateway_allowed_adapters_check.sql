-- huai_gateway_instances.allowed_adapters 에는 지금까지 DB CHECK 제약이 없었다
-- (20260827130000_huai_gemini_web_adapter.sql 상단 주석: "allowed_adapters 는 JSON
-- 배열이라 별도 enum CHECK가 없으며, 애플리케이션 allowlist가 gemini_web을 읽는다") —
-- 애플리케이션 레벨(apps/bot-service/src/supabase-runtime-loader.ts 의 isAiAdapterType
-- 필터, scripts/verify-operation-env.mjs 의 allowlist)에서만 검증됐다. service_role 로
-- 직접 쓰는 경로(scripts/generate-supabase-room-seed.mjs, scripts/onboard-telegram-room.mjs)는
-- LOCAL_GATEWAY_ALLOWED_ADAPTERS 환경변수를 그대로 콤마 분리해 검증 없이 저장한다
-- (scripts/room-seed-derivation.mjs 의 allowedAdaptersFromEnv) — 오타나 아직 지원하지
-- 않는 값이 그대로 들어갈 수 있는 경로다. DB 가 마지막 방어선이 돼야 한다.
--
-- 허용 값은 packages/contracts/src/index.ts 의 AiAdapterType 과 정확히 맞춘다:
-- "claude_code" | "codex" | "gemini_web" | "antigravity" (huai_execution_attempts.
-- adapter_type_check 가 20260827130000 에서 검증한 것과 동일한 4종 — 이 컬럼은 그 4종
-- 중 무엇을 이 게이트웨이가 실행해도 되는지를 나타내는 허용 목록이다).
--
-- jsonb 컨테인먼트 연산자(<@)로 "모든 원소가 허용 목록의 부분집합인가"를 검사한다 —
-- CHECK 제약 안에는 서브쿼리를 쓸 수 없어서(Postgres 제약 — "cannot use subquery in
-- check constraint") jsonb_array_elements_text() 를 subquery 형태로는 못 쓴다. <@ 는
-- 순수 연산자라 이 제한에 걸리지 않고, 빈 배열([])도 자연스럽게 통과시킨다.
--
-- NOT VALID 로 추가한다 — 기존 운영 행 중 이 4종 밖의 값이 이미 들어있었다면(위에서
-- 설명한 검증 없는 쓰기 경로 때문에 가능성을 배제할 수 없다) VALID 로 바로 추가할 경우
-- 이 migration 자체가 실패한다. NOT VALID 는 기존 행은 검사하지 않고 이후의
-- INSERT/UPDATE 부터 즉시 강제한다 — 최소한 문제가 더 커지는 것은 막는다. 운영 DB에서
-- 아래 쿼리로 기존 행이 전부 이 4종만 쓰는지 확인한 뒤에만 이어서
-- `alter table huai_gateway_instances validate constraint
-- huai_gateway_instances_allowed_adapters_check;` 를 실행해 완전히 검증된 상태로 만든다:
--
--   select gateway_id, allowed_adapters
--   from huai_gateway_instances
--   where not (
--     jsonb_typeof(allowed_adapters) = 'array'
--     and allowed_adapters <@ '["claude_code", "codex", "gemini_web", "antigravity"]'::jsonb
--   );
alter table huai_gateway_instances
  drop constraint if exists huai_gateway_instances_allowed_adapters_check;

alter table huai_gateway_instances
  add constraint huai_gateway_instances_allowed_adapters_check
  check (
    jsonb_typeof(allowed_adapters) = 'array'
    and allowed_adapters <@ '["claude_code", "codex", "gemini_web", "antigravity"]'::jsonb
  ) not valid;
