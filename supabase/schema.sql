-- Telegram-based Human-AI Collaboration Room schema draft.
-- Tokens and CLI credentials must never be stored in plaintext.

create extension if not exists pgcrypto;

create table if not exists huai_rooms (
  room_id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint unique not null,
  owner_telegram_user_id bigint not null,
  purpose text not null,
  rules text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint huai_rooms_status_check check (status in ('active', 'archived', 'suspended'))
);

create table if not exists huai_room_members (
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  telegram_user_id bigint not null,
  role text not null,
  permissions jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  primary key (room_id, telegram_user_id),
  constraint huai_room_members_role_check check (role in ('owner', 'human_member', 'platoon_leader', 'claude_leader', 'codex_leader', 'auditor', 'operator')),
  constraint huai_room_members_status_check check (status in ('active', 'invited', 'left', 'removed', 'suspended'))
);

create table if not exists huai_ai_actors (
  actor_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  role text not null,
  adapter_type text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  -- 소대장이 방의 맥락을 기억하도록 CLI 세션을 이어받는다(--resume).
  cli_session_id text,
  cli_session_updated_at timestamptz,
  constraint huai_ai_actors_role_check check (role in ('platoon_leader', 'claude_leader', 'codex_leader', 'auditor')),
  constraint huai_ai_actors_adapter_type_check check (adapter_type in ('orchestrator', 'claude_code', 'codex', 'antigravity', 'auditor')),
  constraint huai_ai_actors_status_check check (status in ('active', 'inactive', 'disabled')),
  unique (room_id, role)
);

create table if not exists huai_telegram_bots (
  telegram_bot_id uuid primary key default gen_random_uuid(),
  telegram_bot_user_id bigint unique,
  bot_username text not null unique,
  display_name text,
  -- 공통 봇 4개는 room 과 무관하게 존재한다(같은 봇을 여러 방에 초대해 재사용).
  -- 봇의 정체성은 role 로 직접 갖고, actor_id 는 정보성 참조로만 남긴다.
  -- 어느 방에서 어느 actor 가 실제로 처리하는지는 huai_ai_actors 를
  -- room_id + role 로 조회해서 얻는다.
  role text not null,
  actor_id uuid references huai_ai_actors(actor_id) on delete set null,
  token_secret_ref text not null,
  webhook_secret_ref text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint huai_telegram_bots_status_check check (status in ('active', 'inactive', 'disabled')),
  constraint huai_telegram_bots_role_check check (role in ('platoon_leader', 'claude_leader', 'codex_leader', 'auditor'))
);

create table if not exists huai_telegram_updates (
  telegram_bot_id uuid not null references huai_telegram_bots(telegram_bot_id) on delete cascade,
  update_id bigint not null,
  telegram_chat_id bigint not null,
  telegram_message_id bigint,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',
  error text,
  raw_update jsonb not null default '{}'::jsonb,
  processing_started_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  locked_at timestamptz,
  locked_until timestamptz,
  constraint huai_telegram_updates_status_check check (status in ('received', 'processing', 'processed', 'ignored', 'retry_pending', 'failed')),
  primary key (telegram_bot_id, update_id)
);

create unique index if not exists huai_telegram_updates_chat_message_unique
on huai_telegram_updates (telegram_chat_id, telegram_message_id)
where telegram_message_id is not null;

create index if not exists huai_telegram_updates_pending_idx
on huai_telegram_updates (status, received_at)
where status in ('received', 'retry_pending', 'failed');

create or replace function huai_can_act_in_room(
  p_room_id uuid,
  p_telegram_user_id bigint,
  p_permission text
) returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from huai_room_members rm
    where rm.room_id = p_room_id
      and rm.telegram_user_id = p_telegram_user_id
      and rm.status = 'active'
      and (
        case
          when p_permission in ('task:approve', 'task:reject', 'task:final_approve', 'task:cancel', 'task:verify', 'bots:manage')
            then rm.role = 'owner'
          else rm.role = 'owner' or rm.permissions ? p_permission
        end
      )
  );
$$;

create or replace function huai_claim_telegram_update(
  p_telegram_bot_id uuid,
  p_update_id bigint,
  p_locked_until timestamptz
) returns boolean
language plpgsql
as $$
declare
  v_row_count integer := 0;
begin
  update huai_telegram_updates
  set status = 'processing',
      processing_started_at = coalesce(processing_started_at, now()),
      locked_at = now(),
      locked_until = p_locked_until,
      attempts = attempts + 1
  where telegram_bot_id = p_telegram_bot_id
    and update_id = p_update_id
    and status in ('received', 'retry_pending', 'failed')
    and (locked_until is null or locked_until < now());

  get diagnostics v_row_count = row_count;
  return v_row_count = 1;
end;
$$;

create table if not exists huai_task_proposals (
  proposal_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  source_message_binding_id uuid,
  title text not null,
  purpose text not null,
  scope text not null,
  completion_criteria text not null,
  proposed_by_actor_id uuid references huai_ai_actors(actor_id),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint huai_task_proposals_status_check check (status in ('pending', 'approved', 'rejected', 'revision_requested', 'cancelled'))
);

create table if not exists huai_tasks (
  task_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  proposal_id uuid references huai_task_proposals(proposal_id),
  approved_by_approval_id uuid,
  assignee_actor_id uuid references huai_ai_actors(actor_id),
  idempotency_key text unique,
  status text not null,
  priority text not null default 'normal',
  title text not null,
  purpose text not null,
  scope text not null,
  completion_criteria text not null,
  -- 이 작업이 시작된 포럼 주제. 없으면 주제 없이 만들어진 작업이다(일반 그룹/General).
  telegram_message_thread_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint huai_tasks_status_check check (status in ('proposal_pending', 'proposal_revision_requested', 'proposal_rejected', 'scheduled', 'waiting_dependencies', 'queued_for_gateway', 'in_progress', 'mid_approval_pending', 'paused_by_owner', 'verification_pending', 'verification_in_progress', 'revision_requested', 'revision_in_progress', 'reverification_pending', 'commander_completion_pending', 'completion_approval_pending', 'owner_supplement_requested', 'completed', 'cancel_requested', 'cancelled', 'failed_retryable', 'blocked', 'rejected_or_cancelled'))
);

create unique index if not exists huai_tasks_approved_proposal_unique
on huai_tasks (proposal_id)
where proposal_id is not null;

create table if not exists huai_task_dependencies (
  dependency_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  predecessor_task_id uuid not null references huai_tasks(task_id) on delete cascade,
  successor_task_id uuid not null references huai_tasks(task_id) on delete cascade,
  dependency_type text not null,
  is_blocking boolean not null default true,
  created_at timestamptz not null default now(),
  unique (predecessor_task_id, successor_task_id, dependency_type),
  constraint huai_task_dependencies_type_check check (dependency_type in ('blocks', 'same_file_conflict', 'resource_conflict', 'related'))
);

create table if not exists huai_approvals (
  approval_id uuid primary key default gen_random_uuid(),
  task_id uuid references huai_tasks(task_id) on delete cascade,
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  stage text not null,
  decider_telegram_user_id bigint not null,
  decision text not null,
  reason text,
  created_at timestamptz not null default now(),
  idempotency_key text unique,
  -- 승인 시점의 대상 식별자를 그대로 보존한다. task 물질화 이전 단계의 승인은 proposal id 가 들어간다.
  entity_ref text,
  constraint huai_approvals_stage_check check (stage in ('task_approval', 'midpoint_approval', 'commander_completion', 'final_approval', 'cancellation')),
  constraint huai_approvals_decision_check check (decision in ('approved', 'rejected', 'revision_requested', 'cancelled'))
);

create index if not exists huai_approvals_entity_ref_idx on huai_approvals (entity_ref);
create index if not exists huai_approvals_task_stage_idx on huai_approvals (task_id, stage);

-- 이 파일은 신규 환경 구축용이면서 재실행 안전해야 한다. add constraint 는
-- if not exists 를 지원하지 않으므로 먼저 떨어뜨린다.
alter table huai_tasks
  drop constraint if exists huai_tasks_approved_by_approval_fk;

alter table huai_tasks
  add constraint huai_tasks_approved_by_approval_fk
  foreign key (approved_by_approval_id) references huai_approvals(approval_id);

create table if not exists huai_verifications (
  verification_id uuid primary key default gen_random_uuid(),
  task_id uuid not null references huai_tasks(task_id) on delete cascade,
  target_version text not null,
  verdict text not null,
  evidence text not null,
  required_fixes text,
  recommendations text,
  reverify_scope text,
  verifier_actor_id uuid references huai_ai_actors(actor_id),
  created_at timestamptz not null default now(),
  constraint huai_verifications_verdict_check check (verdict in ('pass', 'conditional_pass', 'fail'))
);

create table if not exists huai_reports (
  report_id uuid primary key default gen_random_uuid(),
  task_id uuid not null references huai_tasks(task_id) on delete cascade,
  is_meaningful boolean not null,
  summary text not null,
  approval_required boolean not null default false,
  impact_scope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists huai_revision_requests (
  revision_request_id uuid primary key default gen_random_uuid(),
  task_id uuid not null references huai_tasks(task_id) on delete cascade,
  verification_id uuid references huai_verifications(verification_id) on delete set null,
  required_fixes text not null,
  recommendations text,
  reverify_scope text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  constraint huai_revision_requests_status_check check (status in ('open', 'submitted', 'verified', 'closed', 'cancelled'))
);

create table if not exists huai_artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  task_id uuid not null references huai_tasks(task_id) on delete cascade,
  uri text not null,
  -- 폰에서 열 수 있는 주소. uri 는 이 PC 안의 경로라 링크로 쓸 수 없다.
  public_url text,
  version text not null,
  checksum text,
  author_actor_id uuid references huai_ai_actors(actor_id),
  is_final boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists huai_artifacts_task_uri_version_unique
  on huai_artifacts (task_id, uri, version);

-- 승인·이벤트 원장은 수정·삭제 불가 (NFR-02). 정정은 보정 기록을 새로 남긴다.
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

create table if not exists huai_events (
  event_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  task_id uuid references huai_tasks(task_id) on delete cascade,
  event_type text not null,
  idempotency_key text not null unique,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists huai_outbox (
  huai_outbox_id uuid primary key default gen_random_uuid(),
  event_id uuid references huai_events(event_id) on delete cascade,
  -- 이 행을 소유한 방. lease_huai_outbox 가 방 하나가 배치를 독점하지 못하도록
  -- 방별 상한을 걸 때 쓴다. event_id 가 없거나 원본 이벤트가 사라진 행은 null 로
  -- 남고, 리스 함수는 그런 행을 하나의 공유 버킷으로 묶는다(is not distinct from).
  room_id uuid references huai_rooms(room_id) on delete set null,
  idempotency_key text not null unique,
  target_kind text not null,
  target text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  locked_at timestamptz,
  locked_until timestamptz,
  last_error text,
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint huai_outbox_target_kind_check check (target_kind in ('telegram_bot', 'local_gateway')),
  constraint huai_outbox_status_check check (status in ('pending', 'processing', 'sent', 'retry_pending', 'failed', 'dead'))
);


comment on column huai_outbox.room_id is
  'Room that owns this outbox row, backfilled from huai_events.room_id. '
  'Null when event_id is null or the source event no longer exists; '
  'lease_huai_outbox groups all null-room rows into one shared fairness bucket '
  'via IS NOT DISTINCT FROM.';

create index if not exists huai_outbox_target_room_created_idx
  on huai_outbox (target_kind, room_id, created_at);

-- Mini App 결정 재생 폴러용 커서.
-- Mini App 은 결정을 huai_approvals 에 기록만 하고, 봇 서비스가 그걸 폴링해
-- Telegram 승인과 똑같은 커밋 경로로 재생한다. huai_approvals 는 append-only 라
-- "처리됨" 표시를 원장 자체에 못 써서 처리 상태를 여기 따로 둔다.
create table if not exists huai_miniapp_decision_cursor (
  id smallint primary key default 1,
  last_seen_created_at timestamptz not null default '-infinity',
  -- 같은 시각을 가진 행이 페이지 크기보다 많으면 시각만으로는 커서가 전진하지 못한다.
  -- 정렬이 (created_at, approval_id) 두 축이므로 커서도 두 축이어야 한다.
  last_seen_approval_id uuid,
  updated_at timestamptz not null default now(),
  constraint huai_miniapp_decision_cursor_singleton_check check (id = 1)
);

-- 행의 존재 자체가 "다시 재생하지 않는다"는 뜻이다. 실패는 남기지 않는다 —
-- 남기지 않아야 다음 주기에 재시도된다.
create table if not exists huai_miniapp_decision_processed (
  approval_id uuid primary key references huai_approvals(approval_id) on delete cascade,
  outcome text not null,
  detail text,
  processed_at timestamptz not null default now(),
  -- failed 는 일부러 뺐다. 폴러는 failed 를 기록하지 않고 다음 주기에 재시도하도록
  -- 두는 것이 설계이고, 제약에서 빠져 있는 것이 그 설계를 강제하는 안전장치다.
  constraint huai_miniapp_decision_processed_outcome_check
    check (outcome in (
      'replayed',
      'skipped_duplicate',
      'skipped_unsupported_stage',
      'skipped_unauthorized',
      'skipped_already_executed'
    ))
);

create index if not exists huai_miniapp_decision_processed_processed_at_idx
  on huai_miniapp_decision_processed (processed_at);

-- 방 단위 공평 리스. 예전에는 created_at 오름차순만 봤기 때문에 한 방이 수백 건을
-- 쌓아두면 그 방이 매 리스를 독식해 다른 방이 굶었다.
--
-- 방별 상한을 window 함수(row_number)가 아니라 LATERAL + LIMIT 으로 구한다.
-- Postgres 는 같은 쿼리 레벨에서 window 함수와 잠금절(FOR UPDATE)을 함께 쓰지 못한다.
-- 그렇다고 FOR UPDATE SKIP LOCKED 를 뺄 수도 없다 — 빼면 동시 리스 두 건이 같은
-- 후보 id 를 각각 고른 뒤 둘 다 UPDATE 해버린다(UPDATE 는 조인 키만 다시 볼 뿐
-- 원래 WHERE 조건을 재확인하지 않으므로 실제 이중 리스가 난다).
create or replace function lease_huai_outbox(
  p_limit integer,
  p_locked_until timestamptz,
  p_target_kind text,
  p_gateway_id text default null
) returns setof huai_outbox
language plpgsql
as $$
declare
  v_active_room_count integer;
  v_per_room_cap integer;
begin
  select count(*)
  into v_active_room_count
  from (
    select distinct o.room_id
    from huai_outbox o
    where o.target_kind = p_target_kind
      and (p_gateway_id is null or o.target::jsonb ->> 'gatewayId' = p_gateway_id)
      and (
        (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.locked_until < now())
      )
      and (o.locked_until is null or o.locked_until < now())
  ) active_rooms;

  v_per_room_cap := greatest(
    1,
    ceil(greatest(p_limit, 0)::numeric / greatest(v_active_room_count, 1))
  )::int;

  return query
  with active_rooms as (
    select distinct o.room_id
    from huai_outbox o
    where o.target_kind = p_target_kind
      and (p_gateway_id is null or o.target::jsonb ->> 'gatewayId' = p_gateway_id)
      and (
        (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.locked_until < now())
      )
      and (o.locked_until is null or o.locked_until < now())
  ),
  room_capped as (
    select ranked.huai_outbox_id
    from active_rooms a
    cross join lateral (
      select o.huai_outbox_id
      from huai_outbox o
      where o.target_kind = p_target_kind
        and (p_gateway_id is null or o.target::jsonb ->> 'gatewayId' = p_gateway_id)
        and o.room_id is not distinct from a.room_id
        and (
          (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
          or (o.status = 'processing' and o.locked_until < now())
        )
        and (o.locked_until is null or o.locked_until < now())
      order by o.created_at asc
      limit v_per_room_cap
    ) ranked
  ),
  candidates as (
    select o.huai_outbox_id
    from huai_outbox o
    join room_capped rc on rc.huai_outbox_id = o.huai_outbox_id
    order by o.created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update huai_outbox o
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      locked_until = p_locked_until
  from candidates c
  where o.huai_outbox_id = c.huai_outbox_id
  returning o.*;
end;
$$;

create or replace function mark_huai_outbox_sent(
  p_huai_outbox_id uuid,
  p_send_result jsonb
) returns boolean
language plpgsql
as $$
declare
  v_updated integer;
begin
  update huai_outbox
  set status = 'sent',
      sent_at = now(),
      locked_at = null,
      locked_until = null,
      last_error = null,
      payload = jsonb_set(payload, '{sendResult}', coalesce(p_send_result, '{}'::jsonb), true)
  where huai_outbox_id = p_huai_outbox_id
    and status = 'processing';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;
create table if not exists huai_hook_attempts (
  hook_attempt_id uuid primary key default gen_random_uuid(),
  event_id uuid not null references huai_events(event_id) on delete cascade,
  hook_type text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint huai_hook_attempts_status_check check (status in ('pending', 'processing', 'succeeded', 'failed', 'retry_pending'))
);

create table if not exists huai_gateway_instances (
  gateway_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  machine_label text not null,
  status text not null default 'offline',
  allowed_project_roots jsonb not null default '[]'::jsonb,
  allowed_adapters jsonb not null default '["claude_code","codex","antigravity"]'::jsonb,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  constraint huai_gateway_instances_status_check check (status in ('online', 'offline', 'draining', 'disabled'))
);

create table if not exists huai_execution_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  task_id uuid not null references huai_tasks(task_id) on delete cascade,
  gateway_id uuid not null references huai_gateway_instances(gateway_id) on delete restrict,
  adapter_type text not null,
  status text not null default 'queued',
  attempt_no integer not null default 1,
  idempotency_key text not null unique,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  telemetry jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (task_id, adapter_type, attempt_no),
  constraint huai_execution_attempts_adapter_type_check check (adapter_type in ('claude_code', 'codex', 'antigravity')),
  constraint huai_execution_attempts_status_check check (status in ('queued', 'leased', 'running', 'cancelled', 'failed', 'retry_scheduled', 'completed'))
);

create table if not exists huai_message_bindings (
  binding_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  event_id uuid references huai_events(event_id) on delete set null,
  task_id uuid references huai_tasks(task_id) on delete set null,
  proposal_id uuid references huai_task_proposals(proposal_id) on delete set null,
  approval_id uuid references huai_approvals(approval_id) on delete set null,
  report_id uuid references huai_reports(report_id) on delete set null,
  verification_id uuid references huai_verifications(verification_id) on delete set null,
  telegram_bot_id uuid references huai_telegram_bots(telegram_bot_id) on delete set null,
  telegram_chat_id bigint not null,
  telegram_message_id bigint not null,
  binding_kind text not null,
  direction text not null,
  edit_of_binding_id uuid references huai_message_bindings(binding_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (telegram_chat_id, telegram_message_id),
  constraint huai_message_bindings_kind_check check (binding_kind in ('event', 'task', 'report', 'verification', 'proposal', 'approval')),
  constraint huai_message_bindings_direction_check check (direction in ('inbound', 'outbound'))
);

create table if not exists huai_audit_logs (
  audit_id uuid primary key default gen_random_uuid(),
  room_id uuid references huai_rooms(room_id) on delete set null,
  actor_telegram_user_id bigint,
  actor_id uuid references huai_ai_actors(actor_id),
  action text not null,
  target_table text not null,
  target_id uuid,
  before_data jsonb,
  after_data jsonb,
  reason text,
  idempotency_key text unique,
  created_at timestamptz not null default now()
);

create table if not exists huai_recovery_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  task_id uuid references huai_tasks(task_id) on delete set null,
  snapshot_type text not null,
  storage_uri text not null,
  checksum text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint huai_recovery_snapshots_type_check check (snapshot_type in ('room', 'task', 'artifact', 'full_project'))
);

drop trigger if exists huai_events_append_only on huai_events;
create trigger huai_events_append_only
  before update or delete on huai_events
  for each row execute function huai_reject_ledger_mutation();

alter table huai_rooms enable row level security;
alter table huai_room_members enable row level security;
alter table huai_ai_actors enable row level security;
alter table huai_telegram_bots enable row level security;
alter table huai_telegram_updates enable row level security;
alter table huai_tasks enable row level security;
alter table huai_approvals enable row level security;
alter table huai_verifications enable row level security;
alter table huai_artifacts enable row level security;
alter table huai_events enable row level security;
alter table huai_outbox enable row level security;
alter table huai_task_proposals enable row level security;
alter table huai_task_dependencies enable row level security;
alter table huai_reports enable row level security;
alter table huai_revision_requests enable row level security;
alter table huai_hook_attempts enable row level security;
alter table huai_message_bindings enable row level security;
alter table huai_gateway_instances enable row level security;
alter table huai_execution_attempts enable row level security;
alter table huai_audit_logs enable row level security;
alter table huai_recovery_snapshots enable row level security;
alter table huai_miniapp_decision_cursor enable row level security;
alter table huai_miniapp_decision_processed enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- =====================================================================
-- Mini App 작업판 — huai_tasks 읽기 전용 RLS (additive-only, defense-in-depth)
--
-- 인증 모델은 (B) 채택 — Mini App 은 RLS/JWT 를 거치지 않고 Edge Function 이
-- service_role 로 모든 접근을 중개한다(supabase/functions/miniapp-tasks).
-- 그래서 이 정책은 지금 걸리는 경로가 아니라 두 가지 미래 상황을 위한 마지막
-- 방어선이다: ① 키 관리 실수로 authenticated 세션이 노출되는 경우,
-- ② 나중에 Supabase Auth 기반 직접 접근 경로가 실제로 추가되는 경우.
-- 이 시스템은 현재 GoTrue 를 안 쓰므로 authenticated 세션 자체가 없다 —
-- 즉 지금은 도달 불가(inert)이고, ②가 생기는 순간부터 올바르게 작동한다.
--
-- 기존 경로 무변경: bot-service·local-gateway·orchestrator 는 전부
-- SUPABASE_SERVICE_ROLE_KEY 로만 접속하고, service_role 은 BYPASSRLS 라
-- 정책·GRANT 어느 쪽도 참조하지 않는다.
--
-- ⚠️ 이 블록은 반드시 위의 blanket revoke 뒤에 와야 한다. 앞에 두면
-- `revoke all on all tables ... from authenticated` 가 아래 grant 를 즉시 되돌린다.
-- =====================================================================

-- JWT 의 app_metadata.telegram_user_id 를 안전하게 뽑는다. 세션이 없거나
-- 클레임이 없거나 숫자가 아니면 null — 캐스트 실패로 예외를 던지지 않는다.
-- huai_room_members/huai_rooms 를 건드리지 않으므로 SECURITY DEFINER 가 필요 없다.
create or replace function huai_miniapp_jwt_telegram_user_id()
returns bigint
language sql
stable
as $$
  select case
    when (auth.jwt() -> 'app_metadata' ->> 'telegram_user_id') ~ '^[0-9]+$'
      then (auth.jwt() -> 'app_metadata' ->> 'telegram_user_id')::bigint
    else null
  end;
$$;

-- 이 telegram 사용자가 이 방의 active 멤버이고 방도 active 인지 판정한다.
-- huai_room_members·huai_rooms 는 RLS 가 켜져 있고 정책이 0건이라 기본 거부다.
-- SECURITY INVOKER 로 두면 정책 내부 서브쿼리가 그 기본 거부에 걸려 항상 false 가
-- 되고 정책이 죽은 코드가 된다. SECURITY DEFINER + search_path 고정으로 회피한다.
-- 기존 huai_can_act_in_room() 은 orchestrator 등이 이미 의존하므로 건드리지 않고
-- Mini App 전용 함수를 따로 둔다.
create or replace function huai_miniapp_can_read_task(
  p_room_id uuid,
  p_telegram_user_id bigint
) returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p_telegram_user_id is not null
    and exists (
      select 1
      from huai_room_members rm
      join huai_rooms r on r.room_id = rm.room_id
      where rm.room_id = p_room_id
        and rm.telegram_user_id = p_telegram_user_id
        and rm.status = 'active'
        and r.status = 'active'
    );
$$;

-- 새 함수는 기본적으로 PUBLIC 에 EXECUTE 가 열린다. 최소 권한 원칙에 따라
-- 회수한 뒤 authenticated 에만 다시 준다.
revoke all on function huai_miniapp_jwt_telegram_user_id() from public;
revoke all on function huai_miniapp_can_read_task(uuid, bigint) from public;
grant execute on function huai_miniapp_jwt_telegram_user_id() to authenticated;
grant execute on function huai_miniapp_can_read_task(uuid, bigint) to authenticated;

drop policy if exists huai_tasks_miniapp_member_select on huai_tasks;
create policy huai_tasks_miniapp_member_select on huai_tasks
for select
to authenticated
using (
  huai_miniapp_can_read_task(room_id, huai_miniapp_jwt_telegram_user_id())
);

-- GRANT 와 RLS 는 별개의 관문이라 둘 다 통과해야 한다. anon 에는 주지 않는다 —
-- 서명된 JWT 가 없어 어차피 항상 거부되지만 최소 권한 원칙을 지킨다.
grant select on huai_tasks to authenticated;




