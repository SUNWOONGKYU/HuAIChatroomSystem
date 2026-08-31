-- huai_miniapp_decision_processed.outcome 체크 제약에 'failed' 를 더한다.
--
-- 왜: 폴러는 실패한 결정을 processed 로 남기지 않고 다음 주기에 다시 시도한다. 일시적
-- 실패(네트워크·Supabase 오류)에는 그게 맞지만, 구조적 실패는 몇 번을 다시 돌려도 같은
-- 답이라 영원히 재시도된다. 2026-08-31 에 운영 서비스를 실제로 띄워 관측했다 — 복구
-- 리허설로 archived 된 방의 승인 행 2건이 `unknown-room` 으로 매 주기 실패하며 로그를
-- 계속 채웠고, Supabase 호출도 그만큼 낭비하고 있었다.
--
-- 그래서 구조적 실패(unknown-room, missing-entity-ref)는 processed 로 종결해 재시도를
-- 끊도록 폴러를 고쳤는데, 이 제약이 'failed' 를 막고 있어 그 기록이 400(23514)으로
-- 거부됐다. 즉 코드만 고쳐서는 닫히지 않는 결함이었다.
--
-- 종결해도 근거는 남는다 — outcome='failed' 와 detail(실패 사유)이 이 테이블에 남으므로
-- 운영자가 무엇이 왜 종결됐는지 보고, 필요하면 그 행을 지워 재구동할 수 있다.
--
-- 20260815170000 이 같은 이유(폴러가 쓰는 outcome 이 늘어남)로 이 제약을 한 번 넓혔다 —
-- 그때 정한 5개에 'failed' 를 더한다.
alter table huai_miniapp_decision_processed
  drop constraint if exists huai_miniapp_decision_processed_outcome_check;

alter table huai_miniapp_decision_processed
  add constraint huai_miniapp_decision_processed_outcome_check
  check (outcome in (
    'replayed',
    'skipped_duplicate',
    'skipped_unsupported_stage',
    'skipped_unauthorized',
    'skipped_already_executed',
    'failed'
  ));

-- =====================================================================
-- 롤백 (수동, 실행되지 않음)
-- =====================================================================
--
-- 되돌리려면 'failed' 를 뺀 목록으로 제약을 다시 만든다. 단 그 전에 outcome='failed'
-- 행을 먼저 지워야 한다 — 남아 있으면 제약 추가가 실패한다.
--
-- delete from huai_miniapp_decision_processed where outcome = 'failed';
-- alter table huai_miniapp_decision_processed
--   drop constraint if exists huai_miniapp_decision_processed_outcome_check;
-- alter table huai_miniapp_decision_processed
--   add constraint huai_miniapp_decision_processed_outcome_check
--   check (outcome in ('replayed','skipped_duplicate','skipped_unsupported_stage','skipped_unauthorized','skipped_already_executed'));
