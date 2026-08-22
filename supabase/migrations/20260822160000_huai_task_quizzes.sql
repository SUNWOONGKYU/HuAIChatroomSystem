-- 인지부채(Cognitive Debt) 방지 — 최종승인 전 이해도 퀴즈.
--
-- 왜 필요한가: 방장이 "완료" 버튼을 누르는 것과 "무엇이 바뀌었는지 아는 것"은 별개다.
-- 파일을 실제로 바꾼 작업만 대상으로, 완료 보고에 실린 객관식 3문항을 다 맞혀야
-- miniapp-approve 가 final_approve 결정을 받아준다. 정답(correct)은 서버(edge function,
-- service-role)만 읽는다 — 클라이언트에 내려가는 조회 응답에는 항상 정답을 뺀다.
create table if not exists huai_task_quizzes (
  task_id uuid primary key references huai_tasks(task_id) on delete cascade,
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  -- 오답 시 보여줄 설명(워크스루). 작업자가 완료 보고와 함께 낸 것을 그대로 쓴다.
  summary text not null,
  -- [{ "q": "...", "choices": ["...", "...", "...", "..."], "correct": 0 }] x3.
  questions jsonb not null,
  passed boolean not null default false,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint huai_task_quizzes_questions_length check (jsonb_array_length(questions) = 3)
);

create index if not exists huai_task_quizzes_room_idx on huai_task_quizzes (room_id);

-- 오답 시도 횟수를 원자적으로 올린다. edge function 이 읽고-고쳐-쓰면 동시 제출(재시도)
-- 사이에 카운트가 유실될 수 있어 RPC 로 둔다.
create or replace function huai_increment_task_quiz_attempts(p_task_id uuid)
returns void
language sql
as $$
  update huai_task_quizzes
  set attempts = attempts + 1, updated_at = now()
  where task_id = p_task_id;
$$;
