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
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [{ event_id: "event-codex", room_id: "room-1", task_id: null, event_type: "meaningful_intermediate_ready", idempotency_key: "gateway-result:attempt-1-codex:completed", payload: {}, created_at: "2026-08-13T00:00:00.000Z" }]),
    jsonResponse(201, []),
    jsonResponse(200, [
      { event_id: "event-codex", payload: { taskId: "proposal-1", attemptId: "attempt-1-codex", status: "completed", events: [{ type: "stdout", text: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}' }] } },
      { event_id: "event-claude", payload: { taskId: "proposal-1", attemptId: "attempt-1-claude", status: "completed", events: [{ type: "stdout", text: "ClaudeBot 결론: 보완 필요" }] } }
    ]),
    jsonResponse(200, [{ gateway_id: "gateway-local", status: "offline" }]),
    jsonResponse(201, [])
  ]);
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

function makeFetchSequence(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call");
    return response;
  };
  return { fetchImpl, requests };
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
