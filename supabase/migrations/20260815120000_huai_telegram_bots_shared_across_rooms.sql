-- 공통 봇 4개를 여러 방(room)에서 재사용할 수 있게 한다.
--
-- 지금까지는 huai_telegram_bots.actor_id 가 not null + unique 라
-- 봇 1개가 room 1개의 actor 에만 묶였다. huai_ai_actors 는 room 마다 역할별로
-- 따로 생기므로(unique(room_id, role)), 같은 bot_username 으로 두 번째 방을
-- 시딩하면 bot_username unique 제약에 걸려 실패했다.
--
-- 봇 계정 자체는 room 과 무관한 존재(role 하나에 실제 Telegram 봇 계정 하나)이므로
-- role 을 봇의 정체성으로 직접 갖게 하고, actor_id 는 정보성 참조로만 남긴다.
-- room 별로 실제 실행을 맡을 actor 는 huai_ai_actors 를 room_id + role 로
-- 조회해서 얻는다(런타임 코드에서 처리, 이 테이블을 거치지 않는다).

alter table huai_telegram_bots
  add column if not exists role text;

-- backfill 은 기존 actor_id -> huai_ai_actors.role 조인으로 채운다. 이 시점의
-- actor_id 는 마이그레이션 이전 스키마 기준 not null + FK 로 항상 실제 존재하는
-- huai_ai_actors 행을 가리키도록 강제돼 있었으므로(참조 무결성), 조인이 매칭되지
-- 않는 "고아" actor_id 행은 구조적으로 있을 수 없다. 혹시라도 매칭되지 않아
-- role 이 null 로 남으면 바로 아래 not null 제약이 마이그레이션을 중단시킨다 —
-- 이건 의도된 동작이다. role 은 이제 봇의 정체성 그 자체라, 매칭 실패를
-- 임의 기본값으로 조용히 덮으면 봇 라우팅이 조용히 틀어질 수 있다(예: 다른
-- role 로 오인). 데이터 정합성이 깨진 신호이므로 사람이 직접 들여다보고
-- 고쳐야지, 마이그레이션이 자동으로 넘어가면 안 된다.
update huai_telegram_bots b
set role = a.role
from huai_ai_actors a
where b.actor_id = a.actor_id
  and b.role is null;

alter table huai_telegram_bots
  alter column role set not null;

-- 같은 파일의 다른 alter 들(actor_id_key, actor_id_fkey)과 마찬가지로 재실행
-- 가능하게 drop 후 add 로 맞춘다. ADD CONSTRAINT 는 IF NOT EXISTS 를 지원하지
-- 않아 이 guard 가 없으면 재적용 시 "constraint already exists" 로 실패한다.
alter table huai_telegram_bots
  drop constraint if exists huai_telegram_bots_role_check;

alter table huai_telegram_bots
  add constraint huai_telegram_bots_role_check
  check (role in ('platoon_leader', 'claude_leader', 'codex_leader', 'auditor'));

alter table huai_telegram_bots
  alter column actor_id drop not null;

alter table huai_telegram_bots
  drop constraint if exists huai_telegram_bots_actor_id_key;

-- actor 가 삭제돼도 봇 자체(계정·webhook secret)는 살아남아야 한다.
-- actor_id 는 이제 정보성 참조일 뿐이다.
alter table huai_telegram_bots
  drop constraint if exists huai_telegram_bots_actor_id_fkey;

alter table huai_telegram_bots
  add constraint huai_telegram_bots_actor_id_fkey
  foreign key (actor_id) references huai_ai_actors(actor_id) on delete set null;
