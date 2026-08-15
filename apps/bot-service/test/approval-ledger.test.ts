import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import {
  SupabaseBotServiceStore,
  approvalDeciderFromPayload,
  approvalEntityRefFromPayload,
  approvalRecordForEvent,
  approvalReasonFromPayload
} from "../src/supabase-store.js";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "5001";
const CHAT_ID = "1001";

// commitTelegramInputResult 는 매 호출마다 telegram_chat_id 로 room_id 를 먼저 해석한다.
function roomResolutionResponse(): Response {
  return jsonResponse(200, [{ room_id: ROOM_ID }]);
}

test("3단계 완료 게이트의 각 결정이 승인 단계로 매핑된다", () => {
  assert.deepEqual(approvalRecordForEvent("owner_task_approved"), { stage: "task_approval", decision: "approved" });
  assert.deepEqual(approvalRecordForEvent("commander_completion_approved"), { stage: "commander_completion", decision: "approved" });
  assert.deepEqual(approvalRecordForEvent("owner_final_approved"), { stage: "final_approval", decision: "approved" });
  assert.deepEqual(approvalRecordForEvent("owner_supplement_requested"), { stage: "final_approval", decision: "revision_requested" });
  assert.deepEqual(approvalRecordForEvent("owner_cancel_requested"), { stage: "cancellation", decision: "cancelled" });
  assert.deepEqual(approvalRecordForEvent("proposal_rejected"), { stage: "task_approval", decision: "rejected" });
});

test("승인 대상이 아닌 이벤트는 원장에 남기지 않는다", () => {
  for (const eventType of ["proposal_created", "task_started", "artifact_saved", "meaningful_intermediate_ready", "execution_delayed_or_failed"]) {
    assert.equal(approvalRecordForEvent(eventType), undefined, eventType);
  }
});

test("결정자와 대상 식별자를 payload 에서 추출한다", () => {
  assert.equal(approvalEntityRefFromPayload({ entityId: "proposal_0001" }), "proposal_0001");
  assert.equal(approvalEntityRefFromPayload({ targetId: TASK_ID }), TASK_ID);
  assert.equal(approvalDeciderFromPayload({ telegramUserId: OWNER }), OWNER);
  assert.equal(approvalDeciderFromPayload({ telegramUserId: 5001 }), "5001");
  assert.equal(approvalDeciderFromPayload({ telegramUserId: "not-a-number" }), undefined);
  assert.equal(approvalReasonFromPayload({}), null);
});

test("사유에 담긴 민감정보는 원장에 남기지 않는다", () => {
  const masked = approvalReasonFromPayload({ reason: "확인함 Bearer abc.def.ghi" });
  assert.equal(String(masked).includes("abc.def.ghi"), false);
});

test("방장 승인이 huai_approvals 에 append-only 로 기록된다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [eventRow("owner_task_approved:bot-1:9:proposal_0001")]),
    jsonResponse(201, []),                       // POST /huai_approvals
    jsonResponse(200, [{ status: "proposal_pending" }]),
    jsonResponse(200, [{ task_id: TASK_ID }]),   // PATCH /huai_tasks (전이)
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeCommit({
    eventType: "owner_task_approved",
    idempotencyKey: "owner_task_approved:bot-1:9:proposal_0001",
    payload: { entity: "proposal", entityId: "proposal_0001", telegramUserId: OWNER, telegramChatId: "-100", decidedAt: "2026-08-14T21:00:00.000Z" }
  }));

  const approval = calls.requests.find((request) => request.method === "POST" && /huai_approvals$/.test(request.url));
  assert.ok(approval, "승인 기록 INSERT 가 발생해야 한다");
  assert.equal(approval.body.room_id, ROOM_ID);
  assert.equal(approval.body.stage, "task_approval");
  assert.equal(approval.body.decision, "approved");
  assert.equal(approval.body.decider_telegram_user_id, OWNER);
  assert.equal(approval.body.entity_ref, "proposal_0001");
  // 승인 시점에는 task 가 아직 없다. 사실을 그대로 남기고 억지로 채우지 않는다.
  assert.equal(approval.body.task_id, null);
  assert.equal(approval.body.idempotency_key, "owner_task_approved:bot-1:9:proposal_0001");
});

test("대상이 이미 task UUID 면 task_id 를 채운다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [eventRow("owner_final_approved:bot-1:12:" + TASK_ID)]),
    jsonResponse(201, []),
    jsonResponse(200, [{ status: "completion_approval_pending" }]),
    jsonResponse(200, [{ task_id: TASK_ID }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeCommit({
    eventType: "owner_final_approved",
    idempotencyKey: "owner_final_approved:bot-1:12:" + TASK_ID,
    payload: { entity: "task", entityId: TASK_ID, telegramUserId: OWNER, decidedAt: "2026-08-14T21:00:00.000Z" }
  }));

  const approval = calls.requests.find((request) => request.method === "POST" && /huai_approvals$/.test(request.url));
  assert.equal(approval?.body.task_id, TASK_ID);
  assert.equal(approval?.body.entity_ref, TASK_ID);
  assert.equal(approval?.body.stage, "final_approval");
});

test("승인 기록은 상태 전이보다 먼저 기록된다 (전이 실패해도 승인 사실은 남는다)", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [eventRow("owner_task_approved:bot-1:31:" + TASK_ID)]),
    jsonResponse(201, []),
    // 이미 완료된 작업에 승인 이벤트가 다시 들어오면 금지 전이로 차단된다.
    jsonResponse(200, [{ status: "completed" }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await assert.rejects(() => store.commitTelegramInputResult(makeCommit({
    eventType: "owner_task_approved",
    idempotencyKey: "owner_task_approved:bot-1:31:" + TASK_ID,
    payload: { entity: "task", entityId: TASK_ID, telegramUserId: OWNER }
  })), /task-transition-forbidden/);

  const approvalIndex = calls.requests.findIndex((request) => /huai_approvals$/.test(request.url));
  const taskReadIndex = calls.requests.findIndex((request) => /huai_tasks\?task_id/.test(request.url));
  assert.equal(approvalIndex >= 0, true, "전이가 실패해도 승인 기록은 남아야 한다");
  assert.equal(approvalIndex < taskReadIndex, true, "승인 기록이 상태 전이보다 먼저 일어나야 한다");
});

test("같은 update 재처리 시 승인 원장이 중복되지 않는다 (409 정상 흡수)", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [eventRow("owner_task_approved:bot-1:9:proposal_0001")]),
    jsonResponse(409, { message: "duplicate key value violates unique constraint" }),
    jsonResponse(200, [{ status: "proposal_pending" }]),
    jsonResponse(200, [{ task_id: TASK_ID }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeCommit({
    eventType: "owner_task_approved",
    idempotencyKey: "owner_task_approved:bot-1:9:proposal_0001",
    payload: { entity: "proposal", entityId: "proposal_0001", telegramUserId: OWNER }
  }));

  assert.equal(calls.requests.filter((request) => request.method === "POST" && /huai_approvals$/.test(request.url)).length, 1);
});

test("결정자를 알 수 없는 이벤트는 원장에 남기지 않는다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [eventRow("owner_task_approved:bot-1:40:proposal_0010")]),
    jsonResponse(200, [{ status: "proposal_pending" }]),
    jsonResponse(200, [{ task_id: TASK_ID }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeCommit({
    eventType: "owner_task_approved",
    idempotencyKey: "owner_task_approved:bot-1:40:proposal_0010",
    payload: { entity: "proposal", entityId: "proposal_0010" }
  }));

  assert.equal(calls.requests.some((request) => /huai_approvals/.test(request.url)), false);
});

function makeStore(fetchImpl: typeof fetch) {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    fetchImpl
  });
}

function makeCommit(event: { eventType: string; idempotencyKey: string; payload: Record<string, unknown> }) {
  return {
    message: {
      input: {
        kind: "message" as const,
        envelope: new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", "1", CHAT_ID, "10", OWNER, false, undefined, undefined)
      },
      idempotencyKey: "update-1",
      receivedAt: "2026-08-14T21:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [event as never],
      outbox: []
    }
  };
}

function eventRow(idempotencyKey: string) {
  return {
    event_id: "event-1",
    room_id: ROOM_ID,
    task_id: null,
    event_type: idempotencyKey.split(":")[0],
    idempotency_key: idempotencyKey,
    payload: {},
    created_at: "2026-08-14T21:00:00.000Z"
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeSupabaseFetch(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]))
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call:" + String(input));
    return response;
  };
  return { fetchImpl, requests };
}
