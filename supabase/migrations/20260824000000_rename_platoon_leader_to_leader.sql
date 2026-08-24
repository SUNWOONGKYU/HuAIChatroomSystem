-- "platoon_leader" 역할 이름을 "leader"로 바꾼다.
--
-- 왜: PLATOON/소대장이라는 군대 용어가 실체(그런 다중 분대 편제가 이 시스템 안에
-- 없다)와 안 맞는다는 지적(PO, 2026-08-24)에 따라 코드·문서 전체에서 이 용어를
-- 뺐다. 이 마이그레이션은 그 이름이 이미 라이브 DB의 CHECK 제약과 기존 행 값으로
-- 박혀 있는 부분을 코드와 맞춘다 — 제약을 먼저 풀고, 행 값을 바꾸고, 제약을
-- 다시 leader 로 좁힌다(그 반대 순서면 UPDATE 가 제약에 막힌다).
alter table huai_room_members drop constraint if exists huai_room_members_role_check;
alter table huai_ai_actors drop constraint if exists huai_ai_actors_role_check;
alter table huai_telegram_bots drop constraint if exists huai_telegram_bots_role_check;

update huai_room_members set role = 'leader' where role = 'platoon_leader';
update huai_ai_actors set role = 'leader' where role = 'platoon_leader';
update huai_telegram_bots set role = 'leader' where role = 'platoon_leader';

alter table huai_room_members add constraint huai_room_members_role_check
  check (role in ('owner', 'human_member', 'leader', 'claude_leader', 'codex_leader', 'auditor', 'operator'));
alter table huai_ai_actors add constraint huai_ai_actors_role_check
  check (role in ('leader', 'claude_leader', 'codex_leader', 'auditor'));
alter table huai_telegram_bots add constraint huai_telegram_bots_role_check
  check (role in ('leader', 'claude_leader', 'codex_leader', 'auditor'));
