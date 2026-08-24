-- 방의 장기 기억.
--
-- 리더는 방의 최근 40턴만 프롬프트로 받는다(supabase-store.ts fetchRecentRoomTurns).
-- 그 창을 넘어간 일은 아예 모른다 — "3주 전에 그건 왜 그렇게 정했지"에 답할 수 없고,
-- 이미 끝난 작업을 다시 제안한다(라이브에서 달걀 게임이 그랬다: 진행 중 8건만 보고
-- "이미 목록에 있음"이라고 답했는데, 끝난 작업은 시야에 없었다).
--
-- 그래서 하루치 대화를 요약해 여기 쌓고, 판단할 때 최근 며칠치를 같이 넣는다.
-- 요약은 아카이브(huai_archive_manifest)와 다른 물건이다. 아카이브는 지우기 전에 반드시
-- 있어야 하는 무손실 사본이고, 이건 읽히기 위한 손실 압축이다. 그래서 실패해도 아카이브를
-- 막지 않고, 이 표가 비어도 데이터가 사라진 것은 아니다.

create table if not exists huai_room_memory (
  memory_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  memory_date date not null,
  -- 그날 방에서 무슨 일이 있었나. 사람이 읽을 문장.
  summary text not null,
  -- 그날 반복해서 지적된 것. 감사 프롬프트에 실어 같은 실수를 다시 잡게 한다.
  recurring_findings text,
  model text,
  created_at timestamptz not null default now(),
  -- 같은 날을 두 번 요약해도 한 줄. 다시 돌리면 덮어쓴다(요약은 언제든 다시 만들 수 있다).
  unique (room_id, memory_date)
);

create index if not exists huai_room_memory_room_date_idx
  on huai_room_memory (room_id, memory_date desc);
