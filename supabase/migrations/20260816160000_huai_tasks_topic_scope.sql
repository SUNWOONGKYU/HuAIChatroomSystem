-- 작업이 어느 포럼 주제에서 시작됐는지 기록한다.
--
-- 방 하나 안에서 주제를 갈라 쓰면(달걀 깨기 게임 / 시스템 구현 …) 작업 흐름도 갈린다.
-- 그런데 작업 현황판은 방 단위라, 어느 주제에서 열어도 방의 모든 작업이 섞여 나왔다.
-- 주제가 늘수록 그 목록은 못 쓰게 된다.
--
-- 값이 없는 행은 주제 없이 만들어진 작업이다(일반 그룹, 또는 포럼의 General). 그건
-- 지우거나 추측해 채우지 않는다 — 방 전체 현황판에서 그대로 보인다.

alter table huai_tasks
  add column if not exists telegram_message_thread_id text;

-- 현황판은 "이 방 + 이 주제"로 연다. 방만으로 거르던 조회에 조건이 하나 붙는 셈이라
-- 방 인덱스만으로는 주제가 많아질수록 훑는 양이 준다.
create index if not exists huai_tasks_room_thread_idx
  on huai_tasks (room_id, telegram_message_thread_id);
