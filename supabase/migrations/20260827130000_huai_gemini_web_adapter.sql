-- Gemini 웹 실행기를 추가한다. 기존 antigravity 값은 혼합 버전 호환을 위해 유지하며
-- 애플리케이션이 Gemini 웹 경로로 해석한다.
--
-- ⚠ 배포 전 필수. 이 migration 을 적용하지 않은 DB 에 새 코드를 올리면 실행 자체가 죽는다:
-- assertExecutionRequestPayload(packages/contracts) 와 supabase-runtime-loader 가
-- antigravity 를 gemini_web 으로 정규화하고, 그 값이 그대로
-- huai_execution_attempts.adapter_type 으로 INSERT 된다
-- (packages/supabase-runtime/src/index.ts 의 실행 시도 기록). 옛 CHECK 는 gemini_web 을
-- 허용하지 않으므로 23514 로 거부되고, 해당 방의 실행 기록이 통째로 실패한다.
-- schema.sql 은 이미 이 상태를 SSOT 로 반영하고 있다 — 운영 DB 만 뒤처져 있으면 안 된다.
alter table huai_ai_actors drop constraint if exists huai_ai_actors_adapter_type_check;
alter table huai_ai_actors add constraint huai_ai_actors_adapter_type_check
  check (adapter_type in ('orchestrator', 'claude_code', 'codex', 'gemini_web', 'antigravity', 'auditor'));

-- allowed_adapters 는 JSON 배열이라 별도 enum CHECK가 없으며, 애플리케이션 allowlist가
-- gemini_web을 읽는다. 기존 행의 antigravity 값은 삭제하지 않는다.

alter table huai_execution_attempts drop constraint if exists huai_execution_attempts_adapter_type_check;
alter table huai_execution_attempts add constraint huai_execution_attempts_adapter_type_check
  check (adapter_type in ('claude_code', 'codex', 'gemini_web', 'antigravity'));
