import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore, renderRevisionRequestText } from "../src/index.js";
import { type ExecutionRequest } from "../../contracts/src/index.js";

// FR-014 / H-07 / AC-07: 검증 불합격은 막다른 길이 아니어야 한다.
// 불합격 -> 담당팀에 필수 수정 전달 + 작업 상태를 보완 대기로 전이.

const TASK_ID = "66666666-6666-4666-8666-666666666666";
const AUDITOR = "77777777-7777-4777-8777-777777777777";

test("검증 불합격이 보완 요청과 상태 전이를 유발한다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-fail:completed", "meaningful_intermediate_ready")]),
    jsonResponse(201, []),                                   // 결과 보고 outbox
    jsonResponse(200, []),                                   // 기존 verification 조회
    jsonResponse(201, []),                                   // verification INSERT
    jsonResponse(200, []),                                   // 기존 open revision_request 조회
    jsonResponse(201, []),                                   // revision_request INSERT
    jsonResponse(201, [eventRow("verification-failed:attempt-fail", "verification_failed_or_changes_requested")]),
    jsonResponse(200, [{ status: "verification_in_progress" }]),  // 현재 상태
    jsonResponse(200, []),                                   // PATCH huai_tasks
    jsonResponse(201, [])                                    // 담당팀 보완 요청 outbox
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-fail", text: "검증 결과 불합격. 입력 검증이 누락되었습니다." }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const verification = calls.requests.find((request) => request.method === "POST" && /huai_verifications$/.test(request.url));
  assert.equal(verification?.body.verdict, "fail");

  const revision = calls.requests.find((request) => request.method === "POST" && /huai_revision_requests$/.test(request.url));
  assert.ok(revision, "보완 요청이 기록되어야 한다");
  assert.equal(revision.body.task_id, TASK_ID);
  assert.equal(revision.body.status, "open");
  assert.match(revision.body.required_fixes, /입력 검증이 누락/);

  const failEvent = calls.requests.find((request) => request.body?.idempotency_key === "verification-failed:attempt-fail");
  assert.equal(failEvent?.body.event_type, "verification_failed_or_changes_requested");
  assert.equal(failEvent?.body.payload.changedScope, "content");

  const patch = calls.requests.find((request) => request.method === "PATCH" && /huai_tasks/.test(request.url));
  assert.equal(patch?.body.status, "revision_requested", "상태가 보완 대기로 전이되어야 한다");

  // 검증자 봇이 아니라 원 담당팀 봇이 보완 요청을 받아야 한다 (AC-07)
  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-revision-request:attempt-fail");
  assert.equal(message?.body.target_kind, "telegram_bot");
  assert.equal(message?.body.payload.botRole, "codex_leader");
  assert.match(message?.body.payload.text, /보완이 필요합니다/);
});

test("불합격 시 완료 검토 버튼은 발행되지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-fail2:completed", "meaningful_intermediate_ready")]),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(201, [eventRow("verification-failed:attempt-fail2", "verification_failed_or_changes_requested")]),
    jsonResponse(200, [{ status: "verification_in_progress" }]),
    jsonResponse(200, []),
    jsonResponse(201, [])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), attemptId: "attempt-fail2" },
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-fail2", text: "불합격. 보완 필요." }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => /telegram-completion-review/.test(String(request.body?.idempotency_key ?? ""))), false);
});

test("이미 열린 보완 요청이 있으면 중복 생성하지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-fail3:completed", "meaningful_intermediate_ready")]),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, [{ revision_request_id: "existing" }]),   // 이미 열린 보완 요청
    jsonResponse(201, [eventRow("verification-failed:attempt-fail3", "verification_failed_or_changes_requested")]),
    jsonResponse(200, [{ status: "verification_in_progress" }]),
    jsonResponse(200, []),
    jsonResponse(201, [])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), attemptId: "attempt-fail3" },
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-fail3", text: "불합격" }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.filter((request) => request.method === "POST" && /huai_revision_requests$/.test(request.url)).length, 0);
});

test("보완 요청 문구에 필수 수정과 재검증 범위가 담긴다", () => {
  const text = renderRevisionRequestText(TASK_ID, "입력 검증 누락", "보완된 변경 범위");
  assert.match(text, /보완이 필요합니다/);
  assert.match(text, /필수 수정:/);
  assert.match(text, /입력 검증 누락/);
  assert.match(text, /재검증 범위: 보완된 변경 범위/);
});

test("보완 요청 문구는 시크릿을 담지 않는다", () => {
  const text = renderRevisionRequestText(TASK_ID, "Bearer leaked.token.value 로 접근 실패", "범위");
  assert.equal(text.includes("leaked.token.value"), false);
});

function makeRequest(): ExecutionRequest {
  return {
    roomId: "11111111-1111-4111-8111-111111111111",
    taskId: TASK_ID,
    attemptId: "attempt-fail",
    actorId: AUDITOR,
    requestedBy: "5001",
    adapterType: "codex",
    projectPath: "C:/work",
    prompt: "검증해줘",
    timeoutMs: 30_000,
    idempotencyKey: "exec-fail",
    createdAt: "2026-08-15T00:00:00.000Z",
    reportBotRole: "auditor"
  };
}

function eventRow(idempotencyKey: string, eventType: string) {
  return {
    event_id: "event-" + idempotencyKey,
    room_id: "11111111-1111-4111-8111-111111111111",
    task_id: TASK_ID,
    event_type: eventType,
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
