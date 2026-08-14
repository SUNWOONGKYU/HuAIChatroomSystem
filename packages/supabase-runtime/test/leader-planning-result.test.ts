import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TELEGRAM_CALLBACK_BYTES, SupabaseOutboxStore, renderLeaderPlanMessage, sessionIdFromGatewayEvents, shortProposalId } from "../src/index.js";
import { buildProposalKeyboard } from "../../telegram-ui/src/index.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";

// 소대장이 대화를 읽고 내린 판단이 방장에게 승인 버튼과 함께 올라가는가.

const ROOM = "11111111-1111-4111-8111-111111111111";
const LEADER_ACTOR = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "leader-planning-planning_0001";

const PLAN = {
  title: "결제 실패율 상승 원인 조사 및 수정",
  purpose: "실패율 원인을 파악하고 재발 방지 조치를 적용한다",
  scope: "재시도 로직 점검, 타임아웃 검토, 실패 건 로그 누락 수정",
  completionCriteria: "원인 특정, 실패 건 100% 기록, 테스트 통과",
  assignee: "both",
  reason: "분석은 Claude, 수정·테스트는 Codex"
};

test("소대장 판단이 제안 이벤트와 승인 버튼으로 올라간다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])                                   // 제안 outbox
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const proposalEvent = calls.requests.find((request) => request.body?.idempotency_key === "leader-proposal:" + ATTEMPT);
  assert.ok(proposalEvent, "제안 이벤트가 기록되어야 한다");
  assert.equal(proposalEvent.body.event_type, "proposal_created");
  assert.equal(proposalEvent.body.payload.title, PLAN.title);
  assert.equal(proposalEvent.body.payload.completionCriteria, PLAN.completionCriteria);
  assert.equal(proposalEvent.body.payload.assignee, "both");

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.equal(message?.body.payload.botRole, "platoon_leader");
  assert.ok(message?.body.payload.keyboard, "방장이 누를 승인 버튼이 있어야 한다");
  assert.match(message?.body.payload.text, /결제 실패율 상승 원인/);
  assert.match(message?.body.payload.text, /완료 조건:/);
});

test("판단 결과에는 아티팩트·감사 처리가 붙지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => /huai_artifacts/.test(request.url)), false, "판단은 산출물이 아니다");
  assert.equal(calls.requests.some((request) => /huai_verifications/.test(request.url)), false);
});

test("소대장이 나설 자리가 아니라고 하면 제안을 만들지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-no-action:" + ATTEMPT)])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify({ noAction: "사람끼리 상의 중이라 개입할 단계가 아님" }))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => /telegram-leader-plan/.test(String(request.body?.idempotency_key ?? ""))), false, "방을 어지럽히지 않는다");
  const record = calls.requests.find((request) => request.body?.idempotency_key === "leader-no-action:" + ATTEMPT);
  assert.match(record?.body.payload.reason, /상의 중/, "판단 사유는 기록에 남는다");
});

test("판단을 못 하면 조용히 넘기지 않고 되묻는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout("무슨 말인지 잘 모르겠습니다")],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.match(message?.body.payload.text, /정리하지 못했습니다/, "사람이 불렀는데 무반응이면 죽은 것처럼 보인다");
  assert.equal(message?.body.payload.keyboard, undefined, "정리 못 했으면 승인 버튼도 없다");
});

test("다음 호출에서 이어받도록 세션을 기억한다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(200, []),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [
      stdout('{"session_id":"3bf2d064-e882-4abe-920e-5893ce0a4e59"}'),
      stdout(JSON.stringify(PLAN))
    ],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const patch = calls.requests.find((request) => request.method === "PATCH" && /huai_ai_actors/.test(request.url));
  assert.equal(patch?.body.cli_session_id, "3bf2d064-e882-4abe-920e-5893ce0a4e59");
});

test("승인 버튼의 callback_data 가 Telegram 한계를 넘지 않는다", () => {
  // 실전에서 71바이트가 나가 BUTTON_DATA_INVALID 로 죽었다.
  // 소대장 제안이 방장에게 도달하지 못한 원인이었다.
  const attempt = "leader-planning-planning_3dc08364-5a93-4dab-9c2d-875f18cd352f";
  const keyboard = buildProposalKeyboard(shortProposalId(attempt));
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      const bytes = Buffer.byteLength(String((button as { callback_data: string }).callback_data), "utf8");
      assert.equal(bytes <= MAX_TELEGRAM_CALLBACK_BYTES, true, `callback_data ${bytes}바이트: ${(button as { callback_data: string }).callback_data}`);
    }
  }
});

test("판단 실행은 작업 실행 보고를 내보내지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const report = calls.requests.find((request) => String(request.body?.idempotency_key ?? "").startsWith("telegram-report:"));
  assert.equal(report, undefined, "판단은 작업 실행이 아니다 — 방에 '작업 실행 완료' 를 남기면 잡음이다");
});

test("세션 id 추출", () => {
  assert.equal(
    sessionIdFromGatewayEvents([stdout('앞말 {"session_id":"3bf2d064-e882-4abe-920e-5893ce0a4e59"} 뒷말')]),
    "3bf2d064-e882-4abe-920e-5893ce0a4e59"
  );
  assert.equal(sessionIdFromGatewayEvents([stdout("세션 없음")]), undefined);
  assert.equal(sessionIdFromGatewayEvents([stdout('{"session_id":"짧음"}')]), undefined);
});

test("제안 메시지에 내부 상태가 아니라 사람이 읽을 내용만 담긴다", () => {
  const text = renderLeaderPlanMessage({ ...PLAN, assignee: "both" } as never);
  assert.match(text, /작업 제안:/);
  assert.match(text, /담당: ClaudeBot \+ CodexBot/);
  assert.equal(text.includes("leader-planning-"), false);
  assert.equal(text.includes("attemptId"), false);
});

function makeStore(fetchImpl: typeof fetch) {
  return new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl });
}

function makeRequest(): ExecutionRequest {
  return {
    roomId: ROOM,
    taskId: "planning_0001",
    attemptId: ATTEMPT,
    actorId: LEADER_ACTOR,
    requestedBy: "5001",
    adapterType: "claude_code",
    projectPath: "C:/work",
    prompt: "판단 프롬프트",
    timeoutMs: 300000,
    idempotencyKey: "leader-planning:planning_0001",
    createdAt: "2026-08-15T00:00:00.000Z",
    reportBotRole: "platoon_leader"
  };
}

function stdout(text: string): GatewayEvent {
  return { type: "stdout", taskId: "planning_0001", attemptId: ATTEMPT, text };
}

function eventRow(idempotencyKey: string) {
  return {
    event_id: "event-" + idempotencyKey,
    room_id: ROOM,
    task_id: null,
    event_type: "proposal_created",
    idempotency_key: idempotencyKey,
    payload: {},
    created_at: "2026-08-15T00:00:00.000Z"
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeFetchSequence(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call:" + String(input));
    return response;
  };
  return { fetchImpl, requests };
}
