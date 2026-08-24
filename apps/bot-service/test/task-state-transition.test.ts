import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "00000000-0000-0000-0000-000000000010";

// commitTelegramInputResult 는 매 호출마다 telegram_chat_id 로 room_id 를 먼저 해석한다.
function roomResolutionResponse(): Response {
  return jsonResponse(200, [{ room_id: ROOM_ID }]);
}

test("persists event task_id and advances huai_tasks status through workflow transition", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [
      {
        event_id: "event-1",
        room_id: "00000000-0000-0000-0000-000000000010",
        task_id: taskId,
        event_type: "owner_verification_requested",
        idempotency_key: "owner_verification_requested:bot:77:task",
        payload: { targetId: taskId },
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ]),
    jsonResponse(200, [{ task_id: taskId, status: "in_progress" }]),
    jsonResponse(200, [{ task_id: taskId, status: "verification_pending" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  const persisted = await store.commitTelegramInputResult({
    message: {
      input: {
        kind: "command",
        envelope: new TelegramUpdateEnvelope("bot", "leader_bot", "leader", "77", "1001", "10", "2001", false, "/verify " + taskId, undefined),
        command: { name: "/verify", args: [taskId] }
      },
      idempotencyKey: "telegram-update:bot:77",
      receivedAt: "2026-08-10T00:00:00.000Z"
    },
    result: {
      accepted: true,
      authorization: { allowed: true },
      events: [
        {
          eventType: "owner_verification_requested",
          idempotencyKey: "owner_verification_requested:bot:77:task",
          payload: { targetId: taskId }
        }
      ],
      outbox: []
    }
  });

  assert.equal(persisted.events[0]?.eventType, "owner_verification_requested");
  assert.match(calls.requests[1]?.url ?? "", /\/rest\/v1\/huai_events$/);
  assert.equal(calls.requests[1]?.body[0].task_id, taskId);
  assert.match(calls.requests[2]?.url ?? "", /\/rest\/v1\/huai_tasks\?task_id=eq\..*room_id=eq\./);
  assert.match(calls.requests[3]?.url ?? "", /\/rest\/v1\/huai_tasks\?task_id=eq\..*room_id=eq\./);
  assert.equal(calls.requests[3]?.body.status, "verification_pending");
});


test("persists proposal callback entity id without writing it to uuid task_id", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000010";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [
      {
        event_id: "event-proposal-approval",
        room_id: "00000000-0000-0000-0000-000000000010",
        task_id: null,
        event_type: "owner_task_approved",
        idempotency_key: "owner_task_approved:bot:88:proposal",
        payload: { entity: "proposal", entityId: proposalId },
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ]),
    jsonResponse(200, [{ task_id: null, status: "proposal_pending" }]),
    jsonResponse(200, [{ task_id: null, status: "scheduled" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult({
    message: {
      input: {
        kind: "callback",
        envelope: new TelegramUpdateEnvelope("bot", "leader_bot", "leader", "88", "1001", "10", "2001", false, undefined, "proposal:" + proposalId + ":approve", "callback-88"),
        callback: { entity: "proposal", entityId: proposalId, action: "approve" }
      },
      idempotencyKey: "telegram-update:bot:88",
      receivedAt: "2026-08-10T00:00:00.000Z"
    },
    result: {
      accepted: true,
      authorization: { allowed: true },
      events: [
        {
          eventType: "owner_task_approved",
          idempotencyKey: "owner_task_approved:bot:88:proposal",
          payload: { entity: "proposal", entityId: proposalId }
        }
      ],
      outbox: []
    }
  });

  assert.equal(calls.requests[1]?.body[0].task_id, null);
  assert.equal(calls.requests[1]?.body[0].payload.entityId, proposalId);
  assert.equal(calls.requests.length, 2);
});

test("blocks self verification through persisted event context", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(201, [
      {
        event_id: "event-self-verification",
        room_id: "00000000-0000-0000-0000-000000000010",
        task_id: taskId,
        event_type: "verification_started",
        idempotency_key: "verification_started:bot:88:task",
        payload: { targetId: taskId, actorRole: "auditor", actorId: "actor-a", authorActorId: "actor-a" },
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ]),
    jsonResponse(200, [{ task_id: taskId, status: "verification_pending" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  await assert.rejects(
    () => store.commitTelegramInputResult({
      message: {
        input: {
          kind: "command",
          envelope: new TelegramUpdateEnvelope("bot", "audit_bot", "auditor", "88", "1001", "10", "2001", false, "/verify " + taskId, undefined),
          command: { name: "/verify", args: [taskId] }
        },
        idempotencyKey: "telegram-update:bot:88",
        receivedAt: "2026-08-10T00:00:00.000Z"
      },
      result: {
        accepted: true,
        authorization: { allowed: true },
        events: [
          {
            eventType: "verification_started",
            idempotencyKey: "verification_started:bot:88:task",
            payload: { targetId: taskId, actorRole: "auditor", actorId: "actor-a", authorActorId: "actor-a" }
          }
        ],
        outbox: []
      }
    }),
    /task-transition-not-allowed:verification_started:verification_pending/
  );

  assert.equal(calls.requests.length, 3);
});

function makeStore(fetchImpl: typeof fetch): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl
  });
}

function makeSupabaseFetch(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries())
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call");
    return response;
  };
  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}


