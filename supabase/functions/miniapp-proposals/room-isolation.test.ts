// 방 격리(room isolation) 실행 검증 — 실행 방법은 ../_shared/proposal-payload.test.ts 상단
// 주석 참고. handler.test.ts(기존, 건드리지 않음)의 "다른 방 제안이 안 섞인다" 테스트는
// deps.fetchProposalEvents 를 통짜 가짜 함수로 대체해서 "handler 가 요청받은 roomId 를 그
// 함수에 정확히 넘기는가"만 증명한다(그 파일 54-71행 주석에 이 한계가 이미 명시돼 있다).
// 이 파일은 그 한계 바깥, 즉 deps.ts 의 buildDepsFromClient 가 조립하는 실제
// `.from(...).eq("room_id", roomId)` 쿼리가 정말로 필터링을 거는지를 FakeSupabaseClient(실제
// 필터링하는 인메모리 대역)로 실행 검증한다.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeSupabaseClient } from "../_shared/fake-supabase-client";
import { buildDepsFromClient } from "./deps";
import { handleMiniappProposalsRequest, type ProposalsHandlerDeps } from "./handler";

function seededClient() {
  return new FakeSupabaseClient({
    huai_events: [
      {
        event_id: "evt-a1",
        room_id: "room-A",
        event_type: "proposal_created",
        created_at: "2026-08-15T00:00:00Z",
        payload: { proposalId: "p_room_a_pending", title: "A방 미결 제안" }
      },
      {
        event_id: "evt-a2",
        room_id: "room-A",
        event_type: "proposal_created",
        created_at: "2026-08-15T00:01:00Z",
        payload: { proposalId: "p_room_a_decided", title: "A방 결정된 제안" }
      },
      {
        event_id: "evt-b1",
        room_id: "room-B",
        event_type: "proposal_created",
        created_at: "2026-08-15T00:00:00Z",
        payload: { proposalId: "p_room_b_pending", title: "B방 미결 제안" }
      },
      // event_type 이 다른 행 — room_id 만 맞아도 섞이면 안 된다는 걸 같이 확인한다.
      {
        event_id: "evt-a3-other-type",
        room_id: "room-A",
        event_type: "task_status_changed",
        created_at: "2026-08-15T00:02:00Z",
        payload: { proposalId: "p_room_a_wrong_type" }
      }
    ],
    huai_approvals: [
      { room_id: "room-A", stage: "task_approval", entity_ref: "p_room_a_decided" },
      { room_id: "room-B", stage: "task_approval", entity_ref: "p_room_b_decided_but_no_event" }
    ]
  });
}

test("fetchProposalEvents(room-A) — room-B 이벤트가 절대 섞이지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchProposalEvents("room-A");
  assert.equal(result.error, undefined);
  const ids = (result.data ?? []).map((e) => e.event_id).sort();
  assert.deepEqual(ids, ["evt-a1", "evt-a2"]); // evt-a3-other-type 은 event_type 필터로 빠진다
});

test("fetchProposalEvents(room-B) — room-A 이벤트가 절대 섞이지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchProposalEvents("room-B");
  assert.equal(result.error, undefined);
  const ids = (result.data ?? []).map((e) => e.event_id);
  assert.deepEqual(ids, ["evt-b1"]);
});

test("fetchDecidedEntityRefs(room-A) — room-B 의 결정 기록이 절대 섞이지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchDecidedEntityRefs("room-A");
  assert.deepEqual(result.data, ["p_room_a_decided"]);
});

test("fetchDecidedEntityRefs(room-B) — room-A 의 결정 기록이 절대 섞이지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchDecidedEntityRefs("room-B");
  assert.deepEqual(result.data, ["p_room_b_decided_but_no_event"]);
});

function fakeAuthDeps(): Pick<ProposalsHandlerDeps, "authenticate" | "checkRoomAccess"> {
  return {
    authenticate: async () => ({ ok: true, telegramUserId: "111" }),
    checkRoomAccess: async (roomId) => ({ ok: true, room: { roomId, purpose: "테스트 방" }, viewerRole: "human_member" })
  };
}

function req(url: string): Request {
  return new Request(url, { method: "GET", headers: { authorization: "tma fake" } });
}

// 요청 수준(handler 전체) 격리 증명 — room-A 요청 응답의 제안이 전부 room-A 것이고
// room-B 제안은 0건인지, fetchProposalEvents/fetchDecidedEntityRefs 두 조회 모두를 거친
// 최종 JSON 기준으로 확인한다.
test("E2E — GET ?roomId=room-A 응답에는 room-A 미결 제안만 있고 room-B 제안은 0건이다", async () => {
  const deps: ProposalsHandlerDeps = { ...fakeAuthDeps(), ...buildDepsFromClient(seededClient()) };
  const res = await handleMiniappProposalsRequest(req("https://x/miniapp-proposals?roomId=room-A"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  const proposalIds: string[] = body.proposals.map((p: { proposalId: string }) => p.proposalId);
  // p_room_a_decided 는 huai_approvals 에 이미 결정돼 있어 "미결" 목록에서 빠진다 — 정상.
  assert.deepEqual(proposalIds, ["p_room_a_pending"]);
  assert.equal(proposalIds.includes("p_room_b_pending"), false);
});

test("E2E — GET ?roomId=room-B 응답에는 room-B 미결 제안만 있고 room-A 제안은 0건이다", async () => {
  const deps: ProposalsHandlerDeps = { ...fakeAuthDeps(), ...buildDepsFromClient(seededClient()) };
  const res = await handleMiniappProposalsRequest(req("https://x/miniapp-proposals?roomId=room-B"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  const proposalIds: string[] = body.proposals.map((p: { proposalId: string }) => p.proposalId);
  assert.deepEqual(proposalIds, ["p_room_b_pending"]);
  assert.equal(proposalIds.includes("p_room_a_pending"), false);
});
