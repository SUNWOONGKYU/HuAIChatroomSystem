-- FK 컬럼에 명시적 인덱스를 추가한다.
--
-- Postgres 는 외래키에 자동으로 인덱스를 만들지 않는다. 아래 컬럼들은 각자의 상위
-- 엔티티(작업·방)로 필터링하는 조회(예: 방 하나의 이벤트 목록, 작업 하나의 검증 이력,
-- 방 하나의 메시지-엔티티 바인딩 조회)에 그대로 쓰이는데 인덱스가 없어 순차 스캔으로
-- 처리된다 — 방·작업 수가 늘수록 이 조회들이 선형으로 느려진다.
--
-- huai_task_reports/huai_agent_personas/huai_task_quizzes 는 생성 시점에 이미 인덱스를
-- 같이 넣었다(각 마이그레이션 참고). 초기 스키마(20260810073433)에서 빠진 나머지를
-- 여기서 채운다. create index if not exists 라 재실행해도 안전하다.

create index if not exists huai_verifications_task_idx
  on huai_verifications (task_id);

create index if not exists huai_events_room_idx
  on huai_events (room_id, created_at desc);

create index if not exists huai_events_task_idx
  on huai_events (task_id);

create index if not exists huai_message_bindings_task_idx
  on huai_message_bindings (task_id);

create index if not exists huai_message_bindings_room_idx
  on huai_message_bindings (room_id);
