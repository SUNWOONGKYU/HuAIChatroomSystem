-- 방장이 새 에이전트(페르소나)를 코드 배포 없이 추가할 수 있게 한다.
--
-- 왜 필요한가: 텔레그램은 봇 API로 새 봇 계정을 만들 수 없다(사람이 @BotFather 에서
-- 직접 만들어야 한다) — 그래서 버즈처럼 "새 에이전트 = 새 채팅 멤버"를 완전 자동화할
-- 수는 없다. 대신 기존 4개 봇 중 실행 담당 두 개(claude_leader/codex_leader) 위에
-- 이름 붙은 페르소나를 얹는다. 실행 기계(huai_ai_actors 의 role 4종 고정 상태머신)는
-- 건드리지 않는다 — 라이브로 도는 5개 방이 전부 그 위에서 돌고 있어, 거기를 흔들면
-- 위험이 지금 얻는 값보다 크다.
create table if not exists huai_agent_personas (
  persona_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  persona_name text not null,
  -- 어느 실행 담당 봇 위에 얹히는가. platoon_leader(판단)·auditor(중립 검증)는
  -- 페르소나로 치우치면 안 되는 역할이라 대상에서 뺀다.
  base_role text not null,
  instructions text not null,
  created_by_telegram_user_id bigint,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint huai_agent_personas_base_role_check check (base_role in ('claude_leader', 'codex_leader')),
  constraint huai_agent_personas_status_check check (status in ('active', 'inactive')),
  unique (room_id, persona_name)
);

create index if not exists huai_agent_personas_room_id_idx on huai_agent_personas (room_id);
