import assert from "node:assert/strict";
import test from "node:test";
import { buildReportOpenKeyboard, buildRoomMessageWithPreview, previewRoomMessage, SupabaseOutboxStore, renderGatewayReportText } from "../src/index.js";
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

// claude 어댑터를 --output-format text 에서 json 으로 바꿨다(session_id 를 stdout 에
// 실으려면 그래야 한다 — text 모드엔 아예 안 실렸다). 그 JSON 통짜 덩어리가 방에 그대로
// 뜨면 안 되고, 안의 result 필드(사람이 볼 답)만 나가야 한다. 아래 JSON은
// `claude --print --output-format json` 을 실제로 호출해서 받은 실측 응답을 그대로 썼다
// (내용만 "hello world" → 이 테스트 문구로 바꿈).
test("claude json 출력에서 result 만 뽑아 보여주고 나머지 필드는 감춘다 (output-format 전환 회귀 방지)", () => {
  const claudeJson = JSON.stringify({
    is_error: false,
    duration_api_ms: 2204,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "70d92161-02d7-45cd-8a3b-a4a1c3383e51",
    total_cost_usd: 0.069088,
    usage: { input_tokens: 9, output_tokens: 75 },
    permission_denials: [],
    terminal_reason: "completed",
    subtype: "success",
    api_error_status: null,
    result: "확인했습니다. 다음 조치를 진행하겠습니다.",
    type: "result",
    duration_ms: 3165,
    uuid: "4bf44264-43b4-4b80-9f35-24123bf50b94"
  });

  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "claude_code" },
    status: "completed",
    events: [
      { type: "accepted", taskId: "task-1", attemptId: "attempt-1" },
      { type: "started", taskId: "task-1", attemptId: "attempt-1", at: "2026-08-11T00:00:00.000Z" },
      { type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: claudeJson }
    ]
  });

  assert.match(text, /확인했습니다\. 다음 조치를 진행하겠습니다\./);
  assert.equal(text.includes("session_id"), false);
  assert.equal(text.includes("total_cost_usd"), false);
  assert.equal(text.includes("70d92161"), false, "세션 id 가 방 화면에 그대로 새어 나가면 안 된다");
  assert.equal(text.includes('"type":"result"'), false, "JSON 원문이 아니라 사람이 볼 텍스트만 나가야 한다");
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
// 인지부채 방지 퀴즈 — 파일을 실제로 바꾼 작업자 실행이 완료되면, 보고 끝에 실린
// QUIZ_START/QUIZ_END 블록이 (1) huai_task_quizzes 에 저장되고 (2) 방으로 나가는
// 보고 텍스트에서는 지워져야 한다(방장에게 원문 JSON이 그대로 보이면 안 된다).
test("완료 보고의 QUIZ 블록은 huai_task_quizzes 에 저장되고 방 보고문에서는 사라진다", async () => {
  const quiz = {
    summary: "index.ts에 로그인 체크를 추가했습니다.",
    questions: [
      { q: "무엇을 추가했나요?", choices: ["로그인 체크", "삭제 로직", "캐시", "알림"], correct: 0 },
      { q: "왜 필요했나요?", choices: ["보안", "속도", "디자인", "비용"], correct: 0 },
      { q: "영향받는 파일은?", choices: ["index.ts", "README.md", "없음", "전체"], correct: 0 }
    ]
  };
  const quizText = ["작업을 완료했습니다.", "QUIZ_START", JSON.stringify(quiz), "QUIZ_END"].join("\n");
  const stdoutText = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: quizText } });

  const calls = makeFetchSequence();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  const taskId = "11111111-1111-4111-8111-111111111111";
  const roomId = "22222222-2222-4222-8222-222222222222";
  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), taskId, roomId, reportBotRole: "codex_leader" },
    status: "completed",
    events: [
      { type: "stdout", taskId, attemptId: "attempt-1", text: stdoutText },
      { type: "artifact_collected", taskId, attemptId: "attempt-1", artifact: { path: "index.ts", sizeBytes: 10, checksum: "abc", version: "attempt-1" } }
    ],
    occurredAt: "2026-08-22T00:00:00.000Z"
  });

  const quizInsert = calls.requests.find((request) => request.method === "POST" && request.url.includes("/huai_task_quizzes"));
  assert.ok(quizInsert, "expected a POST to huai_task_quizzes");
  assert.equal(quizInsert!.body.task_id, taskId);
  assert.equal(quizInsert!.body.room_id, roomId);
  assert.equal(quizInsert!.body.summary, quiz.summary);
  assert.deepEqual(quizInsert!.body.questions, quiz.questions);
  assert.equal(quizInsert!.body.passed, false);

  const reportInsert = calls.requests.find((request) => request.method === "POST" && request.url.includes("/huai_outbox") && request.body?.target_kind !== undefined);
  const reportText = String(reportInsert?.body?.payload?.text ?? "");
  assert.equal(reportText.includes("QUIZ_START"), false, "QUIZ 원문 JSON이 방 보고문에 새면 안 된다");
  assert.match(reportText, /작업을 완료했습니다/, "본문 자체는 그대로 남아야 한다");
});

test("감사(auditor) 완료 실행에서는 퀴즈를 저장하지 않는다", async () => {
  const quiz = {
    summary: "요약",
    questions: [
      { q: "q1", choices: ["a", "b", "c", "d"], correct: 0 },
      { q: "q2", choices: ["a", "b", "c", "d"], correct: 0 },
      { q: "q3", choices: ["a", "b", "c", "d"], correct: 0 }
    ]
  };
  const stdoutText = ["감사 완료.", "QUIZ_START", JSON.stringify(quiz), "QUIZ_END"].join("\n");

  const calls = makeFetchSequence();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  const taskId = "33333333-3333-4333-8333-333333333333";
  const roomId = "44444444-4444-4444-8444-444444444444";
  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), taskId, roomId, reportBotRole: "auditor" },
    status: "completed",
    events: [
      { type: "stdout", taskId, attemptId: "attempt-1", text: stdoutText },
      { type: "artifact_collected", taskId, attemptId: "attempt-1", artifact: { path: "index.ts", sizeBytes: 10, checksum: "abc", version: "attempt-1" } }
    ],
    occurredAt: "2026-08-22T00:00:00.000Z"
  });

  const quizInsert = calls.requests.find((request) => request.method === "POST" && request.url.includes("/huai_task_quizzes"));
  assert.equal(quizInsert, undefined, "감사는 방장이 이해해야 할 변경이 아니다");
});

test("파일을 바꾸지 않은(조회성) 완료 실행에서는 QUIZ 블록이 있어도 저장하지 않는다", async () => {
  const quiz = {
    summary: "요약",
    questions: [
      { q: "q1", choices: ["a", "b", "c", "d"], correct: 0 },
      { q: "q2", choices: ["a", "b", "c", "d"], correct: 0 },
      { q: "q3", choices: ["a", "b", "c", "d"], correct: 0 }
    ]
  };
  const stdoutText = ["README.md 줄 수: 86줄", "QUIZ_START", JSON.stringify(quiz), "QUIZ_END"].join("\n");

  const calls = makeFetchSequence();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  const taskId = "55555555-5555-4555-8555-555555555555";
  const roomId = "66666666-6666-4666-8666-666666666666";
  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), taskId, roomId, reportBotRole: "codex_leader" },
    status: "completed",
    events: [{ type: "stdout", taskId, attemptId: "attempt-1", text: stdoutText }],
    occurredAt: "2026-08-22T00:00:00.000Z"
  });

  const quizInsert = calls.requests.find((request) => request.method === "POST" && request.url.includes("/huai_task_quizzes"));
  assert.equal(quizInsert, undefined, "바꾼 파일이 없으면 이해도를 확인할 diff 자체가 없다");
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
  // 3000자짜리 보고는 이제 안 잘린다. 예전 상한 3200 은 "한 메시지에 담자"로 정한
  // 값이었는데, 전송 쪽에 이미 분할이 있어서(splitTelegramText) 스스로 버린 양이었다.
  const longSummary = "가".repeat(3000) + "끝";
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: longSummary }]
  });
  assert.equal(text.includes("끝"), true, "보고 끝부분이 잘려나갔다");
  assert.equal(text.includes("여기까지만 표시"), false, "이 길이는 자를 필요가 없다");
});

test("보고가 아주 길면 자르되 잘렸다고 알린다", () => {
  // 작업자가 로그를 통째로 뱉으면 방이 그걸로 덮인다. 다만 "..." 만 붙으면 뒤에 뭐가
  // 더 있었는지 방장이 알 수 없으므로, 잘렸다는 사실과 어디서 전체를 보는지를 남긴다.
  const huge = "나".repeat(20000) + "마지막줄";
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: huge }]
  });

  assert.equal(text.includes("마지막줄"), false);
  assert.match(text, /여기까지만 표시/);
  assert.match(text, /\/trace/, "전체를 어디서 보는지 알려줘야 한다");
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

  // 표·파일 경로·자기 한계 서술은 이제 남긴다.
  //
  // 이 셋을 지우던 규칙이 라이브에서 답을 지웠다. 비교 결과는 표로 오고, 원인 위치는
  // 📁/📄 표기로 오며, 둘 다 그 줄 자체가 답이다.
  //
  // "검증 제한" 류를 지우던 것이 특히 나빴다. 오늘 ClaudeBot 이 "실행 승인이 안 걸려
  // 못 돌렸다"고 자기 한계를 적어놨고, 그 한 줄이 권한 결함을 찾은 단서였다. 작업자가
  // 무엇을 못 했는지 말하는 문장은 방장이 가장 알아야 할 것에 속한다.
  assert.match(text, /\| 분야 \|/, "표가 사라졌다");
  assert.match(text, /OPERATION_STATUS\.md/, "원인 위치 표기가 사라졌다");
  assert.match(text, /검증 제한도/, "작업자가 밝힌 한계가 사라졌다");
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

  // 완료·보완 결정은 작업 현황판이 맡는다. 방에 버튼을 붙이면 결정 창구가 둘로 갈라지고
  // 대화 공간도 버튼 줄로 잠식된다. 대신 어디서 결정하는지는 본문이 알려줘야 한다 —
  // 안내 없이 버튼만 사라지면 방장은 완료시킬 방법을 못 찾는다.
  assert.equal(completionOutbox?.body.payload.keyboard, undefined, "방에 완료 버튼이 다시 붙었다");
  assert.match(completionOutbox?.body.payload.text, /작업 현황판/);
});

// 라이브 결함 회귀 — 작업 결과가 방에 안 뜬 사건.
//
// ClaudeBot 이 아래 출력을 실제로 냈는데 방에는 "결과:" 뒤가 비고 마지막 줄만 갔다.
// 원인은 "결론·판정·조치·완료" 단어표로 중요한 줄을 고르고 나머지를 버리던 로직이었다.
// 답("86줄")에는 그런 단어가 없어서 버려졌고, 사무적인 마지막 줄만 살아남았다.
test("작업자가 낸 답을 단어표로 골라내다 버리지 않는다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [
      { type: "accepted", taskId: "task-1", attemptId: "attempt-1" },
      {
        type: "stdout",
        taskId: "task-1",
        attemptId: "attempt-1",
        text: [
          "README.md 줄 수: **86줄**",
          "",
          "근거: `wc -l README.md` 실행 결과 `86 README.md`. 저장소 루트 파일 존재 확인됨.",
          "",
          "후속 조치: 불필요. 단순 조사 요청이라 완료."
        ].join("\n")
      }
    ]
  });

  assert.match(text, /86줄/, "작업 결과가 방에 안 갔다 — 이게 사라지면 일을 시켜도 답을 못 받는다");
  assert.match(text, /근거/);
  assert.match(text, /후속 조치/);
});

test("답에 관료적 단어가 하나도 없어도 그대로 전달한다", () => {
  // "결론/판정/조치" 같은 단어가 전혀 없는 출력. 예전 단어표로는 전부 버려졌다.
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [
      {
        type: "stdout",
        taskId: "task-1",
        attemptId: "attempt-1",
        text: "현재 브랜치는 feat/leader-brain-and-collaboration 이고 최신 커밋은 deaaede 입니다."
      }
    ]
  });

  assert.match(text, /feat\/leader-brain-and-collaboration/);
  assert.match(text, /deaaede/);
});

test("여섯 줄이 넘는 답도 앞부분이 잘려나가지 않는다", () => {
  // 예전에는 중요 줄 6개만 남겨서, 답이 7번째 줄에 있으면 통째로 사라졌다.
  const lines = Array.from({ length: 12 }, (_, index) => `단계 ${index + 1} 진행 상황 기록`);
  lines.push("최종 수치: 4321");
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: lines.join("\n") }]
  });

  assert.match(text, /단계 1 /, "맨 앞줄이 사라졌다");
  assert.match(text, /단계 12 /);
  assert.match(text, /4321/);
});

// 라이브 결함 회귀 2차 — 답이 파일 이름을 말했다는 이유로 버려진 사건.
test("답이 파일 이름을 언급해도 버리지 않는다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [
      {
        type: "stdout",
        taskId: "task-1",
        attemptId: "attempt-1",
        text: [
          "조사 결과: `package.json` name 필드 값 = `\"hu-ai-chatroom-system\"`.",
          "",
          "근거: `C:\Dev\HuAIChatroomSystem\package.json` 2번째 줄 직접 읽음.",
          "",
          "후속 조치: 불필요. 값 확인 끝."
        ].join("\n")
      }
    ]
  });

  assert.match(text, /hu-ai-chatroom-system/, "답이 사라졌다 — 파일 이름이 들어갔다고 버리면 안 된다");
  assert.match(text, /package\.json/);
});

test("확장자가 무엇이든 문장 속 파일 이름은 살린다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [
      {
        type: "stdout",
        taskId: "task-1",
        attemptId: "attempt-1",
        text: [
          "tsconfig.json 의 strict 설정은 true 입니다.",
          "index.ts 에는 함수가 42개 있습니다.",
          "app.js 는 존재하지 않습니다."
        ].join("\n")
      }
    ]
  });

  assert.match(text, /strict 설정은 true/);
  assert.match(text, /함수가 42개/);
  assert.match(text, /존재하지 않습니다/);
});

test("줄 전체가 경로뿐이면 여전히 버린다", () => {
  // 파일 목록·산출물 나열은 사람에게 하려던 말이 아니다.
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [
      {
        type: "stdout",
        taskId: "task-1",
        attemptId: "attempt-1",
        text: [
          "변경한 파일:",
          "C:\Dev\HuAIChatroomSystem\packages\orchestrator\src\index.ts",
          "dist/apps/bot-service/src/cli.js",
          "node_modules/.bin/tsc",
          "결론: 세 파일을 갱신했습니다."
        ].join("\n")
      }
    ]
  });

  assert.match(text, /세 파일을 갱신했습니다/);
  assert.equal(text.includes("node_modules"), false);
  assert.equal(text.includes("dist/apps"), false);
});

// "검증해 드릴까요" 메시지 자체가 없어졌다(파일을 바꾼 작업은 묻지 않고 바로 감사가
// 돈다). 그 문구를 검사하던 테스트도 함께 제거했다 — 감사 실행 여부는 아래
// automatic-audit.test.ts 가 지킨다.

// 독립 검증(Codex)이 짚은 잔여 필터 회귀.
// 단어표·확장자 목록을 걷어낸 뒤에도 표·제목·경로 표기를 지우는 규칙이 남아 있었다.
test("표로 온 답을 지우지 않는다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{
      type: "stdout", taskId: "task-1", attemptId: "attempt-1",
      text: [
        "비교 결과:",
        "| 항목 | 전 | 후 |",
        "| --- | --- | --- |",
        "| 응답시간 | 4.3분 | 20초 |"
      ].join("\n")
    }]
  });

  assert.match(text, /응답시간/, "표가 통째로 사라졌다 — 비교 결과는 표로 오는 경우가 많다");
  assert.match(text, /20초/);
});

test("제목 줄을 지우지 않는다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "## 결론\n입력 검증이 누락돼 있었습니다." }]
  });

  assert.match(text, /결론/);
  assert.match(text, /입력 검증이 누락/);
});

test("파일 경로 표기(📁 📄)를 지우지 않는다", () => {
  // 이 프로젝트가 파일 위치를 이렇게 쓰라고 정해둔 표기다. 그 줄이 곧 답인 경우가 많다.
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "원인 위치:\n📁 packages/orchestrator/src/\n📄 index.ts" }]
  });

  assert.match(text, /packages\/orchestrator/);
  assert.match(text, /index\.ts/);
});

test("대문자 접두어가 붙은 정상 문장을 지우지 않는다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "API: 응답 스키마가 바뀌었습니다.\nSQL: 인덱스가 없습니다." }]
  });

  assert.match(text, /응답 스키마가 바뀌었습니다/);
  assert.match(text, /인덱스가 없습니다/);
});

test("구조적 잡음은 여전히 걸러낸다", () => {
  // 필터를 줄였다고 JSON·로그·스택프레임까지 새면 안 된다.
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "completed",
    events: [{
      type: "stdout", taskId: "task-1", attemptId: "attempt-1",
      text: [
        '{"type":"tool_result","secret":"INTERNAL"}',
        "2026-08-16T10:00:00Z DEBUG worker payload",
        "at runWorker (C:\Dev\worker.ts:10:2)",
        "dist/apps/bot-service/src/cli.js",
        "결론: 점검을 마쳤습니다."
      ].join("\n")
    }]
  });

  assert.match(text, /점검을 마쳤습니다/);
  assert.equal(text.includes("INTERNAL"), false);
  assert.equal(text.includes("DEBUG"), false);
  assert.equal(text.includes("worker.ts"), false);
  assert.equal(text.includes("dist/apps"), false);
});

// 라이브 결함 회귀 — Codex 한도 초과가 "실행 중 오류"로 뭉개지던 문제.
//
// 감사는 작업자와 다른 엔진에 맡긴다. ClaudeBot 이 일한 작업의 감사를 Codex 가 받았는데
// Codex 계정이 한도에 걸렸다. 한도 초과는 exit code 1 로 끝나서 방에는 "실행 중 오류가
// 발생했습니다" 로만 나왔고, 우리 코드가 잘못된 것처럼 보였다.
// 한도는 기다리면 풀리고 오류는 고쳐야 한다 — 조치가 다르면 문장도 달라야 한다.
test("Codex 사용 한도 초과를 원인 그대로 알린다", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "codex" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{
      type: "stdout",
      taskId: "task-1",
      attemptId: "attempt-1",
      text: '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings to upgrade."}'
    }]
  });

  assert.match(text, /CodexBot 현재 상태: 사용 한도 초과/);
  assert.match(text, /ClaudeBot으로 작업/, "다음에 무엇을 할 수 있는지 알려줘야 한다");
  assert.equal(text.includes("실행 중 오류가 발생했습니다"), false, "원인이 뭉개졌다");
  assert.equal(text.includes("chatgpt.com"), false, "내부 URL 을 방에 그대로 흘리지 않는다");
});

test("Codex 한도를 ClaudeBot 한도로 잘못 부르지 않는다", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "codex" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: '{"type":"error","message":"You have hit your usage limit."}' }]
  });

  assert.equal(text.includes("ClaudeBot 현재 상태"), false);
});

test("한도가 아닌 Codex 실패는 그대로 오류로 알린다", () => {
  // 한도 문구를 넓게 잡아 진짜 오류까지 "한도 초과"로 덮으면, 고쳐야 할 것을 기다리게 된다.
  const text = renderGatewayReportText({
    request: { ...makeRequest(), adapterType: "codex" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "설정 파일을 읽지 못했습니다." }]
  });

  assert.equal(text.includes("사용 한도 초과"), false);
});

// 라이브 결함 회귀 — 감사가 Codex 한도로 죽었는데 방에는 "작업 실행 실패"로 떴다.
// 작업은 성공했고 파일도 바뀐 상태였다. 방장은 작업이 실패한 줄 알았다.
test("감사 실패는 작업 실패와 다른 문구로 보고한다", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), reportBotRole: "auditor" },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: '{"type":"error","message":"You\'ve hit your usage limit."}' }]
  });

  assert.equal(text.startsWith("감사 실행 실패"), true);
  assert.equal(text.includes("작업 실행 실패"), false);
  // 방장이 무엇을 잃었는지 알아야 승인 여부를 정할 수 있다.
  assert.equal(text.includes("작업 결과 자체는 남아 있습니다"), true);
});

test("작업 실패 문구는 그대로 둔다", () => {
  const text = renderGatewayReportText({
    request: makeRequest(),
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "설정 파일을 읽지 못했습니다." }]
  });

  assert.equal(text.startsWith("작업 실행 실패"), true);
  assert.equal(text.includes("감사"), false);
});

test("감사 성공도 작업 완료로 읽히지 않는다", () => {
  const text = renderGatewayReportText({
    request: { ...makeRequest(), reportBotRole: "auditor" },
    status: "completed",
    events: [{ type: "stdout", taskId: "task-1", attemptId: "attempt-1", text: "판정: 통과. 지시한 줄이 그 위치에 그대로 있다." }]
  });

  assert.equal(text.startsWith("감사 실행 완료"), true);
});

// 방장 요청 — 감사 보고 하나가 화면 여러 장을 채워 방의 다른 대화가 밀려났다.
// 방에는 앞부분만, 나머지는 현황판에서 읽는다.
test("긴 보고는 앞부분만 방에 나가고 전문 길이를 밝힌다", () => {
  const body = ["판정: 통과", "근거:", "가".repeat(1200)].join("\n");
  const result = buildRoomMessageWithPreview(body, 300);

  assert.equal(result.truncated, true);
  assert.equal(result.text.length < 400, true, `방에 나갈 길이가 너무 길다: ${result.text.length}`);
  assert.match(result.text, /^판정: 통과/, "앞부분은 그대로여야 한다");
  assert.match(result.text, /…\(전문 1,2\d\d자\)/, "얼마를 못 보고 있는지 알려야 버튼을 누를 이유가 생긴다");
});

test("짧은 보고는 그대로 나간다", () => {
  const body = "작업 실행 완료\n결과: 한 줄 고침";
  const result = buildRoomMessageWithPreview(body, 300);

  assert.equal(result.truncated, false);
  assert.equal(result.text, body);
});

test("자를 수 있는 줄 경계가 있으면 거기서 자른다", () => {
  // 표나 코드블록 한가운데서 끊기면 방에 깨진 문서가 남는다. 다만 한 줄이 통째로 길면
  // 경계가 없어 글자 수로 자를 수밖에 없다 — 그건 막을 방법이 없다.
  const line = "이 줄은 예순 자쯤 되는 평범한 보고 문장입니다. 표나 목록의 한 줄이라고 보면 됩니다.";
  const body = Array.from({ length: 10 }, () => line).join("\n");
  const result = previewRoomMessage(body, 300);

  assert.equal(result.truncated, true);
  assert.equal(result.text.endsWith("."), true, `줄 경계에서 안 잘렸다: ${JSON.stringify(result.text.slice(-20))}`);
  assert.equal(result.text.includes("\n"), true, "자리가 되는 만큼은 여러 줄을 보낸다");
});

test("전문 보기 버튼은 보고 id 를 딥링크로 싣는다", () => {
  const keyboard = buildReportOpenKeyboard("11111111-1111-4111-8111-111111111111", "https://t.me/leader_chatroom_bot") as {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
  const url = keyboard.inline_keyboard[0]?.[0]?.url ?? "";

  assert.match(url, /startapp=r_11111111-1111-4111-8111-111111111111$/);
  // 방 id 도 UUID 라 접두어 없이는 구분되지 않는다.
  assert.match(url, /startapp=r_/);
  const startParam = url.split("startapp=")[1] ?? "";
  assert.equal(startParam.length <= 64, true);
});

test("현황판 링크가 없으면 버튼 없이 앞부분만 보낸다", () => {
  assert.equal(buildReportOpenKeyboard("11111111-1111-4111-8111-111111111111", undefined), undefined);
});
