import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore, renderGatewayReportText } from "../src/index.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";

test("gateway report hides internal json and hook output from Telegram text", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [
      { type: "accepted", taskId: "task-1", attemptId: "attempt-1" },
      { type: "started", taskId: "task-1", attemptId: "attempt-1", at: "2026-08-11T00:00:00.000Z" },
      {
        type: "stdout",
        taskId: "task-1",
        attemptId: "attempt-1",
        text: [
          '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}',
          'SessionEnd hook [node "hook.js"] failed: Hook cancelled',
          '{"type":"item.completed","item":{"type":"agent_message","text":"확인했습니다. 다음 조치를 진행하겠습니다."}}'
        ].join("\n")
      }
    ]
  });

  assert.match(text, /^작업 실행 완료/);
  assert.match(text, /확인했습니다/);
  assert.equal(text.includes("hook_started"), false);
  assert.equal(text.includes("SessionEnd hook"), false);
  assert.equal(text.includes("EXECUTION COMPLETED"), false);
  assert.equal(text.includes("OUTPUT:"), false);
});

test("gateway failure report uses human-readable reason", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "failed",
    errorKind: "telegram-api-error:400:Bad Request: BUTTON_DATA_INVALID",
    events: []
  });

  assert.match(text, /^작업 실행 실패/);
  assert.match(text, /텔레그램 버튼 데이터가 너무 길어/);
  assert.equal(text.includes("BUTTON_DATA_INVALID"), false);
});

test("gateway completion report removes pretty JSON, stack frames, and prefixed logs", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: [
      "```json",
      "{",
      '  "type": "tool_result",',
      '  "payload": {"secret":"INTERNAL"}',
      "}",
      "```",
      "2026-08-13T10:00:00Z DEBUG worker payload received",
      "at runWorker (C:\\Dev\\worker.ts:10:2)",
      "결론: 요청한 점검을 완료했습니다."
    ].join("\n") }]
  });

  assert.match(text, /점검을 완료/);
  assert.equal(text.includes("tool_result"), false);
  assert.equal(text.includes("INTERNAL"), false);
  assert.equal(text.includes("DEBUG"), false);
  assert.equal(text.includes("worker.ts"), false);
});

test("gateway failure report never exposes unknown internal error details", () => {
  const internalError = 'runner-failed: C:\\Dev\\secret\\worker.ts {"stderr":"stack trace","token":"SECRET"}';
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "failed",
    errorKind: internalError,
    events: []
  });

  assert.match(text, /내부 오류가 발생했습니다/);
  assert.equal(text.includes("C:\\Dev"), false);
  assert.equal(text.includes("worker.ts"), false);
  assert.equal(text.includes("stderr"), false);
  assert.equal(text.includes("SECRET"), false);
});


test("gateway failure report exposes Claude session limit clearly", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "claude_code" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "You''ve hit your session limit · resets 5:10pm (Asia/Seoul)" }]
  });

  assert.match(text, /^작업 실행 실패/);
  assert.match(text, /ClaudeBot 현재 상태: 사용 한도 초과/);
  assert.match(text, /CodexBot으로 작업/);
  assert.equal(text.includes("실행 중 오류가 발생했습니다"), false);
});

test("gateway failure report exposes Claude weekly limit clearly", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "claude_code" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "You've hit your weekly limit · resets Aug 15, 7pm (Asia/Seoul)" }]
  });

  assert.match(text, /ClaudeBot 현재 상태: 사용 한도 초과/);
  assert.match(text, /CodexBot으로 작업/);
  assert.equal(text.includes("weekly limit"), false);
});


test("gateway failure report does not label Codex fixture output as Claude usage limit", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "codex" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "test fixture: You've hit your weekly limit · resets Aug 15, 7pm (Asia/Seoul)" }]
  });

  assert.equal(text.includes("ClaudeBot 현재 상태"), false);
});

test("gateway failure report explains Codex tool errors without raw internals", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "codex" },
    status: "failed",
    errorKind: "agent-tool-error",
    events: [{
      type: "stderr",
      taskId: "task-1",
      attemptId: "attempt-1",
      text: "codex_core::tools::router: error=Exit code: 1\nAn empty pipe element is not allowed."
    }]
  });

  assert.match(text, /CodexBot 내부 명령 실행이 실패/);
  assert.equal(text.includes("codex_core"), false);
  assert.equal(text.includes("empty pipe"), false);
});
test("gateway failure report exposes classified Claude usage limit without raw CLI output", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "claude_code" },
    status: "failed",
    errorKind: "agent-usage-limit",
    events: []
  });

  assert.match(text, /ClaudeBot 현재 상태: 사용 한도 초과/);
  assert.match(text, /한도가 초기화된 뒤/);
});

test("gateway failure report detects Claude limit before internal output is filtered", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "claude_code" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{
      type: "stdout",
      taskId: "task-1",
      attemptId: "attempt-1",
      text: '{"type":"result","result":"You have reached your weekly limit. Resets tomorrow."}'
    }]
  });

  assert.match(text, /ClaudeBot 현재 상태: 사용 한도 초과/);
  assert.equal(text.includes('{"type":"result"'), false);
  assert.equal(text.includes("weekly limit"), false);
});
function makeRequest(): ExecutionRequest {
  return {
    roomId: "room-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    actorId: "actor-1",
    requestedBy: "user-1",
    adapterType: "codex",
    projectPath: "C:\\Dev\\HuAIChatroomSystem",
    prompt: "do work",
    timeoutMs: 30_000,
    idempotencyKey: "test-idempotency",
    createdAt: "2026-08-11T00:00:00.000Z"
  };
}

test("gateway report removes execution wrapper labels from Telegram text", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: ["EXECUTION COMPLETED:", "OUTPUT:", "사용자에게 보여줄 요약"].join("\n") }]
  });
  assert.match(text, /^작업 실행 완료/);
  assert.match(text, /사용자에게 보여줄 요약/);
  assert.equal(text.includes("EXECUTION COMPLETED"), false);
  assert.equal(text.includes("OUTPUT:"), false);
});

test("gateway report compacts long human visible output", () => {
  const longSummary = "가".repeat(3000) + "끝";
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: longSummary }]
  });
  assert.equal(text.length <= 3300, true);
  assert.equal(text.includes("끝"), true);
});

test("gateway report removes low-value implementation details from Telegram text", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: [
      "현재 확인 가능한 근거를 종합하면, 전체 완성도는 77/100점으로 평가합니다.",
      "## 분야별 평가",
      "| 분야 | 점수 | 판정 | 확인 근거 |",
      "📁 C:\\Dev\\HuAIChatroomSystem\\",
      "📄 OPERATION_STATUS.md",
      "검증 제한도 명시합니다. 이번 환경에서는 실행 정책이 일부 명령을 차단했습니다.",
      "필요 조치: 조회 기능과 복구 검증을 보강해야 합니다."
    ].join("\n") }]
  });

  assert.match(text, /77\/100점/);
  assert.match(text, /필요 조치/);
  assert.equal(text.includes("| 분야 |"), false);
  assert.equal(text.includes("OPERATION_STATUS.md"), false);
  assert.equal(text.includes("검증 제한도"), false);
});
test("multi AI audit is queued only after claude and codex results exist", async () => {
  const calls = makeFetchSequence(undefined, {
    siblingEvents: [
      { event_id: "event-codex", payload: { taskId: "proposal-1", attemptId: "attempt-1-codex", status: "completed", events: [{ type: "stdout", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }] } },
      { event_id: "event-claude", payload: { taskId: "proposal-1", attemptId: "attempt-1-claude", status: "completed", events: [{ type: "stdout", text: "ClaudeBot 결론: 보완 필요" }] } }
    ]
  });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), taskId: "proposal-1", attemptId: "attempt-1-codex", prompt: "검증 포함", reportBotRole: "codex_leader" },
    status: "completed",
    events: [{ type: "stdout", taskId: "proposal-1", attemptId: "attempt-1-codex", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }],
    occurredAt: "2026-08-13T00:00:00.000Z"
  });

  const auditInsert = calls.requests.find((request) => request.body?.idempotency_key === "gateway:multi-ai-audit:proposal-1:attempt-1");
  assert.equal(auditInsert?.body.target_kind, "local_gateway");
  assert.match(auditInsert?.body.payload.executionRequest.prompt, /ClaudeBot 결과/);
  assert.match(auditInsert?.body.payload.executionRequest.prompt, /CodexBot 결과/);
  assert.match(auditInsert?.body.payload.executionRequest.prompt, /OK/);
  assert.equal(auditInsert?.body.payload.executionRequest.reportBotRole, "auditor");
});

test("cross-room audit pairing query filters huai_events by the request's room_id", async () => {
  const calls = makeFetchSequence(undefined, {
    siblingEvents: [
      { event_id: "event-codex", payload: { taskId: "proposal-1", attemptId: "attempt-1-codex", status: "completed", events: [{ type: "stdout", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }] } },
      { event_id: "event-claude", payload: { taskId: "proposal-1", attemptId: "attempt-1-claude", status: "completed", events: [{ type: "stdout", text: "ClaudeBot 결론: 보완 필요" }] } }
    ]
  });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), roomId: "room-abc", taskId: "proposal-1", attemptId: "attempt-1-codex", prompt: "검증 포함", reportBotRole: "codex_leader" },
    status: "completed",
    events: [{ type: "stdout", taskId: "proposal-1", attemptId: "attempt-1-codex", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const eventsQuery = calls.requests.find((request) => request.method === "GET" && request.url.includes("/huai_events") && request.url.includes("event_type=eq.meaningful_intermediate_ready"));
  assert.ok(eventsQuery, "expected a GET to huai_events for claude/codex sibling pairing");
  assert.equal(parsePostgrestQuery(eventsQuery!.url).room_id, "room-abc");
});

test("multi AI audit does not pair a room's codex result with another room's claude event", async () => {
  // 20방 동시 운영 시나리오: room-a 는 codex 결과만 막 받았고, room-b 에 이미 존재하는
  // claude 완료 이벤트가 room_id 필터 없이 조회되면 잘못 짝지어져 감사가 큐잉된다.
  const calls = makeFetchSequence(undefined, {
    eventsByRoom: [
      { room_id: "room-a", event_id: "event-codex-a", payload: { taskId: "proposal-1", attemptId: "attempt-1-codex", status: "completed", events: [{ type: "stdout", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }] } },
      { room_id: "room-b", event_id: "event-claude-b", payload: { taskId: "proposal-1", attemptId: "attempt-1-claude", status: "completed", events: [{ type: "stdout", text: "ClaudeBot 결론: 보완 필요" }] } }
    ]
  });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), roomId: "room-a", taskId: "proposal-1", attemptId: "attempt-1-codex", prompt: "검증 포함", reportBotRole: "codex_leader" },
    status: "completed",
    events: [{ type: "stdout", taskId: "proposal-1", attemptId: "attempt-1-codex", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const auditInsert = calls.requests.find((request) => request.body?.idempotency_key === "gateway:multi-ai-audit:proposal-1:attempt-1");
  assert.equal(auditInsert, undefined, "room-a's codex result must not be completed by room-b's claude sibling");
});

test("outbox row for a telegram report is stamped with the request's room_id", async () => {
  // huai_outbox.room_id 는 nullable FK 로 새로 추가됐고(20260815140000 마이그레이션),
  // lease_huai_outbox 가 이 값으로 방별 공평 리스를 한다. insert 경로가 안 채우면
  // 그 행이 "room 없음" 공유 버킷으로 떨어져 공평 리스 대상에서 사실상 빠진다.
  const calls = makeFetchSequence();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), roomId: "room-alpha" },
    status: "completed",
    events: [],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const outboxInsert = calls.requests.find((request) => request.method === "POST" && request.url.includes("/huai_outbox"));
  assert.ok(outboxInsert, "expected a POST to huai_outbox");
  assert.equal(outboxInsert!.body.room_id, "room-alpha");
});

test("outbox rows from two different rooms each carry their own room_id, never swapped or shared", async () => {
  const callsA = makeFetchSequence();
  const storeA = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: callsA.fetchImpl });
  await storeA.recordGatewayExecutionResult({
    request: { ...makeRequest(), roomId: "room-a", attemptId: "attempt-a" },
    status: "completed",
    events: [],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const callsB = makeFetchSequence();
  const storeB = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: callsB.fetchImpl });
  await storeB.recordGatewayExecutionResult({
    request: { ...makeRequest(), roomId: "room-b", attemptId: "attempt-b" },
    status: "completed",
    events: [],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const outboxInsertA = callsA.requests.find((request) => request.method === "POST" && request.url.includes("/huai_outbox"));
  const outboxInsertB = callsB.requests.find((request) => request.method === "POST" && request.url.includes("/huai_outbox"));
  assert.ok(outboxInsertA && outboxInsertB);
  assert.equal(outboxInsertA!.body.room_id, "room-a");
  assert.equal(outboxInsertB!.body.room_id, "room-b");
  assert.notEqual(outboxInsertA!.body.room_id, outboxInsertB!.body.room_id);
});

test("adding room_id to the outbox insert body does not change idempotency conflict resolution", async () => {
  // insertOutboxIdempotently 의 409 충돌 판정은 target_kind/target 만 비교하고
  // room_id 는 select 하지 않는다(코드 상 select=idempotency_key,target_kind,target,payload).
  // room_id 를 새로 실었다고 이 판정이 오탐(잘못된 outbox-idempotency-conflict)을
  // 내면 안 된다 — 매 재시도마다 실행 결과 보고가 죽는 회귀가 된다.
  const base = makeFetchSequence();
  let outboxPostCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    if (url.includes("/huai_outbox") && method === "POST") {
      outboxPostCount += 1;
      base.requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse(409, { message: "duplicate key value violates unique constraint" });
    }
    if (url.includes("/huai_outbox") && method === "GET") {
      base.requests.push({ url, method, body: undefined });
      return jsonResponse(200, [
        {
          idempotency_key: "telegram-report:attempt-1:completed",
          target_kind: "telegram_bot",
          target: JSON.stringify({ kind: "telegram_bot", botRole: "codex_leader", telegramChatId: "1001" }),
          payload: {}
        }
      ]);
    }
    return base.fetchImpl(input, init);
  };
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl });

  await assert.doesNotReject(() =>
    store.recordGatewayExecutionResult({
      request: makeRequest(),
      status: "completed",
      events: [],
      occurredAt: "2026-08-15T00:00:00.000Z"
    })
  );
  assert.equal(outboxPostCount, 1);
});

// 순서 고정 큐는 구현에 호출이 하나 늘 때마다 깨진다. URL 로 응답을 정한다.
function makeFetchSequence(
  _responses?: Response[],
  options: {
    taskStatus?: string;
    siblingEvents?: unknown[];
    // room_id 필터가 실제로 걸리는지 검증하는 테스트 전용 스텁이다. PostgREST 서버처럼
    // room_id 쿼리 파라미터가 있으면 그 room 의 행만 돌려주고, 없으면(필터가 빠진 회귀) 전체를
    // 돌려준다 — 그래야 필터가 빠지는 회귀가 이 스텁으로도 실제로 빨간불이 된다.
    eventsByRoom?: Array<{ room_id: string; event_id: string; payload: Record<string, unknown> }>;
  } = {}
) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.split("/rest/v1")[1] ?? url;
    if (path.includes("huai_rooms")) return jsonResponse(200, [{ telegram_chat_id: "1001" }]);
    if (path.includes("huai_tasks") && method === "GET") return jsonResponse(200, [{ status: options.taskStatus ?? "verification_pending" }]);
    if (path.includes("huai_gateway_instances")) return jsonResponse(200, [{ gateway_id: "gw-1", status: "online" }]);
    if (path.includes("huai_events") && method === "GET") {
      if (options.eventsByRoom) {
        const params = parsePostgrestQuery(url);
        const rows = params.room_id ? options.eventsByRoom.filter((row) => row.room_id === params.room_id) : options.eventsByRoom;
        return jsonResponse(200, rows);
      }
      return jsonResponse(200, options.siblingEvents ?? []);
    }
    if (path.includes("huai_events") && method === "POST") {
      const key = JSON.parse(String(init?.body)).idempotency_key;
      return jsonResponse(201, [{ event_id: "event-" + key, room_id: "room-1", task_id: null, event_type: "x", idempotency_key: key, payload: {}, created_at: "2026-08-13T00:00:00.000Z" }]);
    }
    return jsonResponse(200, []);
  };
  return { fetchImpl, requests };
}

// PostgREST 쿼리스트링을 실제로 파싱한다. URL 접두사 매칭은 "room_id=eq." 가 어디에
// 있든 매치해버려 필터가 실제로 걸리는지, 값이 맞는지를 검증하지 못한다.
function parsePostgrestQuery(url: string): Record<string, string> {
  const queryString = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const result: Record<string, string> = {};
  for (const [key, rawValue] of new URLSearchParams(queryString)) {
    result[key] = rawValue.startsWith("eq.") ? rawValue.slice(3) : rawValue;
  }
  return result;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("auditor completion persists verification and asks leader for completion review", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [{ event_id: "event-audit", room_id: "room-1", task_id: taskId, event_type: "meaningful_intermediate_ready", idempotency_key: "gateway-result:attempt-audit:completed", payload: {}, created_at: "2026-08-13T00:00:00.000Z" }]),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(201, [])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), taskId, attemptId: "attempt-audit", actorId: "33333333-3333-4333-8333-333333333333", reportBotRole: "auditor" },
    status: "completed",
    events: [{ type: "stdout", taskId, attemptId: "attempt-audit", text: "검증 통과. 문제 없음." }],
    occurredAt: "2026-08-13T00:00:00.000Z"
  });

  const verificationInsert = calls.requests.find((request) => /huai_verifications$/.test(request.url));
  assert.equal(verificationInsert?.body.verdict, "pass");
  assert.equal(verificationInsert?.body.task_id, taskId);
  const completionOutbox = calls.requests.find((request) => request.body?.idempotency_key === "telegram-completion-review:attempt-audit");
  assert.equal(completionOutbox?.body.target_kind, "telegram_bot");
  assert.match(completionOutbox?.body.payload.text, /검증이 통과/);
  assert.equal(completionOutbox?.body.payload.keyboard.inline_keyboard[0][2].text, "완료");
});
