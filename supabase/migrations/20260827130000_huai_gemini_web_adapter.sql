-- Gemini 웹 실행기를 추가한다. 기존 antigravity 값은 혼합 버전 호환을 위해 유지하며
-- 애플리케이션이 Gemini 웹 경로로 해석한다.
--
-- 코드보다 먼저 적용되어야 하는 migration 이다. assertExecutionRequestPayload
-- (packages/contracts) 와 supabase-runtime-loader 가 antigravity 를 gemini_web 으로
-- 정규화하고, 그 값이 그대로 huai_execution_attempts.adapter_type 으로 INSERT 된다
-- (packages/supabase-runtime/src/index.ts 의 실행 시도 기록). 옛 CHECK 에서는 23514 로
-- 거부된다.
--
-- 적용 상태(2026-08-29 확인): 운영 프로젝트 smxtewoijwelmmpyogwt 에 적용 완료.
-- `supabase migration list` 의 Remote 열에 20260827130000 이 있고, 두 테이블 모두
-- gemini_web 을 CHECK 에서 통과시킨다(FK 단계에서만 멈추는 것으로 확인).
alter table huai_ai_actors drop constraint if exists huai_ai_actors_adapter_type_check;
alter table huai_ai_actors add constraint huai_ai_actors_adapter_type_check
  check (adapter_type in ('orchestrator', 'claude_code', 'codex', 'gemini_web', 'antigravity', 'auditor'));

-- allowed_adapters 는 JSON 배열이라 별도 enum CHECK가 없으며, 애플리케이션 allowlist가
-- gemini_web을 읽는다. 기존 행의 antigravity 값은 삭제하지 않는다.

alter table huai_execution_attempts drop constraint if exists huai_execution_attempts_adapter_type_check;
alter table huai_execution_attempts add constraint huai_execution_attempts_adapter_type_check
  check (adapter_type in ('claude_code', 'codex', 'gemini_web', 'antigravity'));
