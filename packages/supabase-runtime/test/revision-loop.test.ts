import assert from "node:assert/strict";
import test from "node:test";
import {
  SupabaseOutboxStore,
  classifyRevisionChangedScope,
  parseMidApprovalRequestFromEvents,
  renderRevisionRequestText
} from "../src/index.js";
import { type ExecutionRequest } from "../../contracts/src/index.js";

// FR-014 / H-07 / AC-07: 검증 불합격은 막다른 길이 아니어야 한다.
// 불합격 -> 담당팀에 필수 수정 전달 + 작업 상태를 보완 대기로 전이.

const TASK_ID = "66666666-6666-4666-8666-666666666666";
const AUDITOR = "77777777-7777-4777-8777-777777777777";

test("검증 불합격이 보완 요청과 상태 전이를 유발한다", async () => {
  const calls = makeFetchSequence();
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
  const calls = makeFetchSequence();
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
  const calls = makeFetchSequence({ openRevision: true });
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

test("S26: structured midpoint checkpoint is parsed and persists an approval gate", async () => {
  const affectedTaskId = "88888888-8888-4888-8888-888888888888";
  const text = `MID_APPROVAL_START\n${JSON.stringify({
    reportId: "99999999-9999-4999-8999-999999999999",
    approvalRequestId: "mid-attempt-1",
    summary: "데이터 모델 변경안을 확정했습니다.",
    significanceReason: "후속 구현의 저장 형식이 달라집니다.",
    affectedTaskIds: [affectedTaskId]
  })}\nMID_APPROVAL_END`;
  const parsed = parseMidApprovalRequestFromEvents([{ type: "stdout", taskId: TASK_ID, attemptId: "mid-1", text }]);
  assert.equal(parsed?.affectedTaskIds[0], affectedTaskId);

  const calls = makeFetchSequence({ taskStatus: "scheduled" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });
  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), attemptId: "mid-1", reportBotRole: "codex_leader" },
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "mid-1", text }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => request.body?.event_type === "mid_approval_required"), true);
  assert.equal(calls.requests.some((request) => request.method === "POST" && /huai_reports$/.test(request.url)), true);
  assert.equal(calls.requests.some((request) => request.method === "POST" && /huai_task_dependencies$/.test(request.url)), true);
  assert.equal(calls.currentTaskStatus(), "mid_approval_pending");
  const approvalMessage = calls.requests.find((request) => String(request.body?.payload?.text ?? "").includes("데이터 모델 변경안을 확정했습니다."));
  assert.equal(approvalMessage?.body.payload.keyboard, undefined, "운영센터 링크가 없는 경우 Telegram callback keyboard로 fallback하면 안 된다");
  assert.match(String(approvalMessage?.body.payload.text ?? ""), /협업 운영센터/);
});

test("S27/S33: content revision emits submission and queues scoped re-verification", async () => {
  const calls = makeFetchSequence({ taskStatus: "revision_requested" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });
  await store.recordGatewayExecutionResult({
    request: revisionExecutionRequest("content"),
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "revision-submit", text: "필수 수정 완료" }],
    occurredAt: "2026-08-15T01:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => request.body?.event_type === "revision_submitted"), true);
  const revisionPatch = calls.requests.find((request) => request.method === "PATCH" && /huai_revision_requests/.test(request.url));
  assert.equal(revisionPatch?.body.changed_scope, "content");
  assert.equal(calls.currentTaskStatus(), "reverification_pending");
  assert.equal(calls.requests.some((request) => String(request.body?.idempotency_key ?? "").startsWith("gateway:single-worker-audit:")), true);
  const auditRow = calls.requests.find((request) => String(request.body?.idempotency_key ?? "").startsWith("gateway:single-worker-audit:"));
  assert.equal(auditRow?.body.payload.executionRequest.reportBotRole, "auditor");
  assert.equal(auditRow?.body.payload.executionRequest.revisionContext, undefined, "재검증 감사가 보완 제출 문맥을 상속하면 안 된다");
});

test("재검증 감사 통과는 완료 승인 대기까지 전이된다", async () => {
  const calls = makeFetchSequence({ taskStatus: "reverification_pending" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: {
      ...revisionExecutionRequest("content"),
      attemptId: "revision-submit-audit",
      reportBotRole: "auditor"
    },
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "revision-submit-audit", text: "검증 결과: 통과" }],
    occurredAt: "2026-08-15T01:05:00.000Z"
  });

  assert.equal(calls.currentTaskStatus(), "completion_approval_pending");
  assert.equal(calls.requests.some((request) => request.body?.event_type === "revision_submitted"), false);
  assert.equal(calls.requests.some((request) => request.method === "POST" && /huai_verifications$/.test(request.url)), true);
});

test("S33: format-only revision skips full audit and goes to leader confirmation", async () => {
  assert.equal(classifyRevisionChangedScope("오탈자와 서식만 수정"), "format_only");
  assert.equal(classifyRevisionChangedScope("API 동작 변경"), "content");

  const calls = makeFetchSequence({ taskStatus: "revision_requested" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });
  await store.recordGatewayExecutionResult({
    request: revisionExecutionRequest("format_only"),
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "revision-submit", text: "서식 수정 완료" }],
    occurredAt: "2026-08-15T01:00:00.000Z"
  });

  assert.equal(calls.currentTaskStatus(), "commander_completion_pending");
  assert.equal(calls.requests.some((request) => String(request.body?.idempotency_key ?? "").startsWith("gateway:single-worker-audit:")), false);
  assert.equal(calls.requests.some((request) => String(request.body?.idempotency_key ?? "").startsWith("telegram-format-revision-review:")), true);
});

function revisionExecutionRequest(changedScope: "format_only" | "content"): ExecutionRequest {
  return {
    ...makeRequest(),
    attemptId: "revision-submit",
    reportBotRole: "codex_leader",
    revisionContext: {
      revisionRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      priorVerificationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      changedScope,
      reverifyScope: "수정된 파일"
    }
  };
}

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

// 순서 고정 큐는 구현에 호출이 하나 추가될 때마다 깨진다(이미 네 번 깨졌다).
// URL 로 응답을 정하면 호출 순서가 바뀌어도 테스트가 살아남고,
// 무엇을 검증하는지도 분명해진다.
function makeFetchSequence(options: { taskStatus?: string; openRevision?: boolean } = {}) {
  let taskStatus = options.taskStatus ?? "verification_in_progress";
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    const path = url.split("/rest/v1")[1] ?? url;
    if (path.includes("huai_rooms")) return jsonResponse(200, [{ telegram_chat_id: "1001" }]);
    if (path.includes("huai_tasks") && method === "GET") return jsonResponse(200, [{ status: taskStatus }]);
    if (path.includes("huai_tasks") && method === "PATCH") {
      taskStatus = JSON.parse(String(init?.body)).status;
      return jsonResponse(200, []);
    }
    if (path.includes("huai_gateway_instances") && method === "GET") return jsonResponse(200, [{ gateway_id: "primary" }]);
    if (path.includes("huai_revision_requests") && method === "GET") {
      return jsonResponse(200, options.openRevision ? [{ revision_request_id: "existing" }] : []);
    }
    if (path.includes("huai_events") && method === "POST") {
      return jsonResponse(201, [eventRow(JSON.parse(String(init?.body)).idempotency_key, "x")]);
    }
    if (path.includes("huai_verifications") && method === "POST") {
      return jsonResponse(201, [{ verification_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
    }
    if (path.includes("huai_revision_requests") && method === "POST") {
      return jsonResponse(201, [{ revision_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
    }
    return jsonResponse(200, []);
  };
  return { fetchImpl, requests, currentTaskStatus: () => taskStatus };
}

// 승인된 작업이 사람 손 없이 검증 대기까지 스스로 이동하는가.
// 이게 없으면 실행이 끝나도 작업이 scheduled 로 남아 /tasks 에 "실행 대기"로 보인다.

test("실행이 끝나면 작업이 스스로 검증 대기까지 이동한다", async () => {
  const calls = makeFetchSequence({ taskStatus: "scheduled" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), attemptId: "attempt-auto", reportBotRole: "codex_leader" },
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-auto", text: "구현 완료. 테스트 통과." }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const patched = calls.requests
    .filter((request) => request.method === "PATCH" && /huai_tasks/.test(request.url))
    .map((request) => request.body.status);
  assert.equal(patched.length > 0, true, "실행 결과가 상태기계에 반영되어야 한다");
  assert.equal(patched.includes("queued_for_gateway"), true);
});

test("실행이 실패하면 검증 대기로 넘어가지 않는다", async () => {
  const calls = makeFetchSequence({ taskStatus: "in_progress" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), attemptId: "attempt-failed", reportBotRole: "codex_leader" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const patched = calls.requests
    .filter((request) => request.method === "PATCH" && /huai_tasks/.test(request.url))
    .map((request) => request.body.status);
  assert.equal(patched.includes("verification_pending"), false, "실패한 작업을 검증에 넘기면 안 된다");
});

test("검증 통과는 완료 승인 대기까지 스스로 이동한다 (마지막 한 번만 방장이 누른다)", async () => {
  const calls = makeFetchSequence({ taskStatus: "verification_pending" });
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), attemptId: "attempt-pass" },
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-pass", text: "검증 통과. 문제 없음." }],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const review = calls.requests.find((request) => String(request.body?.idempotency_key ?? "").startsWith("telegram-completion-review:"));
  assert.ok(review, "방장에게 완료 승인 요청이 올라가야 한다");

  // 이 테스트가 지키는 것은 "마지막 한 번은 방장이 결정한다"이지 버튼이 어디 있느냐가
  // 아니다. 완료·보완 결정 창구는 협업 운영센터로 옮겼으므로 방에는 버튼을 붙이지 않는다.
  // 대신 어디서 결정하는지는 반드시 알려줘야 한다 — 안내 없이 버튼만 사라지면
  // 방장은 완료시킬 방법을 못 찾고, 작업이 승인 대기로 영원히 남는다.
  assert.equal(review.body.payload.keyboard, undefined, "방에 완료 버튼이 다시 붙었다");
  assert.match(String(review.body.payload.text), /협업 운영센터/, "어디서 결정하는지 안내가 없다");
});
