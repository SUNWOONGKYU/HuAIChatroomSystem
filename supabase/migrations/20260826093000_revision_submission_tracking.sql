-- Expand the existing revision-request ledger so a completed fix can be traced
-- to its submission and routed by change type. Existing rows remain valid.
alter table huai_revision_requests
  add column if not exists fix_submission_id text,
  add column if not exists changed_scope text,
  add column if not exists submitted_at timestamptz;

alter table huai_revision_requests
  drop constraint if exists huai_revision_requests_changed_scope_check;

alter table huai_revision_requests
  add constraint huai_revision_requests_changed_scope_check
  check (changed_scope is null or changed_scope in ('format_only', 'content', 'scope_change'));

create unique index if not exists huai_revision_requests_one_open_per_task
on huai_revision_requests (task_id)
where status = 'open';
