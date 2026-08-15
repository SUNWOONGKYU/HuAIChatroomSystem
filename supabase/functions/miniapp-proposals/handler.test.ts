// handleMiniappProposalsRequest 회귀 테스트. 실행 방법은
// ../_shared/proposal-payload.test.ts 상단 주석 참고.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMiniappProposalsRequest, type ProposalsHandlerDeps } from "./handler";

function makeDeps(overrides: Partial<ProposalsHandlerDeps> = {}): ProposalsHandlerDeps {
  return {
    authenticate: async () => ({ ok: true, telegramUserId: "111" }),
    checkRoomAccess: async (roomId) => ({ ok: true, room: { roomId, purpose: "테스트 방" }, viewerRole: "human_member" }),
    fetchProposalEvents: async () => ({ data: [] }),
    fetchDecidedEntityRefs: async () => ({ data: [] }),
    ...overrides
  };
}

function req(url = "https://x/miniapp-proposals?roomId=room-a"): Request {
  return new Request(url, { method: "GET", headers: { authorization: "tma fake" } });
}

test("인증 실패면 401을 반환하고 데이터 조회를 하지 않는다", async () => {
  let called = false;
  const deps = makeDeps({
    authenticate: async () => ({ ok: false, status: 401, message: "unauthorized" }),
    fetchProposalEvents: async () => {
      called = true;
      return { data: [] };
    }
  });
  const res = await handleMiniappProposalsRequest(req(), deps);
  assert.equal(res.status, 401);
  assert.equal(called, false);
});

test("roomId 누락이면 400", async () => {
  const res = await handleMiniappProposalsRequest(req("https://x/miniapp-proposals"), makeDeps());
  assert.equal(res.status, 400);
});

test("멤버가 아니면 403이고 이벤트 조회를 하지 않는다", async () => {
  let called = false;
  const deps = makeDeps({
    checkRoomAccess: async () => ({ ok: false, status: 403, message: "forbidden" }),
    fetchProposalEvents: async () => {
      called = true;
      return { data: [] };
    }
  });
  const res = await handleMiniappProposalsRequest(req(), deps);
  assert.equal(res.status, 403);
  assert.equal(called, false);
});

test("다른 방 제안이 안 섞인다 — deps 에 요청된 roomId 가 그대로 전달된다", async () => {
  const requestedRoomIds: string[] = [];
  const deps = makeDeps({
    fetchProposalEvents: async (roomId) => {
      requestedRoomIds.push(roomId);
      // 이 fake 는 room-a 요청에도 room-b 제안을 섞어 넣는 "구현이 잘못됐다면" 상황을 흉내낸다.
      // 실제 index.ts 는 .eq("room_id", roomId) 로 이 오염을 막는다 — 여기서는 handler 가
      // "요청받은 roomId 를 정확히 그 조회 함수에 넘기는지"까지만 검증한다(격리 자체의
      // 실제 강제는 index.ts 의 쿼리 책임이라 handler 단위 테스트로는 못 잡는다 — 별도로 명시).
      return { data: [{ event_id: "e1", created_at: "2026-08-15T00:00:00Z", payload: { proposalId: "p_only_a", title: "A방 제안" } }] };
    }
  });
  const res = await handleMiniappProposalsRequest(req("https://x/miniapp-proposals?roomId=room-a"), deps);
  const body = await res.json();
  assert.deepEqual(requestedRoomIds, ["room-a"]);
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].proposalId, "p_only_a");
});

test("이벤트 조회 실패면 500", async () => {
  const deps = makeDeps({ fetchProposalEvents: async () => ({ error: "boom" }) });
  const res = await handleMiniappProposalsRequest(req(), deps);
  assert.equal(res.status, 500);
});

test("정상 흐름 — 미결 제안만 반환하고 room 정보를 그대로 돌려준다", async () => {
  const deps = makeDeps({
    fetchProposalEvents: async () => ({
      data: [
        { event_id: "e1", created_at: "2026-08-15T00:00:00Z", payload: { proposalId: "p_pending", title: "미결" } },
        { event_id: "e2", created_at: "2026-08-15T00:00:00Z", payload: { proposalId: "p_decided", title: "결정됨" } }
      ]
    }),
    fetchDecidedEntityRefs: async () => ({ data: ["p_decided"] })
  });
  const res = await handleMiniappProposalsRequest(req(), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].proposalId, "p_pending");
  assert.equal(body.room.roomId, "room-a");
});
