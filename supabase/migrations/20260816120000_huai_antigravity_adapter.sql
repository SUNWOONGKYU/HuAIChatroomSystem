-- 세 번째 엔진 antigravity(agy CLI)를 실행 대상으로 인정한다.
--
-- 엔진이 둘뿐이면 감사가 한도에 걸렸을 때 작업자 엔진이 자기 결과를 검사하게 된다.
-- 그건 독립 검증이 아니다. 셋이면 작업자와 다른 엔진이 하나 더 남는다.
--
-- 여기서 여는 것은 "엔진"이지 텔레그램 봇이 아니다. 감사 보고는 지금도 AuditorBot 이
-- 보내므로 새 봇 역할은 필요하지 않다.

alter table huai_execution_attempts
  drop constraint if exists huai_execution_attempts_adapter_type_check;

alter table huai_execution_attempts
  add constraint huai_execution_attempts_adapter_type_check
  check (adapter_type in ('claude_code', 'codex', 'antigravity'));

alter table huai_ai_actors
  drop constraint if exists huai_ai_actors_adapter_type_check;

alter table huai_ai_actors
  add constraint huai_ai_actors_adapter_type_check
  check (adapter_type in ('orchestrator', 'claude_code', 'codex', 'antigravity', 'auditor'));

-- 게이트웨이 허용 목록. 새로 만드는 방과 이미 있는 방 모두 열어야 폴백이 실제로 걸린다.
alter table huai_gateway_instances
  alter column allowed_adapters set default '["claude_code","codex","antigravity"]'::jsonb;

update huai_gateway_instances
set allowed_adapters = allowed_adapters || '["antigravity"]'::jsonb
where not (allowed_adapters @> '["antigravity"]'::jsonb);
