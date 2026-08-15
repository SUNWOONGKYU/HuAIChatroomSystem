-- Add room scoping to huai_outbox and make lease_huai_outbox fair across rooms.
--
-- Problem: lease_huai_outbox ordered strictly by created_at asc with no room
-- awareness, so a single room that queues hundreds of outbox rows could keep
-- winning every lease call and starve every other room's turn.
--
-- Fix:
--   1. Add huai_outbox.room_id (nullable FK to huai_rooms), backfilled from
--      huai_events, with a supporting index for per-room scans.
--   2. Rewrite lease_huai_outbox to cap how many rows any single room can
--      contribute to a lease batch (per-room fairness), while still using
--      FOR UPDATE SKIP LOCKED for correctness under concurrent lease calls.
--
-- Idempotent: safe to re-run against a live database with existing rows.

-- =====================================================================
-- 1. huai_outbox.room_id
-- =====================================================================

alter table huai_outbox
  add column if not exists room_id uuid references huai_rooms(room_id) on delete set null;

-- Backfill room_id from the originating event, where one exists.
update huai_outbox o
set room_id = e.room_id
from huai_events e
where o.event_id = e.event_id
  and o.room_id is null;

-- Rows where event_id is null (or whose event was hard-deleted, e.g. via the
-- huai_events -> huai_outbox ON DELETE CASCADE, or a room deletion cascading
-- through huai_events and setting this FK null) will keep room_id = null.
-- lease_huai_outbox below treats all such null-room rows as one shared
-- fairness bucket, grouped with `is not distinct from` (not `=`, since
-- `null = null` is never true in SQL and would otherwise exclude them from
-- every room-scoped comparison).
comment on column huai_outbox.room_id is
  'Room that owns this outbox row, backfilled from huai_events.room_id. '
  'Null when event_id is null or the source event no longer exists; '
  'lease_huai_outbox groups all null-room rows into one shared fairness bucket '
  'via IS NOT DISTINCT FROM.';

create index if not exists huai_outbox_target_room_created_idx
  on huai_outbox (target_kind, room_id, created_at);

-- =====================================================================
-- 2. lease_huai_outbox: per-room fairness via LATERAL cap, not a window
--    function, because Postgres disallows window functions together with a
--    locking clause (FOR UPDATE) at the same query level, and FOR UPDATE
--    SKIP LOCKED is still required: without it, two concurrent lease calls
--    could both select the same top-N candidate ids before either locks
--    anything, and then both UPDATE those same rows (a real double-lease
--    bug, since the UPDATE only re-checks the join key, not the original
--    WHERE filter).
-- =====================================================================

create or replace function lease_huai_outbox(
  p_limit integer,
  p_locked_until timestamptz,
  p_target_kind text
) returns setof huai_outbox
language plpgsql
as $$
declare
  v_active_room_count integer;
  v_per_room_cap integer;
begin
  -- Step 1: how many distinct rooms currently have eligible rows for this
  -- target kind. `select distinct room_id` groups nulls together (SQL
  -- DISTINCT/GROUP BY treat NULL = NULL as one group, unlike the `=`
  -- operator), so all null-room rows count as a single "room".
  select count(*)
  into v_active_room_count
  from (
    select distinct o.room_id
    from huai_outbox o
    where o.target_kind = p_target_kind
      and (
        (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.locked_until < now())
      )
      and (o.locked_until is null or o.locked_until < now())
  ) active_rooms;

  -- Step 2: split the requested batch size evenly across active rooms,
  -- rounding up, with a floor of 1 so every active room can contribute at
  -- least one row even when p_limit is smaller than the room count.
  v_per_room_cap := greatest(
    1,
    ceil(greatest(p_limit, 0)::numeric / greatest(v_active_room_count, 1))
  )::int;

  return query
  with active_rooms as (
    select distinct o.room_id
    from huai_outbox o
    where o.target_kind = p_target_kind
      and (
        (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
        or (o.status = 'processing' and o.locked_until < now())
      )
      and (o.locked_until is null or o.locked_until < now())
  ),
  -- Step 3: for each active room, take up to v_per_room_cap of its oldest
  -- eligible rows. No FOR UPDATE here yet, so the window/aggregate-style
  -- per-room ranking (via LATERAL + LIMIT instead of row_number() OVER, to
  -- avoid mixing a window function with a locking clause) is legal.
  room_capped as (
    select ranked.huai_outbox_id
    from active_rooms a
    cross join lateral (
      select o.huai_outbox_id
      from huai_outbox o
      where o.target_kind = p_target_kind
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
  -- Step 4: from the room-capped pool, pick the actual lease batch. This
  -- SELECT has no window function / aggregate / GROUP BY / DISTINCT at its
  -- own query level (only a join, ORDER BY, and LIMIT), so FOR UPDATE SKIP
  -- LOCKED is legal here and still guards against double-leasing under
  -- concurrent calls.
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

-- =====================================================================
-- 3. Rollback (manual, commented out — not executed by this migration)
-- =====================================================================
--
-- drop index if exists huai_outbox_target_room_created_idx;
--
-- alter table huai_outbox drop column if exists room_id;
--
-- create or replace function lease_huai_outbox(
--   p_limit integer,
--   p_locked_until timestamptz,
--   p_target_kind text
-- ) returns setof huai_outbox
-- language plpgsql
-- as $$
-- begin
--   return query
--   with candidates as (
--     select o.huai_outbox_id
--     from huai_outbox o
--     where o.target_kind = p_target_kind
--       and (
--         (o.status in ('pending', 'retry_pending') and o.next_attempt_at <= now())
--         or (o.status = 'processing' and o.locked_until < now())
--       )
--       and (o.locked_until is null or o.locked_until < now())
--     order by o.created_at asc
--     limit greatest(p_limit, 0)
--     for update skip locked
--   )
--   update huai_outbox o
--   set status = 'processing',
--       attempts = attempts + 1,
--       locked_at = now(),
--       locked_until = p_locked_until
--   from candidates c
--   where o.huai_outbox_id = c.huai_outbox_id
--   returning o.*;
-- end;
-- $$;
