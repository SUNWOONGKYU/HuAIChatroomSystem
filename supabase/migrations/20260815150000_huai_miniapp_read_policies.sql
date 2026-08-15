-- Mini App 작업판 — huai_tasks 읽기 전용 RLS 정책 (additive-only, defense-in-depth).
--
-- 배경: 인증 모델은 (B) 채택 — Mini App은 RLS/JWT 를 거치지 않고 Edge Function이
-- service_role 로 모든 데이터 접근을 중개한다(supabase/functions/miniapp-tasks 참고).
-- 그래서 이 정책은 "지금 당장 걸리는 경로"가 아니라 두 가지 미래 상황에 대비한 마지막
-- 방어선이다: ① anon/service_role 키 관리 실수로 authenticated 세션이 노출되는 경우,
-- ② 나중에 실제로 Supabase Auth 기반 직접 접근(JWT 발급) 경로가 추가되는 경우.
-- 이 시스템은 현재 Supabase Auth(GoTrue)를 전혀 쓰지 않으므로 'authenticated' 세션 자체가
-- 존재하지 않는다 — 즉 이 정책은 지금은 도달 불가능(inert)하고, 위 ②가 실제로 생겼을 때
-- 그 순간부터 올바르게 작동하도록 미리 준비해 둔 것이다.
--
-- 기존 접근 경로 무변경: bot-service/local-gateway/orchestrator 는 전부 SUPABASE_SERVICE_ROLE_KEY
-- 로만 접속한다(직접 확인 근거는 이 작업 보고에 file:line 으로 첨부). service_role 은
-- Supabase/Postgres 에서 BYPASSRLS 속성을 가지므로 RLS 정책·GRANT 어느 쪽도 참조하지
-- 않는다 — 이 마이그레이션은 그 경로에 어떤 영향도 주지 않는다.
--
-- 42P17(무한재귀) 함정 회피 (buzzlab-nextjs 024_fix_profiles_rls_recursion.sql,
-- 062_profiles_security_lockdown.sql:11-13 참고):
--   huai_room_members, huai_rooms 는 이미 RLS 가 켜져 있고(schema.sql) 정책이 0건이라
--   기본적으로 "소유자·BYPASSRLS 제외 전원 거부"다. 만약 huai_tasks 의 정책이 SECURITY
--   INVOKER 상태로 이 두 테이블을 직접 서브쿼리하면, 그 서브쿼리 자체가 같은 이유로
--   항상 거부되어 정책이 "항상 false"가 되어버린다(자기참조 재귀는 아니지만 같은 계열의
--   함정 — 회피하지 않으면 정책이 죽은 코드가 된다). buzzlab 024 의 해법(SECURITY DEFINER
--   함수로 RLS 우회 판정 + search_path 고정)을 그대로 적용하되, 기존 huai_can_act_in_room()
--   함수는 다른 코드(orchestrator 등)가 이미 의존하고 있어 그 정의를 바꾸지 않고
--   Mini App 전용 새 함수를 additive 로 만든다.
--
-- 롤백:
--   drop policy if exists huai_tasks_miniapp_member_select on huai_tasks;
--   revoke select on huai_tasks from authenticated;
--   drop function if exists huai_miniapp_can_read_task(uuid, bigint);
--   drop function if exists huai_miniapp_jwt_telegram_user_id();

-- JWT 의 app_metadata.telegram_user_id 클레임을 안전하게 추출한다.
-- 세션이 없거나(auth.jwt() = null) 클레임이 없거나 숫자가 아니면 null 을 반환한다 —
-- 캐스트 실패로 예외를 던지지 않는다(정규식으로 먼저 형식을 확인한 뒤에만 캐스트한다).
-- 이 함수는 huai_room_members/huai_rooms 를 건드리지 않으므로 SECURITY DEFINER 가 필요 없다.
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

-- 이 telegram 사용자가 이 방의 active 멤버이고 방도 active 상태인지 판정한다.
-- SECURITY DEFINER + search_path 고정(정의자 권한 악용 방지, buzzlab 024:19-20 과 동일 패턴)으로
-- huai_room_members/huai_rooms 자신의 RLS(정책 0건 = 기본 거부)를 우회해서 정상적으로
-- 판정할 수 있게 한다. 함수 소유자(마이그레이션 적용 롤, 통상 postgres)는 테이블 소유자라
-- FORCE ROW LEVEL SECURITY 가 걸려 있지 않은 한 그 테이블들의 RLS 자체에서 애초에 면제된다.
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

-- 새 함수는 기본적으로 PUBLIC 에 EXECUTE 가 열린다(Postgres 기본 동작) — 최소 권한 원칙에
-- 따라 회수한 뒤 authenticated 에만 다시 준다(062_profiles_security_lockdown.sql 의
-- "REVOKE 후 필요한 컬럼/롤만 재허용" 패턴과 동일한 취지).
revoke all on function huai_miniapp_jwt_telegram_user_id() from public;
revoke all on function huai_miniapp_can_read_task(uuid, bigint) from public;
grant execute on function huai_miniapp_jwt_telegram_user_id() to authenticated;
grant execute on function huai_miniapp_can_read_task(uuid, bigint) to authenticated;

-- 멱등 관용구: RLS 는 schema.sql 에서 이미 켜져 있지만 재실행 안전을 위해 다시 명시한다.
alter table huai_tasks enable row level security;

drop policy if exists huai_tasks_miniapp_member_select on huai_tasks;
create policy huai_tasks_miniapp_member_select on huai_tasks
for select
to authenticated
using (
  huai_miniapp_can_read_task(room_id, huai_miniapp_jwt_telegram_user_id())
);

-- GRANT 는 정책과 별개의 관문이다(Postgres는 GRANT 와 RLS 를 둘 다 통과해야 접근을 허용한다).
-- anon 에는 부여하지 않는다 — anon 세션은 애초에 유효한 telegram_user_id 클레임을 가질 수
-- 없으므로(서명된 JWT 가 없음) 부여해도 항상 거부되지만, 최소 권한 원칙상 필요한 롤에만 준다.
grant select on huai_tasks to authenticated;
