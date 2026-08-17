import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { buildApprovedTelegramTaskPromptForTest, SupabaseBotServiceStore } from "../src/supabase-store.js";

const ROOM_ID = "00000000-0000-0000-0000-000000000010";

// commitTelegramInputResult 는 이제 매 호출마다 telegram_chat_id 로 room_id 를 먼저 해석한다
// (프로세스 1개가 여러 방을 처리하므로). 응답 큐 맨 앞에 이 room 조회 응답을 넣어줘야 한다.
function roomResolutionResponse(): Response {
  return jsonResponse(200, [{ room_id: ROOM_ID }]);
}

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
    roomResolutionResponse(),
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
  assert.match(calls.requests[0]?.url ?? "", /\/rest\/v1\/huai_rooms\?telegram_chat_id=eq\.1001/);
  assert.match(calls.requests[1]?.url ?? "", /\/rest\/v1\/huai_outbox$/);
  assert.equal(calls.requests[1]?.body[0].event_id, null);
  assert.match(calls.requests[2]?.url ?? "", /\/rest\/v1\/rpc\/lease_huai_outbox$/);
  assert.equal(calls.requests[2]?.body.p_target_kind, "telegram_bot");
  assert.equal(leased[0]?.target.kind, "telegram_bot");
});

test("hydrates approved local gateway execution prompt from proposal event", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000001";
  const rawText = "print only OK";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [{ payload: { proposalId, rawText, title: "fallback title" } }]),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, [{ task_id: taskId }]),
    jsonResponse(201, [{ huai_outbox_id: "outbox-local-1", event_id: null, idempotency_key: "gateway:execution:1", target_kind: "local_gateway", target: JSON.stringify({ kind: "local_gateway", gatewayId: "gateway-local" }), payload: { executionRequest: { taskId, prompt: rawText } }, status: "pending", attempts: 0, created_at: "2026-08-10T00:00:00.000Z" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("gateway:execution:1", { kind: "local_gateway", gatewayId: "gateway-local" }, { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }));

  assert.match(calls.requests[1]?.url ?? "", /huai_events/);
  const hydratedPrompt = calls.requests[6]?.body[0].payload.executionRequest.prompt;
  assert.equal(calls.requests[5]?.body.idempotency_key, "task:approved-proposal:" + proposalId);
  assert.equal(calls.requests[6]?.body[0].payload.executionRequest.taskId, taskId);
  assert.equal(typeof hydratedPrompt, "string");
  assert.match(hydratedPrompt, /USER_REQUEST:\nprint only OK/);
  assert.match(hydratedPrompt, /Do not call this product an MVP/);
  assert.match(hydratedPrompt, /OPERATION_STATUS\.md/);
});

test("hydrates approved execution actor from requested proposal role", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000002";
  const taskId = "33333333-3333-4333-8333-333333333333";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
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

  const executionRequest = calls.requests[7]?.body[0].payload.executionRequest;
  assert.equal(executionRequest.actorId, "actor-claude");
  assert.equal(executionRequest.adapterType, "claude_code");
  assert.match(executionRequest.prompt, /USER_REQUEST:\nClaude Code로 점검해/);
});

test("expands multi AI approval into claude and codex executions before audit", async () => {
  const proposalId = "proposal_00000000-0000-4000-8000-000000000003";
  const taskId = "44444444-4444-4444-8444-444444444444";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
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

  const insertedRows = calls.requests[7]?.body;
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
    roomResolutionResponse(),
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
  assert.match(calls.requests[2]?.url ?? "", /idempotency_key=in\./);
});

// room_id 는 방 단위 공평 리스(lease_huai_outbox)의 파티션 키일 뿐, 사용자에게 보이는
// "내용"이 아니다. 재삽입 시도의 room_id 와 기존 행의 room_id 가 다르더라도(예: 마이그레이션
// backfill 이 안 된 옛 행) target_kind/target/payload 만 같으면 같은 내용으로 봐야 한다 —
// sameOutboxContent() 가 room_id 를 비교 대상에서 뺀 것이 이 테스트의 핵심 증명이다.
test("멱등 재삽입 비교는 room_id 불일치로 오판하지 않는다", async () => {
  const target = { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" };
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(409, { code: "23505" }),
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-existing",
        room_id: "99999999-9999-4999-8999-999999999999", // 이번 요청의 room_id 와 의도적으로 다르게
        event_id: null,
        idempotency_key: "telegram:query:room-mismatch",
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

  const persisted = await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:room-mismatch", target, { text: "ok" }));

  assert.equal(persisted.outbox[0]?.outboxId, "outbox-existing");
  // 그리고 애초에 우리가 보낸 첫 INSERT 시도 자체는 이 요청의(기존 행이 아니라) room_id 를 담고 있어야 한다.
  assert.equal(calls.requests[1]?.body[0].room_id, ROOM_ID);
});

// packages/orchestrator 의 enqueueExecutionAfterApproval/enqueueAuditExecutionIfConfigured 는
// executionRequest.attemptId(ports.makeId())·createdAt(ports.now())·nested idempotencyKey
// (attemptId 에 종속)를 호출마다 새로 만든다. 같은 승인 결정을 두 번 제출해도(Telegram 버튼
// 재클릭, 또는 Mini App 이 같은 결정을 다시 보낼 때) 바깥쪽 outbox idempotency_key(entityId
// 단위)는 같은데 이 3개 필드만 달라서 예전엔 outbox-idempotency-conflict 로 터졌다 — 사용자
// 에게는 무반응, 로그에는 에러만 쌓이는 상황. 이제는 조용히 기존 행을 재사용해야 한다.
test("같은 승인 결정을 두 번 제출해도(attemptId/createdAt만 다름) 예외 없이 기존 행을 재사용한다", async () => {
  const target = { kind: "local_gateway", gatewayId: "gateway-local" };
  const stableExecutionFields = {
    roomId: "room-1",
    taskId: "11111111-1111-4111-8111-111111111111",
    actorId: "actor-claude",
    requestedBy: "9001",
    adapterType: "claude_code",
    projectPath: "/project",
    prompt: "Execute approved task 11111111-1111-4111-8111-111111111111",
    timeoutMs: 120000
  };
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(409, { code: "23505" }),
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-existing-execution",
        room_id: ROOM_ID,
        event_id: null,
        idempotency_key: "gateway:execution:11111111-1111-4111-8111-111111111111",
        target_kind: "local_gateway",
        target: JSON.stringify(target),
        // 첫 번째 제출 때 생성된 값들 — attemptId/createdAt/nested idempotencyKey 가 이번 재제출과 다르다.
        payload: { executionRequest: { ...stableExecutionFields, attemptId: "attempt-first", createdAt: "2026-08-15T00:00:00.000Z", idempotencyKey: "execution:11111111-1111-4111-8111-111111111111:attempt-first" } },
        status: "pending",
        attempts: 0,
        created_at: "2026-08-15T00:00:00.000Z"
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  const persisted = await store.commitTelegramInputResult(makeOutboxCommit(
    "gateway:execution:11111111-1111-4111-8111-111111111111",
    target,
    // 두 번째(재)제출 — 나머지는 전부 같은데 attemptId/createdAt/nested idempotencyKey 만 새로 생성됐다.
    { executionRequest: { ...stableExecutionFields, attemptId: "attempt-second", createdAt: "2026-08-15T00:05:00.000Z", idempotencyKey: "execution:11111111-1111-4111-8111-111111111111:attempt-second" } }
  ));

  assert.equal(persisted.outbox[0]?.outboxId, "outbox-existing-execution");
});

test("actorId 등 진짜 내용이 다르면 attemptId/createdAt 제외 이후에도 여전히 충돌 예외를 던진다", async () => {
  const target = { kind: "local_gateway", gatewayId: "gateway-local" };
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(409, { code: "23505" }),
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-existing-execution-2",
        room_id: ROOM_ID,
        event_id: null,
        idempotency_key: "gateway:execution:22222222-2222-4222-8222-222222222222",
        target_kind: "local_gateway",
        target: JSON.stringify(target),
        payload: {
          executionRequest: {
            roomId: "room-1", taskId: "22222222-2222-4222-8222-222222222222", actorId: "actor-claude", requestedBy: "9001",
            adapterType: "claude_code", projectPath: "/project", prompt: "Execute approved task 22222222-2222-4222-8222-222222222222", timeoutMs: 120000,
            attemptId: "attempt-first", createdAt: "2026-08-15T00:00:00.000Z", idempotencyKey: "execution:22222222-2222-4222-8222-222222222222:attempt-first"
          }
        },
        status: "pending",
        attempts: 0,
        created_at: "2026-08-15T00:00:00.000Z"
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  await assert.rejects(
    () => store.commitTelegramInputResult(makeOutboxCommit(
      "gateway:execution:22222222-2222-4222-8222-222222222222",
      target,
      // actorId 가 다르다 — attemptId/createdAt 만 다른 게 아니라 진짜 다른 실행 요청이다.
      { executionRequest: { roomId: "room-1", taskId: "22222222-2222-4222-8222-222222222222", actorId: "actor-codex", requestedBy: "9001", adapterType: "codex", projectPath: "/project", prompt: "Execute approved task 22222222-2222-4222-8222-222222222222", timeoutMs: 120000, attemptId: "attempt-second", createdAt: "2026-08-15T00:05:00.000Z", idempotencyKey: "execution:22222222-2222-4222-8222-222222222222:attempt-second" } }
    )),
    /outbox-idempotency-conflict/
  );
});

test("rejects duplicate outbox idempotency key with different content", async () => {
  const target = { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" };
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
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

test("소대장이 지정한 담당이 실행자와 보고자 양쪽에 반영된다", async () => {
  // 실전에서 소대장이 "담당: ClaudeBot" 이라고 정했는데 보고는 CodexBot 이름으로 나갔다.
  // actorId·adapterType 만 바꾸고 reportBotRole 을 두고 갔기 때문이다.
  const proposalId = "p_032d2db23aa44bdd";
  const taskId = "55555555-5555-4555-8555-555555555555";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [{ payload: { proposalId, title: "로그인 세션 원인 조사", rawText: "세션 조사", requestedActorRole: "claude_leader", completionCriteria: "원인 특정" } }]),
    jsonResponse(200, [{ actor_id: "actor-claude", role: "claude_leader", adapter_type: "claude_code" }]),
    jsonResponse(200, []),
    jsonResponse(201, [{ task_id: taskId }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit(
    "gateway:execution:claude-assignee",
    { kind: "local_gateway", gatewayId: "gateway-local" },
    { executionRequest: { taskId: proposalId, adapterType: "codex", reportBotRole: "codex_leader", prompt: "Execute approved task " + proposalId } }
  ));

  const outboxInsert = calls.requests.find((request) => request.method === "POST" && /huai_outbox$/.test(request.url));
  const executionRequest = outboxInsert?.body?.[0]?.payload?.executionRequest;
  assert.equal(executionRequest?.adapterType, "claude_code", "소대장이 지정한 실행기로 바뀌어야 한다");
  assert.equal(executionRequest?.reportBotRole, "claude_leader", "보고도 지정된 담당 이름으로 나가야 한다");
  assert.equal(executionRequest?.actorId, "actor-claude");
});

test("제안 단계 id 형태가 바뀌어도 작업 명세가 실행자에게 전달된다", async () => {
  // 콜백 64바이트 제한 때문에 제안 id 를 p_... 로 줄이자
  // 프롬프트 주입기가 proposal_ 접두사만 인식해 실행자가 id 만 받았다.
  const proposalId = "p_abcdef0123456789";
  const taskId = "66666666-6666-4666-8666-666666666666";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [{ payload: { proposalId, title: "세션 조사", rawText: "세션 조사", purpose: "원인 규명", scope: "토큰 만료 로직 확인", completionCriteria: "원인이 코드 근거와 함께 정리됨" } }]),
    jsonResponse(200, []),
    jsonResponse(201, [{ task_id: taskId }]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit(
    "gateway:execution:short-id",
    { kind: "local_gateway", gatewayId: "gateway-local" },
    { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }
  ));

  const outboxInsert = calls.requests.find((request) => request.method === "POST" && /huai_outbox$/.test(request.url));
  const prompt = String(outboxInsert?.body?.[0]?.payload?.executionRequest?.prompt ?? "");
  assert.equal(prompt.startsWith("Execute approved task "), false, "id 만 넘기면 실행자가 할 일을 모른다");
  assert.match(prompt, /원인이 코드 근거와 함께 정리됨/, "완료 조건이 실행자에게 전달되어야 한다");
  assert.match(prompt, /토큰 만료 로직 확인/);
});

// humanTaskStatus() 를 없애고 TASK_STATUS_META 를 단일 출처로 통일했다. 이 결함이 특히 나빴던
// 지점이 room facts — 소대장 판단 프롬프트에 방의 열린 작업 상태가 원문 snake_case 로 그대로
// 들어가고 있었다(예: "mid_approval_pending"). 소대장이 그걸 읽고 판단해야 했다는 뜻이다.
test("room facts(소대장 판단 프롬프트)는 작업 상태를 raw 값이 아니라 사람이 읽는 라벨로 보여준다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, []), // fetchLeaderActor: 없음
    jsonResponse(200, [{ purpose: "테스트 방" }]), // fetchRoomLabel: 세션 폴더 이름을 정한다
    jsonResponse(200, [{ role: "claude_leader" }]), // fetchRoomFacts: actors
    jsonResponse(200, [{ telegram_user_id: "9001" }]), // fetchRoomFacts: members
    jsonResponse(200, [{ title: "중간 승인 대기 중인 작업", status: "mid_approval_pending" }]), // fetchRoomFacts: tasks
    jsonResponse(201, [
      {
        huai_outbox_id: "outbox-planning-1",
        event_id: null,
        idempotency_key: "gateway:leader-planning:1",
        target_kind: "local_gateway",
        target: JSON.stringify({ kind: "local_gateway", gatewayId: "gateway-1" }),
        payload: { executionRequest: { attemptId: "leader-planning-1", prompt: "placeholder" } },
        status: "pending",
        attempts: 0,
        created_at: "2026-08-15T00:00:00.000Z"
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit(
    "gateway:leader-planning:1",
    { kind: "local_gateway", gatewayId: "gateway-1" },
    { executionRequest: { attemptId: "leader-planning-1", prompt: "placeholder" }, triggeringText: "방 상태 알려줘" }
  ));

  const outboxInsert = calls.requests.find((request) => request.method === "POST" && /huai_outbox$/.test(request.url));
  const prompt = String(outboxInsert?.body?.[0]?.payload?.executionRequest?.prompt ?? "");
  assert.match(prompt, /중간 승인 대기/, "사람이 읽는 라벨이 나와야 한다");
  assert.equal(prompt.includes("mid_approval_pending"), false, "raw snake_case 가 프롬프트에 새면 안 된다");
});

// 방장 제기 — 포럼 그룹은 주제마다 고정 바가 따로라, 그룹에 하나 고정해 둔 작업 현황판이
// 다른 주제에서는 보이지 않았다. 그 주제에서 일을 시키고도 결과를 확인할 창구가 없었다.
test("주제로 나가는 메시지가 있으면 그 주제에 현황판을 올려 고정한다", async () => {
  const calls = makeSupabaseFetch([roomResolutionResponse(), jsonResponse(201, []), jsonResponse(201, [])]);
  const store = new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: calls.fetchImpl,
    miniAppDirectLinkBaseUrl: "https://t.me/leader_chatroom_bot/board"
  });

  await store.commitTelegramInputResult(
    makeOutboxCommit("telegram:something:1", { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" }, {
      botRole: "platoon_leader",
      telegramChatId: "1001",
      messageThreadId: "613",
      text: "📥 접수했습니다."
    })
  );

  const inserted = calls.requests
    .filter((request) => request.method === "POST" && /huai_outbox$/.test(request.url))
    .flatMap((request) => (Array.isArray(request.body) ? request.body : [request.body]));
  const board = inserted.find((row: any) => String(row?.idempotency_key ?? "").startsWith("telegram:topic-board:"));

  // 현황판 행은 본 배치와 따로 들어간다 — 같이 넣으면 두 번째 메시지부터 배치가 통째로 막힌다.
  assert.ok(board, "그 주제에 현황판이 올라가지 않았다");
  assert.equal(board.payload.messageThreadId, "613", "현황판이 다른 주제에 올라가면 소용이 없다");
  assert.equal(board.payload.pinMessage, true, "고정하지 않으면 대화에 밀려 사라진다");
  assert.match(JSON.stringify(board.payload.keyboard), /startapp=/, "현황판을 여는 버튼이 없다");
});

test("주제 없는 그룹에는 현황판을 따로 올리지 않는다", async () => {
  // 일반 그룹은 고정 바가 하나라 이미 고정해 둔 것으로 충분하다.
  const calls = makeSupabaseFetch([roomResolutionResponse(), jsonResponse(201, []), jsonResponse(201, [])]);
  const store = new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: calls.fetchImpl,
    miniAppDirectLinkBaseUrl: "https://t.me/leader_chatroom_bot/board"
  });

  await store.commitTelegramInputResult(
    makeOutboxCommit("telegram:something:2", { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" }, {
      botRole: "platoon_leader",
      telegramChatId: "1001",
      text: "📥 접수했습니다."
    })
  );

  const inserted = calls.requests
    .filter((request) => request.method === "POST" && /huai_outbox$/.test(request.url))
    .flatMap((request) => (Array.isArray(request.body) ? request.body : [request.body]));

  assert.equal(inserted.some((row: any) => String(row?.idempotency_key ?? "").startsWith("telegram:topic-board:")), false);
});

// 라이브 결함 회귀 — 현황판 행을 본 배치에 같이 넣었더니, 그 주제의 두 번째 메시지부터
// outbox-idempotency-conflict 로 처리 전체가 실패했다(제안 메시지조차 안 나갔다).
// 배치 삽입은 "행 하나라도 이미 있으면 전체 실패"이고, 현황판 행은 주제당 하나뿐이라
// 두 번째부터는 반드시 이미 존재한다.
test("현황판 행이 이미 있어도 그 주제의 다음 메시지가 막히지 않는다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    // 현황판 행 단건 삽입 → 이미 있음.
    jsonResponse(409, { message: "duplicate key" }),
    // 본 배치는 그대로 성공해야 한다.
    jsonResponse(201, [])
  ]);
  const store = new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: calls.fetchImpl,
    miniAppDirectLinkBaseUrl: "https://t.me/leader_chatroom_bot/board"
  });

  await store.commitTelegramInputResult(
    makeOutboxCommit("telegram:proposal:p_1", { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" }, {
      botRole: "platoon_leader",
      telegramChatId: "1001",
      messageThreadId: "613",
      text: "📋 작업 제안입니다."
    })
  );

  const posts = calls.requests.filter((request) => request.method === "POST" && /huai_outbox$/.test(request.url));
  assert.equal(posts.length, 2, "현황판 행과 본 배치는 따로 들어가야 한다");
  const batch = posts[posts.length - 1]?.body;
  assert.equal(Array.isArray(batch) && batch.length, 1, "본 배치에 현황판 행이 섞이면 안 된다");
  assert.equal(Array.isArray(batch) && batch[0].idempotency_key, "telegram:proposal:p_1");
});

// 라이브 사고 회귀 — 작업자가 브라우저 테스트 중 `taskkill /F /IM chrome.exe` 를 실행해
// 방장이 열어 둔 Chrome 창 약 50개를 죽였고 저장 안 한 작업물이 날아갔다. 작업 기계는
// 빌드 서버가 아니라 사람이 쓰는 데스크톱이다.
test("작업 지시문이 남의 프로세스를 죽이지 말라고 못박는다", () => {
  const prompt = buildApprovedTelegramTaskPromptForTest("README 한 줄 고쳐줘");

  assert.match(prompt, /taskkill/);
  assert.match(prompt, /Never terminate processes you did not start/);
  // 자기가 돌고 있는 서비스를 재기동하면 그 작업 자체가 끊긴다.
  assert.match(prompt, /Never restart or stop the operation services/);
  assert.match(prompt, /README 한 줄 고쳐줘/);
});
