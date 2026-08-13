create or replace function lease_huai_outbox(
  p_limit integer,
  p_locked_until timestamptz,
  p_target_kind text
) returns setof huai_outbox
language plpgsql
as $$
begin
  return query
  with candidates as (
    select o.huai_outbox_id
    from huai_outbox o
    where o.target_kind = p_target_kind
      and (
        (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.locked_until < now())
      )
      and (o.locked_until is null or o.locked_until < now())
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

drop function if exists mark_huai_outbox_sent(uuid, jsonb);

create function mark_huai_outbox_sent(
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

