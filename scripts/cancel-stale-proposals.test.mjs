import assert from "node:assert/strict";
import test from "node:test";
import { buildCancellationRows, selectStaleProposals } from "./cancel-stale-proposals.mjs";

test("이미 결정된 제안은 다시 취소하지 않는다", () => {
  const stale = selectStaleProposals(
    [
      event("room-a", { proposalId: "p_1", title: "결정됨" }),
      event("room-a", { proposalId: "p_2", title: "미결" })
    ],
    ["p_1"]
  );

  assert.deepEqual(stale.map((item) => item.proposalId), ["p_2"]);
});

test("같은 제안이 이벤트로 여러 번 남아도 한 번만 취소한다", () => {
  const stale = selectStaleProposals(
    [
      event("room-a", { proposalId: "p_1" }),
      event("room-a", { proposalId: "p_1" }),
      event("room-a", { proposalId: "p_1" })
    ],
    []
  );

  assert.equal(stale.length, 1);
});

test("리더 기획 요청은 재고가 아니다", () => {
  // payload.stage='leader_planning_requested' 는 proposalId 가 없고 작업 현황판도 안 보여준다.
  // 이걸 취소 대상에 넣으면 원장에 entity_ref 가 없는 쓰레기 행이 쌓인다.
  const stale = selectStaleProposals(
    [
      event("room-a", { stage: "leader_planning_requested", planningId: "planning_1", triggeringText: "뭐 해줘" }),
      event("room-a", { proposalId: "p_1" })
    ],
    []
  );

  assert.deepEqual(stale.map((item) => item.proposalId), ["p_1"]);
});

test("방을 넘어 섞이지 않는다", () => {
  const stale = selectStaleProposals(
    [event("room-a", { proposalId: "p_a" }), event("room-b", { proposalId: "p_b" })],
    []
  );

  assert.deepEqual(
    stale.map((item) => [item.roomId, item.proposalId]),
    [["room-a", "p_a"], ["room-b", "p_b"]]
  );
});

test("취소 기록은 작업 현황판이 미결을 가리는 조건과 같은 stage 로 들어간다", () => {
  // 작업 현황판은 stage='task_approval' 만 보고 미결 여부를 판정한다
  // (supabase/functions/miniapp-proposals/deps.ts). 'cancellation' 으로 넣으면
  // 원장에는 남는데 화면에서는 안 사라져서 "정리했는데 그대로"가 된다.
  const rows = buildCancellationRows(
    [{ proposalId: "p_1", roomId: "room-a" }],
    new Map([["room-a", 2001]]),
    "정리"
  );

  assert.equal(rows[0].stage, "task_approval");
  assert.equal(rows[0].decision, "cancelled");
  assert.equal(rows[0].entity_ref, "p_1");
  assert.equal(rows[0].decider_telegram_user_id, 2001);
  assert.equal(rows[0].task_id, null);
});

test("재실행해도 같은 제안에 두 번 들어가지 않는다", () => {
  const first = buildCancellationRows([{ proposalId: "p_1", roomId: "room-a" }], new Map([["room-a", 2001]]), "정리");
  const second = buildCancellationRows([{ proposalId: "p_1", roomId: "room-a" }], new Map([["room-a", 2001]]), "정리");

  assert.equal(first[0].idempotency_key, second[0].idempotency_key);
});

test("방장을 못 찾으면 조용히 넘어가지 않고 멈춘다", () => {
  assert.throws(
    () => buildCancellationRows([{ proposalId: "p_1", roomId: "room-x" }], new Map(), "정리"),
    /owner-not-found:room-x/
  );
});

function event(roomId, payload) {
  return { room_id: roomId, payload, created_at: "2026-08-15T00:00:00.000Z" };
}
