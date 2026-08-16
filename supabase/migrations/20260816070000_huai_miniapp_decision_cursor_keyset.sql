-- Mini App 결정 폴러 커서를 (created_at, approval_id) 두 축으로 만든다.
--
-- 커서가 created_at 하나뿐이고 조회가 created_at >= 커서 라, 같은 시각을 가진 행이
-- 한 페이지(기본 20건)보다 많으면 폴러가 그 자리에서 영원히 맴돈다: 매 주기 같은
-- 앞 20건을 가져오고, 커서를 그 페이지 마지막 행의 시각으로 올리는데 그 시각이
-- 이미 커서와 같아서 한 칸도 전진하지 못한다.
--
-- 라이브에서 실제로 멎었다. 쌓여 있던 제안 122건을 한 번에 취소 기록하면서 전부
-- 같은 마이크로초(2026-08-15T23:04:12.937488+00)로 들어갔고, 그 뒤로 방장이 작업
-- 현황판에서 누른 최종 승인이 폴러에 영영 도달하지 못했다. 원장에는 남는데 작업은
-- 움직이지 않는 상태였다.
--
-- 정렬은 이미 (created_at asc, approval_id asc) 두 축이었다. 커서만 한 축이라
-- 어긋나 있었을 뿐이다.
--
-- 롤백:
--   alter table huai_miniapp_decision_cursor drop column if exists last_seen_approval_id;

alter table huai_miniapp_decision_cursor
  add column if not exists last_seen_approval_id uuid;

-- 기존 행은 커서 시각에 걸린 마지막 approval_id 로 채운다. null 이면 폴러가
-- created_at >= 커서 로 동작해(예전과 동일) 안전하게 시작한다.
update huai_miniapp_decision_cursor
set last_seen_approval_id = (
  select approval_id
  from huai_approvals
  where created_at = huai_miniapp_decision_cursor.last_seen_created_at
  order by approval_id desc
  limit 1
)
where id = 1
  and last_seen_approval_id is null;
