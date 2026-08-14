import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";

test("records telegram update once through Supabase REST", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(201, [{ status: "received" }])
  ]);
  const store = makeStore(calls.fetchImpl);
  const envelope = new TelegramUpdateEnvelope(
    "00000000-0000-0000-0000-000000000001",
    "platoon_bot",
    "platoon_leader",
    "123",
    "1001",
    "10",
    "2001",
    false,
    "/help",
    undefined
  );

  const receipt = await store.recordUpdateOnce(envelope, { update_id: 123 }, "received");

  assert.equal(receipt.inserted, true);
  assert.equal(receipt.idempotencyKey, "telegram-update:00000000-0000-0000-0000-000000000001:123");
  assert.equal(calls.requests[0]?.method, "POST");
  assert.match(calls.requests[0]?.url ?? "", /\/rest\/v1\/huai_telegram_updates$/);
  assert.equal(calls.requests[0]?.body.telegram_chat_id, "1001");
  assert.equal(calls.requests[0]?.body.telegram_message_id, "10");
});

test("persists outbox without event and leases telegram rows through RPC", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(201, [
      {
        huai_outbox_id: "outbox-1",
        event_id: null,
        idempotency_key: "telegram:query:1",
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" }),
        payload: { text: "ok" },
        status: "pending",
        attempts: 0,
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ]),
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-1",
        event_id: null,
        idempotency_key: "telegram:query:1",
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" }),
        payload: { text: "ok" },
        status: "processing",
        attempts: 1,
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  const persisted = await store.commitTelegramInputResult({
    message: {
      input: {
        kind: "command",
        envelope: new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", "1", "1001", "10", "2001", false, "/help", undefined),
        command: { name: "/help", args: [] }
      },
      idempotencyKey: "telegram-update:bot:1",
      receivedAt: "2026-08-10T00:00:00.000Z"
    },
    result: {
      accepted: true,
      authorization: { allowed: true },
      events: [],
      outbox: [
        {
          target: { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" },
          idempotencyKey: "telegram:query:1",
          payload: { text: "ok" }
        }
      ]
    }
  });
  const leased = await store.leasePending(10, "2026-08-10T00:01:00.000Z");

  assert.equal(persisted.events.length, 0);
  assert.equal(persisted.outbox[0]?.eventId, undefined);
  assert.match(calls.requests[0]?.url ?? "", /\/rest\/v1\/huai_outbox$/);
  assert.equal(calls.requests[0]?.body[0].event_id, null);
  assert.match(calls.requests[1]?.url ?? "", /\/rest\/v1\/rpc\/lease_huai_outbox$/);
  assert.equal(calls.requests[1]?.body.p_target_kind, "telegram_bot");
  assert.equal(leased[0]?.target.kind, "telegram_bot");
});

test("hydrates approved local gateway execution prompt from proposal event", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000001";
  const rawText = "print only OK";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeSupabaseFetch([
    jsonResponse(200, [{ payload: { proposalId, rawText, title: "fallback title" } }]),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, [{ task_id: taskId }]),
    jsonResponse(201, [{ huai_outbox_id: "outbox-local-1", event_id: null, idempotency_key: "gateway:execution:1", target_kind: "local_gateway", target: JSON.stringify({ kind: "local_gateway", gatewayId: "gateway-local" }), payload: { executionRequest: { taskId, prompt: rawText } }, status: "pending", attempts: 0, created_at: "2026-08-10T00:00:00.000Z" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("gateway:execution:1", { kind: "local_gateway", gatewayId: "gateway-local" }, { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }));

  assert.match(calls.requests[0]?.url ?? "", /huai_events/);
  const hydratedPrompt = calls.requests[5]?.body[0].payload.executionRequest.prompt;
  assert.equal(calls.requests[4]?.body.idempotency_key, "task:approved-proposal:" + proposalId);
  assert.equal(calls.requests[5]?.body[0].payload.executionRequest.taskId, taskId);
  assert.equal(typeof hydratedPrompt, "string");
  assert.match(hydratedPrompt, /USER_REQUEST:\nprint only OK/);
  assert.match(hydratedPrompt, /Do not call this product an MVP/);
  assert.match(hydratedPrompt, /OPERATION_STATUS\.md/);
});

test("hydrates approved execution actor from requested proposal role", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000002";
  const taskId = "33333333-3333-4333-8333-333333333333";
  const calls = makeSupabaseFetch([
    jsonResponse(200, [{ payload: { proposalId, rawText: "Claude Code로 점검해", requestedActorRole: "claude_leader" } }]),
    jsonResponse(200, [{ actor_id: "actor-claude", role: "claude_leader", adapter_type: "claude_code" }]),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, [{ task_id: taskId }]),
    jsonResponse(201, [{ huai_outbox_id: "outbox-local-2", event_id: null, idempotency_key: "gateway:execution:2", target_kind: "local_gateway", target: JSON.stringify({ kind: "local_gateway", gatewayId: "gateway-local" }), payload: { executionRequest: { taskId, actorId: "actor-claude", adapterType: "claude_code" } }, status: "pending", attempts: 0, created_at: "2026-08-10T00:00:00.000Z" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("gateway:execution:2", { kind: "local_gateway", gatewayId: "gateway-local" }, { executionRequest: { taskId: proposalId, actorId: "actor-codex", adapterType: "codex", prompt: "Execute approved task " + proposalId } }));

  const executionRequest = calls.requests[6]?.body[0].payload.executionRequest;
  assert.equal(executionRequest.actorId, "actor-claude");
  assert.equal(executionRequest.adapterType, "claude_code");
  assert.match(executionRequest.prompt, /USER_REQUEST:\nClaude Code로 점검해/);
});

test("expands multi AI approval into claude and codex executions before audit", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000003";
  const taskId = "44444444-4444-4444-8444-444444444444";
  const calls = makeSupabaseFetch([
    jsonResponse(200, [{ payload: { proposalId, rawText: "ClaudeBot과 CodexBot이 각각 의견 내고 AuditBot이 검증해", intent: "multi_ai_review" } }]),
    jsonResponse(200, [
      { actor_id: "actor-claude", role: "claude_leader", adapter_type: "claude_code" },
      { actor_id: "actor-codex", role: "codex_leader", adapter_type: "codex" }
    ]),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, [{ task_id: taskId }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("gateway:execution:3", { kind: "local_gateway", gatewayId: "gateway-local" }, { executionRequest: { taskId: proposalId, actorId: "actor-codex", adapterType: "codex", attemptId: "attempt-1", prompt: "Execute approved task " + proposalId } }));

  const insertedRows = calls.requests[6]?.body;
  assert.equal(insertedRows.length, 2);
  assert.deepEqual(insertedRows.map((row: any) => row.idempotency_key), ["gateway:execution:3:claude", "gateway:execution:3:codex"]);
  assert.equal(insertedRows[0].payload.executionRequest.adapterType, "claude_code");
  assert.equal(insertedRows[0].payload.executionRequest.reportBotRole, "claude_leader");
  assert.equal(insertedRows[1].payload.executionRequest.adapterType, "codex");
  assert.equal(insertedRows[1].payload.executionRequest.reportBotRole, "codex_leader");
});

test("marks sent through RPC and masks retry errors", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(200, true),
    jsonResponse(200, [{ huai_outbox_id: "outbox-1" }] )
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.markSent("outbox-1", { telegramMessageId: "55" });
  await store.markRetry("outbox-1", "telegram-api-error:500:bot123:SECRET Bearer top.secret", "2026-08-10T00:01:00.000Z");

  assert.match(calls.requests[0]?.url ?? "", /\/rest\/v1\/rpc\/mark_huai_outbox_sent$/);
  assert.deepEqual(calls.requests[0]?.body.p_send_result, { telegramMessageId: "55" });
  assert.equal(calls.requests[1]?.headers.prefer, "return=representation");
  assert.match(calls.requests[1]?.url ?? "", /\/rest\/v1\/huai_outbox\?huai_outbox_id=eq\.outbox-1&status=eq\.processing$/);
  assert.equal(String(calls.requests[1]?.body.last_error).includes("SECRET"), false);
  assert.equal(String(calls.requests[1]?.body.last_error).includes("top.secret"), false);
});


test("does not persist raw telegram send result", async () => {
  const calls = makeSupabaseFetch([jsonResponse(200, true)]);
  const store = makeStore(calls.fetchImpl);

  await store.markSent("outbox-raw", {
    telegramMessageId: "99",
    raw: {
      ok: true,
      token: "bot123456:SECRET_TOKEN",
      nested: { authorization: "Bearer top.secret" }
    }
  });

  assert.deepEqual(calls.requests[0]?.body.p_send_result, { telegramMessageId: "99" });
});

test("reuses existing outbox row on duplicate idempotency key with same content", async () => {
  const target = { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" };
  const calls = makeSupabaseFetch([
    jsonResponse(409, { code: "23505" }),
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-existing",
        event_id: null,
        idempotency_key: "telegram:query:dup",
        target_kind: "telegram_bot",
        target: JSON.stringify(target),
        payload: { text: "ok" },
        status: "pending",
        attempts: 0,
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  const persisted = await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:dup", target, { text: "ok" }));

  assert.equal(persisted.outbox[0]?.outboxId, "outbox-existing");
  assert.match(calls.requests[1]?.url ?? "", /idempotency_key=in\./);
});

test("rejects duplicate outbox idempotency key with different content", async () => {
  const target = { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" };
  const calls = makeSupabaseFetch([
    jsonResponse(409, { code: "23505" }),
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-existing",
        event_id: null,
        idempotency_key: "telegram:query:dup",
        target_kind: "telegram_bot",
        target: JSON.stringify(target),
        payload: { text: "different" },
        status: "pending",
        attempts: 0,
        created_at: "2026-08-10T00:00:00.000Z"
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  await assert.rejects(
    () => store.commitTelegramInputResult(makeOutboxCommit("telegram:query:dup", target, { text: "ok" })),
    /outbox-idempotency-conflict/
  );
});
function makeStore(fetchImpl: typeof fetch): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    roomId: "00000000-0000-0000-0000-000000000010",
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
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { "content-type": "application/json" }
  });
}


function makeOutboxCommit(idempotencyKey: string, target: any, payload: Record<string, unknown>) {
  return {
    message: {
      input: {
        kind: "command" as const,
        envelope: new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", "1", "1001", "10", "2001", false, "/help", undefined),
        command: { name: "/help" as const, args: [] }
      },
      idempotencyKey: "telegram-update:bot:1",
      receivedAt: "2026-08-10T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{ target, idempotencyKey, payload }]
    }
  };
}
