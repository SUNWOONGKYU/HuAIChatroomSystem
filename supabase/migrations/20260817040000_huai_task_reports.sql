-- 실행 결과·감사 보고의 전문을 따로 보관한다.
--
-- 방에는 앞부분만 보내고 나머지는 현황판에서 읽는다. 긴 보고가 방을 도배하면 그 방의
-- 대화가 통째로 안 읽히기 때문이다(라이브에서 감사 보고 하나가 화면 여러 장을 채웠다).
--
-- 왜 huai_events 를 그대로 쓰지 않는가: 이벤트·아웃박스는 작업 1건에 십수 행씩 쌓여
-- 용량의 대부분을 차지하므로 30일 롤링으로 지운다. 그런데 전문까지 같이 지워지면
-- "전문 보기" 버튼이 30일 뒤 빈 화면이 된다 — 죽은 버튼이 된다.
--
-- 전문만 떼면 작업 1건에 2행(실행 결과 + 감사 보고), 행당 2~4KB 다. 지금 페이스로 연 7MB
-- 수준이라 남겨도 부담이 없고, 지워서 얻는 것도 없다.

create table if not exists huai_task_reports (
  report_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  task_id uuid references huai_tasks(task_id) on delete cascade,
  attempt_id text not null,
  -- execution = 작업자가 낸 실행 결과, audit = 검증자가 낸 감사 보고.
  kind text not null,
  -- 방에 보낸 것과 같은 문장. 자르지 않은 원문이다.
  body text not null,
  -- 방에 실제로 나간 봇. 누가 말했는지가 화면과 어긋나면 안 된다.
  bot_role text not null,
  telegram_message_thread_id text,
  created_at timestamptz not null default now(),
  constraint huai_task_reports_kind_check check (kind in ('execution', 'audit')),
  -- 같은 실행이 두 번 기록되지 않게. 리스 만료로 같은 attempt 가 중복 실행될 수 있다.
  unique (attempt_id, kind)
);

create index if not exists huai_task_reports_task_idx
  on huai_task_reports (task_id, created_at desc);

create index if not exists huai_task_reports_room_idx
  on huai_task_reports (room_id, created_at desc);
