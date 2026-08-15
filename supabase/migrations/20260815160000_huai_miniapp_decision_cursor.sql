-- Mini App 결정 재생 폴러용 커서.
--
-- 배경: Mini App 은 승인·거부 결정을 huai_approvals 에 기록만 한다. 그것만으로는
-- 아무 일도 일어나지 않는다 — huai_approvals 를 읽어 상태를 전이시키는 컨슈머가
-- 없기 때문이다(실행 트리거는 오직 huai_outbox 의 local_gateway 행뿐이다).
-- 그래서 봇 서비스가 이 원장을 폴링해 Telegram 승인과 똑같은 커밋 경로로 재생한다.
--
-- 문제: huai_approvals 는 append-only 트리거가 걸려 있어(schema.sql 의
-- huai_approvals UPDATE/DELETE 금지 트리거) "처리됨" 표시를 원장 자체에 쓸 수 없다.
-- 그래서 처리 상태를 별도 테이블 두 개로 분리한다.
--
-- 재실행 안전(멱등). 라이브 DB 에 이미 데이터가 있어도 안전하다.

-- 스캔 시작점 워터마크(싱글톤 1행). 정확성에는 영향이 없다 — 없어도 동작하되
-- 매 주기 huai_approvals 전체를 훑게 될 뿐이다. 방이 늘수록 이 최적화가 커진다.
create table if not exists huai_miniapp_decision_cursor (
  id smallint primary key default 1,
  last_seen_created_at timestamptz not null default '-infinity',
  updated_at timestamptz not null default now(),
  constraint huai_miniapp_decision_cursor_singleton_check check (id = 1)
);

-- 폴러가 판단을 끝낸 승인 행. 행의 존재 자체가 "다시 재생하지 않는다"는 뜻이다.
-- 실패는 여기 남기지 않는다 — 남기지 않아야 다음 주기에 재시도된다.
--
-- outcome 값의 뜻:
--   replayed                  기존 커밋 경로로 재생 완료
--   skipped_duplicate         같은 (room_id, entity_ref, stage) 결정이 이미 재생됨
--   skipped_unsupported_stage 대응하는 콜백 액션이 orchestrator 에 없는 단계
--   skipped_unauthorized      결정자가 그 방에서 그 결정을 내릴 권한이 없음
create table if not exists huai_miniapp_decision_processed (
  approval_id uuid primary key references huai_approvals(approval_id) on delete cascade,
  outcome text not null,
  detail text,
  processed_at timestamptz not null default now(),
  constraint huai_miniapp_decision_processed_outcome_check
    check (outcome in ('replayed', 'skipped_duplicate', 'skipped_unsupported_stage', 'skipped_unauthorized'))
);

-- 폴러는 미처리 행을 created_at 순으로 훑는다.
create index if not exists huai_miniapp_decision_processed_processed_at_idx
  on huai_miniapp_decision_processed (processed_at);

alter table huai_miniapp_decision_cursor enable row level security;
alter table huai_miniapp_decision_processed enable row level security;

-- =====================================================================
-- 롤백 (수동, 실행되지 않음)
-- =====================================================================
--
-- drop index if exists huai_miniapp_decision_processed_processed_at_idx;
-- drop table if exists huai_miniapp_decision_processed;
-- drop table if exists huai_miniapp_decision_cursor;
