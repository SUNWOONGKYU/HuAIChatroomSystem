-- 승인 기록 배선 (FR-008 / FR-015 / AC-08 / NFR-02).
--
-- 1) entity_ref: 승인 시점의 대상 식별자를 있는 그대로 남긴다.
--    방장이 버튼을 누르는 시점의 대상은 아직 task 가 아니라 proposal("proposal_0001") 인 경우가 있다.
--    task_id 를 억지로 맞추려 사후 UPDATE 하면 append-only 원장 자체가 모순되므로,
--    사실을 그대로 기록하고 task 는 생성 시점에 approved_by_approval_id 로 역방향 연결한다.
--    승인만 있고 task 가 없는 상태는 버그가 아니다 — 반려·취소는 원래 task 가 없다.
--
-- 2) append-only 트리거: NFR-02 "중요 상태 변경과 승인·판정은 변경 불가능한 이력으로 남긴다".
--    이 시스템은 모든 접근이 단일 service_role 로 이루어지므로 권한 분리로는 막을 수 없다.
--    위협은 외부 공격자가 아니라 코드 실수와 사후 정정 유혹이며, 트리거가 그것을 최저 비용으로 막는다.

alter table huai_approvals
  add column if not exists entity_ref text;

create index if not exists huai_approvals_entity_ref_idx
  on huai_approvals (entity_ref);

create index if not exists huai_approvals_task_stage_idx
  on huai_approvals (task_id, stage);

create or replace function huai_reject_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only-ledger:% is immutable (attempted %)', tg_table_name, tg_op
    using hint = 'Record a compensating entry instead of updating or deleting the original row.';
end;
$$;

drop trigger if exists huai_approvals_append_only on huai_approvals;
create trigger huai_approvals_append_only
  before update or delete on huai_approvals
  for each row execute function huai_reject_ledger_mutation();

drop trigger if exists huai_events_append_only on huai_events;
create trigger huai_events_append_only
  before update or delete on huai_events
  for each row execute function huai_reject_ledger_mutation();
