-- 게이트웨이가 자기 앞으로 온 일만 리스하게 한다.
--
-- 방마다 게이트웨이를 하나씩 띄우자마자 드러난 결함이다. 리스에는 target_kind 조건만 있고
-- 어느 게이트웨이 앞으로 온 행인지는 보지 않았다. 그래서 개발방 작업을 상증세법·DCF
-- 게이트웨이가 먼저 집어가 project-path-not-allowed 로 실패시켰고, 방에는 "작업 실행 실패"가
-- 떴다. 실패가 아니라 남의 일을 집은 것이다.
--
-- 행의 수신자는 target JSON 의 gatewayId 에 이미 적혀 있다. 그걸 리스 조건으로 쓴다.
-- p_gateway_id 가 null 이면 예전과 같이 전부 대상 — telegram_bot 리스는 그대로 돈다.

drop function if exists lease_huai_outbox(integer, timestamptz, text);

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
