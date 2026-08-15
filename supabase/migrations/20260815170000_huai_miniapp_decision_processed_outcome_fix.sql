-- huai_miniapp_decision_processed.outcome 체크 제약에 skipped_already_executed 를 더한다.
--
-- 20260815160000 을 쓸 때 폴러의 outcome 목록을 4개로 잡았는데, 그 뒤 폴러에
-- eventAlreadyRecorded 검사가 추가되면서 다섯 번째 값 skipped_already_executed 가
-- 생겼다. 제약을 같이 갱신하지 않아 라이브 기동 직후 이 값을 쓰는 순간 23514 로
-- 거부됐다.
--
-- 그 결과가 정확히 이 폴러가 없애려던 유령 실패다 — markProcessed 가 실패하면
-- 그 행은 처리 완료로 안 남고, 다음 주기에 다시 집어서 또 실패한다(3초마다 무한
-- 반복). 실측으로 확인했다.
--
-- failed 는 의도적으로 제외한다. 폴러는 failed 를 기록하지 않고 다음 주기에
-- 재시도하도록 두는 것이 설계다(일시적 네트워크 오류 등). 제약에서 빠져 있는 것이
-- 그 설계를 강제하는 안전장치 역할도 한다.
--
-- 재실행 안전(멱등).

alter table huai_miniapp_decision_processed
  drop constraint if exists huai_miniapp_decision_processed_outcome_check;

alter table huai_miniapp_decision_processed
  add constraint huai_miniapp_decision_processed_outcome_check
  check (outcome in (
    'replayed',
    'skipped_duplicate',
    'skipped_unsupported_stage',
    'skipped_unauthorized',
    'skipped_already_executed'
  ));

-- =====================================================================
-- 롤백 (수동, 실행되지 않음)
-- =====================================================================
--
-- alter table huai_miniapp_decision_processed
--   drop constraint if exists huai_miniapp_decision_processed_outcome_check;
--
-- alter table huai_miniapp_decision_processed
--   add constraint huai_miniapp_decision_processed_outcome_check
--   check (outcome in ('replayed', 'skipped_duplicate', 'skipped_unsupported_stage', 'skipped_unauthorized'));
