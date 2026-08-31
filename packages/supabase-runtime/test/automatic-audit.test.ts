import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore, auditProducedNoVerdict, fallbackHopCount, nextEngineAfterTried, reportBotRoleForAdapter, buildSingleWorkerAuditPrompt, buildMultiAiAuditPrompt, engineActorName, gatewayFailureEvidence, nextEngineAfter, producedRealArtifacts, realArtifactPaths, shouldFallbackToOtherEngine } from "../src/index.js";
import { AI_ADAPTER_TYPES, type GatewayEvent } from "../../contracts/src/index.js";

// 자동 검증 기준: 이 실행이 실제로 무언가를 만들거나 고쳤는가.
//
// 예전 기준은 프롬프트·결과 문자열의 단어표(검증·감사·구현 완료·supabase·migration …)
// 였다. 요청자가 고른 단어로 감사 여부가 갈리는 건 근거가 없었고, 실제로 단일 작업자
// 자동감사는 라이브에서 한 번도 실행되지 않았다(감사 실행 9건은 전부 다중 AI 경로).

test("파일을 바꾼 작업은 감사 대상이다", () => {
  assert.equal(producedRealArtifacts([artifact("packages/orchestrator/src/index.ts")]), true);
});

test("아무것도 안 바꾼 질의응답은 감사 대상이 아니다", () => {
  // "줄 수 알려줘" 류. 독립 감사를 붙일 대상이 없는데 돌리면 AI 실행 한 번이 그냥 낭비다.
  assert.equal(producedRealArtifacts([]), false);
  assert.equal(producedRealArtifacts([{ type: "stdout", taskId: "t", attemptId: "a", text: "86줄입니다." }]), false);
});

test("세션 기록 파일은 작업 산출물로 세지 않는다", () => {
  // Claude Code 훅이 자기 세션을 남기며 만드는 부산물이다. 라이브에서 README 줄 수를
  // 세는 작업에도 3건이 붙었다 — 이걸 세면 모든 질의응답이 감사 대상이 된다.
  const events = [
    artifact("sessions/.wiki-distill.log"),
    artifact("sessions/wiki/INDEX.md"),
    artifact("sessions/summary/2026_08_16__09.48_요약.md")
  ];

  assert.equal(producedRealArtifacts(events), false);
  assert.deepEqual(realArtifactPaths(events), []);
});

test("세션 기록에 실제 산출물이 섞여 있으면 감사한다", () => {
  const events = [artifact("sessions/wiki/INDEX.md"), artifact("packages/workflow/src/index.ts")];

  assert.equal(producedRealArtifacts(events), true);
  assert.deepEqual(realArtifactPaths(events), ["packages/workflow/src/index.ts"]);
});

test("역슬래시 경로에서도 세션 기록을 알아본다", () => {
  // 게이트웨이가 Windows 경로를 그대로 실어 보낸다.
  assert.equal(producedRealArtifacts([artifact("C:\\repo\\sessions\\raw\\x.jsonl")]), false);
});

test("이름에 sessions 가 들어간 실제 소스는 살린다", () => {
  // 경로 구분자로 둘러싸인 sessions 만 기록용으로 본다. 부분 문자열로 잡으면
  // session-store.ts 같은 진짜 소스가 감사에서 빠진다.
  assert.equal(producedRealArtifacts([artifact("apps/bot-service/src/session-store.ts")]), true);
  assert.equal(producedRealArtifacts([artifact("packages/sessions-view/src/index.ts")]), true);
});

test("감사 프롬프트에 작업자 보고와 바뀐 파일이 담긴다", () => {
  const prompt = buildSingleWorkerAuditPrompt(
    "task-1",
    "ClaudeBot",
    "옵션 파싱을 고쳤습니다.",
    ["packages/orchestrator/src/index.ts"]
  );

  assert.match(prompt, /대상 작업: task-1/);
  assert.match(prompt, /작업자: ClaudeBot/);
  assert.match(prompt, /옵션 파싱을 고쳤습니다/);
  assert.match(prompt, /- packages\/orchestrator\/src\/index\.ts/);
  // 감사 결과가 방으로 나가므로 내부 출력 금지는 프롬프트에 남아 있어야 한다.
  assert.match(prompt, /금지/);
});

// 라이브 결함 회귀(task d364326a, 2026-08-24) — 다중 AI 감사 프롬프트가 Codex 파서만
// 써서, Claude Code 의 stdout(--output-format json)을 원본 JSON 그대로 실었다. 감사가
// 그 JSON 덩어리를 보고 "ClaudeBot 결과가 없다"고 오판정했다 — 실제로는 완료했는데도.
test("다중 AI 감사 프롬프트는 Claude 의 JSON stdout 에서도 사람이 읽는 결과를 뽑는다", () => {
  const claudeStdoutJson = JSON.stringify({
    type: "result",
    result: "test-note.txt 생성 확인. 내용 한 줄, 열람 검증 완료.",
    session_id: "abc"
  });
  const claudePayload = {
    events: [
      { type: "accepted" },
      { type: "started" },
      { type: "stdout", text: claudeStdoutJson },
      { type: "completed" }
    ]
  };
  const codexPayload = {
    events: [{ type: "stdout", text: "파일 생성 완료했습니다." }]
  };

  const prompt = buildMultiAiAuditPrompt("task-d364326a", claudePayload, codexPayload);

  assert.match(prompt, /test-note\.txt 생성 확인/, "Claude 의 실제 결과 문장이 프롬프트에 있어야 한다");
  assert.doesNotMatch(prompt, /"type":\s*"result"/, "원본 JSON 이 그대로 새면 안 된다");
});

test("작업자 보고가 비어도 프롬프트가 빈칸으로 나가지 않는다", () => {
  const prompt = buildSingleWorkerAuditPrompt("task-1", "CodexBot", "", []);

  assert.match(prompt, /\(보고 없음\)/);
  assert.match(prompt, /\(없음\)/);
});

function artifact(path: string): GatewayEvent {
  return {
    type: "artifact_collected",
    taskId: "task-1",
    artifact: { path, uri: path.startsWith("C:") ? path : `file:///C:/Dev/HuAIChatroomSystem/${path}`, version: "attempt-1" }
  } as GatewayEvent;
}

// 라이브 결함 회귀 — 감사가 안 붙는 작업이 검증 대기에서 멎던 문제.
//
// 파일을 바꾸지 않은 실행은 감사를 붙이지 않기로 했는데, 그러자 그 작업이
// verification_pending 에서 깨울 사람 없이 영영 멈췄다. 조회 작업 5건이 그렇게 묶여
// 협업 운영센터 "대기" 칸만 불렸다. 감사할 대상이 없다는 것이 작업을 방치할 이유는 아니다.
test("감사가 안 붙는 실행도 완료 승인 대기까지는 간다", async () => {
  const calls = makeStoreCalls();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: readOnlyRequest(),
    status: "completed",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-readonly", text: "86줄입니다." }],
    occurredAt: "2026-08-16T00:00:00.000Z"
  });

  const patched = calls.requests
    .filter((r) => r.method === "PATCH" && /huai_tasks/.test(r.url))
    .map((r) => r.body.status);
  assert.equal(patched.length > 0, true, "상태가 한 번도 안 움직였다 — 검증 대기에 묶인다");

  const review = calls.requests.find((r) => String(r.body?.idempotency_key ?? "").startsWith("telegram-completion-review:"));
  assert.ok(review, "방장이 완료를 결정할 창구가 안 열렸다");
  assert.match(String(review.body.payload.text), /협업 운영센터/, "어디서 결정하는지 알려줘야 한다");
  assert.equal(review.body.payload.keyboard, undefined, "결정은 협업 운영센터에서 한다");
});

test("감사가 붙는 실행은 감사에 맡기고 먼저 닫지 않는다", async () => {
  // 파일을 바꾼 실행까지 여기서 통과시키면 독립 검증이 통째로 건너뛰어진다.
  //
  // 자동 감사는 HUAI_AUTO_AUDIT_ENABLED 로 켠다. 꺼져 있으면 파일을 바꾼 작업도
  // 감사 없이 닫히는 게 맞다 — 아무도 안 깨우면 검증 대기에 묶이기 때문이다.
  // 이 테스트가 지키려는 것은 "켜져 있을 때 감사를 건너뛰지 않는다"이므로 켜고 잰다.
  const previous = process.env.HUAI_AUTO_AUDIT_ENABLED;
  process.env.HUAI_AUTO_AUDIT_ENABLED = "true";
  test.after(() => {
    if (previous === undefined) delete process.env.HUAI_AUTO_AUDIT_ENABLED;
    else process.env.HUAI_AUTO_AUDIT_ENABLED = previous;
  });

  const calls = makeStoreCalls();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: readOnlyRequest(),
    status: "completed",
    events: [
      { type: "stdout", taskId: TASK_ID, attemptId: "attempt-readonly", text: "고쳤습니다." },
      artifact("packages/workflow/src/index.ts")
    ],
    occurredAt: "2026-08-16T00:00:00.000Z"
  });

  const review = calls.requests.find((r) => String(r.body?.idempotency_key ?? "").startsWith("telegram-completion-review:"));
  assert.equal(review, undefined, "감사 전에 완료 결정 창구가 열렸다");
});

const TASK_ID = "88888888-8888-4888-8888-888888888888";

function readOnlyRequest() {
  return {
    roomId: "99999999-9999-4999-8999-999999999999",
    taskId: TASK_ID,
    attemptId: "attempt-readonly",
    actorId: "77777777-7777-4777-8777-777777777777",
    requestedBy: "5001",
    adapterType: "claude_code" as const,
    projectPath: "C:/work",
    prompt: "줄 수 알려줘",
    timeoutMs: 30_000,
    idempotencyKey: "exec-readonly",
    createdAt: "2026-08-16T00:00:00.000Z",
    reportBotRole: "claude_leader" as const
  };
}

function makeStoreCalls() {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.split("/rest/v1")[1] ?? url;
    if (path.includes("huai_rooms")) return json(200, [{ telegram_chat_id: "1001" }]);
    if (path.includes("huai_tasks") && method === "GET") return json(200, [{ status: "in_progress" }]);
    // 폴백이 담당을 바꿀 때 찾는 행. 방마다 역할별 actor 가 하나씩 있다.
    if (path.includes("huai_ai_actors")) return json(200, [{ actor_id: "11111111-1111-4111-8111-111111111111" }]);
    if (path.includes("huai_gateway_instances")) return json(200, [{ gateway_id: "22222222-2222-4222-8222-222222222222", status: "online" }]);
    if (path.includes("huai_events") && method === "POST") {
      return json(201, [{ event_id: "event-1", room_id: "r", task_id: TASK_ID, event_type: "x", idempotency_key: "k", payload: {}, created_at: "2026-08-16T00:00:00.000Z" }]);
    }
    return json(200, []);
  };
  return { fetchImpl, requests };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// 라이브 결함 회귀 — 한 엔진이 한도에 걸리면 작업이 그대로 멈추던 문제.
//
// 감사가 Codex 한도로 죽었고, 방장이 손으로 다시 시키기 전까지 아무 일도 안 일어났다.
// 한도는 우리가 고칠 수 없지만 다른 엔진은 멀쩡하다.
test("한도에 걸리면 다른 엔진으로 넘긴다", () => {
  const request = { ...auditRequest(), adapterType: "codex" as const };

  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", "You've hit your usage limit. Visit https://chatgpt.com/codex/settings"), true);
  assert.equal(shouldFallbackToOtherEngine(request, "agent-usage-limit", ""), true);
});

// 라이브 결함 회귀 — 한도 초과가 폴백되지 않고 실패로 끝났다(2026-08-16 12:36 감사).
//
// 방에 나간 문구는 "CodexBot 현재 상태: 사용 한도 초과"였는데도 폴백이 안 걸렸다. 보고문은
// 원본 출력을 보고, 폴백 판정만 정제본을 봤기 때문이다. 아래 문자열은 그때 게이트웨이가
// 실제로 받은 stdout 이다 — 한도 통보가 JSON 줄 안에 있고, 정제본은 그 줄을 버린다.
test("한도 통보가 JSON 줄 안에 있어도 폴백한다", () => {
  const codexQuotaStdout = [
    '{"type":"thread.started","thread_id":"01a00a92-aa34-7013-a128-2418f6579470"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 12:40 PM."}',
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}'
  ].join("\n");
  const events: GatewayEvent[] = [
    { type: "stdout", taskId: TASK_ID, attemptId: "attempt-1", text: codexQuotaStdout },
    { type: "stderr", taskId: TASK_ID, attemptId: "attempt-1", text: "Reading additional input from stdin...\n" }
  ];
  const request = { ...auditRequest(), adapterType: "codex" as const };

  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", gatewayFailureEvidence(events)), true);
});

test("한도가 아닌 실패는 넘기지 않는다", () => {
  // 진짜 오류를 다른 엔진으로 넘기면 같은 실패를 두 번 하고 방만 시끄럽다.
  const request = { ...auditRequest(), adapterType: "codex" as const };

  assert.equal(shouldFallbackToOtherEngine(request, "process-timeout", ""), false);
  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", "설정 파일을 읽지 못했습니다."), false);
});

test("한 바퀴 더 돈 것마저 막히면 더 넘기지 않는다", () => {
  // 상한이 필요한 이유는 그대로다 — 전부 막힌 상태에서 계속 넘기면 방만 시끄럽고 아무것도
  // 안 된다. 상한은 3회다(엔진 셋이 각자 한 번씩 + 처음 엔진으로 한 바퀴 더).
  const exhausted = { ...auditRequest(), attemptId: "attempt-1-fallback-fallback-fallback" };

  assert.equal(shouldFallbackToOtherEngine(exhausted, "agent-usage-limit", ""), false);
});

// 엔진이 둘뿐이던 때의 결함 — 감사하던 Codex 가 한도에 걸리면 남는 건 작업자 Claude 뿐이라,
// 자기 일을 자기가 검사하게 됐다. 세 번째 엔진은 그 자리를 메우려고 붙였다.
test("감사가 막히면 작업자 엔진을 피해 세 번째 엔진에 넘긴다", () => {
  assert.equal(nextEngineAfter("codex", "claude_code"), "gemini_web");
  assert.equal(nextEngineAfter("antigravity", "claude_code"), "codex");
  assert.equal(nextEngineAfter("claude_code", "codex"), "gemini_web");
});

test("작업자를 모르면 남은 엔진 중 앞엣것으로 넘긴다", () => {
  // 감사가 아닌 보통 실행이다. 피해야 할 엔진이 없다.
  assert.equal(nextEngineAfter("codex"), "claude_code");
  assert.equal(nextEngineAfter("claude_code"), "codex");
});

test("엔진이 셋인 동안은 어떤 조합에서도 작업자에게 되돌아가지 않는다", () => {
  // 하나가 막히고 하나가 작업자면 항상 하나가 남는다. 이게 세 번째 엔진을 붙인 이유다.
  // 엔진을 다시 둘로 줄이면 이 성질이 깨지므로 여기서 잡는다.
  for (const blocked of AI_ADAPTER_TYPES) {
    for (const worker of AI_ADAPTER_TYPES) {
      const picked = nextEngineAfter(blocked, worker);
      assert.notEqual(picked, blocked, `${blocked} 가 막혔는데 다시 골랐다`);
      if (blocked !== worker) assert.notEqual(picked, worker, `${worker} 가 자기 일을 검사하게 됐다`);
    }
  }
});

test("감사 요청은 누가 작업했는지를 달고 나간다", () => {
  // 이 값이 없으면 감사가 한 번 더 넘어갈 때 작업자 엔진으로 되돌아갈 수 있다.
  const request = { ...auditRequest(), adapterType: "claude_code" as const, workerAdapterType: "claude_code" as const };

  assert.equal(nextEngineAfter("codex", request.workerAdapterType), "gemini_web");
});

test("방에 올리는 이름은 엔진마다 다르다", () => {
  assert.equal(engineActorName("claude_code"), "ClaudeBot");
  assert.equal(engineActorName("codex"), "CodexBot");
  assert.equal(engineActorName("antigravity"), "GeminiWeb");
});

test("리더 판단은 엔진을 바꾸지 않는다", () => {
  // 방장 지시를 해석하는 단계다. 엔진을 바꾸면 해석이 달라지므로, 실패를 그대로 알려
  // 방장이 다시 말하게 한다.
  const planning = { ...auditRequest(), attemptId: "leader-planning-abc" };

  assert.equal(shouldFallbackToOtherEngine(planning, "agent-usage-limit", ""), false);
});

function auditRequest() {
  return {
    roomId: "99999999-9999-4999-8999-999999999999",
    taskId: TASK_ID,
    attemptId: "attempt-1",
    actorId: "77777777-7777-4777-8777-777777777777",
    requestedBy: "5001",
    adapterType: "codex" as const,
    projectPath: "C:/work",
    prompt: "감사해줘",
    timeoutMs: 30_000,
    idempotencyKey: "exec-audit",
    createdAt: "2026-08-16T00:00:00.000Z",
    reportBotRole: "auditor" as const
  };
}

// 라이브 결함 회귀 — Antigravity 감사가 권한 때문에 도구를 하나도 못 쓰고 종료코드 0 으로
// 끝났는데, 그 안내문이 감사 의견으로 기록돼 방에 "보완이 필요합니다"가 걸렸다.
// 작업자는 고칠 것도 없는 수정 요구를 받았다.
test("도구가 막혀 아무것도 못 본 감사는 판정으로 치지 않는다", () => {
  const jetskiNoOutput = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';

  assert.equal(auditProducedNoVerdict(jetskiNoOutput), true);
  assert.equal(auditProducedNoVerdict(""), true);
  assert.equal(auditProducedNoVerdict("   \n  "), true);
});

test("실제 판정이 담긴 감사는 그대로 받는다", () => {
  assert.equal(auditProducedNoVerdict("판정: 통과. 지시한 줄이 그 위치에 그대로 있고 다른 줄은 그대로다."), false);
  assert.equal(auditProducedNoVerdict("판정: 불합격. README.md 89행이 지시와 다르다."), false);
});

// 라이브 결함 회귀 — Codex 한도 초과로 ClaudeBot 이 이어받아 작업했는데, 완료 보고는
// CodexBot 이름으로 방에 떴다. 폴백이 실행 엔진만 바꾸고 보고자는 원래 값을 물려받았다.
// 방장이 "이런 엉터리가 어디 있냐"고 지적한 화면이다.
test("작업이 넘어가면 보고하는 봇도 같이 바뀐다", () => {
  assert.equal(reportBotRoleForAdapter("claude_code"), "claude_leader");
  assert.equal(reportBotRoleForAdapter("codex"), "codex_leader");
  // antigravity 는 자기 봇이 없다. 방에 나가는 문구가 AntigravityBot 이라고 밝히므로
  // 발신 봇만 빌려 쓴다.
  assert.equal(reportBotRoleForAdapter("antigravity"), "claude_leader");
});

// 라이브 결함 회귀 — 폴백이 실행 엔진만 바꾸고 작업 행의 담당은 그대로 둬서, 협업 운영센터에
// ClaudeBot 이 한 작업이 "담당: codex_leader (codex)" 로 남아 있었다. 방에 나가는 문구만
// 고치면 나중에 협업 운영센터를 열었을 때 같은 거짓말을 다시 본다.
test("엔진이 넘어가면 작업 담당도 그 엔진으로 바뀐다", async () => {
  const calls = makeStoreCalls();
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...readOnlyRequest(), adapterType: "codex" as const, reportBotRole: "codex_leader" as const },
    status: "failed",
    errorKind: "exit-code-1",
    events: [{ type: "stdout", taskId: TASK_ID, attemptId: "attempt-readonly", text: '{"type":"error","message":"You\'ve hit your usage limit."}' }],
    occurredAt: "2026-08-17T00:00:00.000Z"
  });

  const reassign = calls.requests.find((r) => r.method === "PATCH" && /huai_tasks/.test(r.url) && r.body?.assignee_actor_id !== undefined);
  assert.ok(reassign, "담당을 바꾸지 않으면 협업 운영센터가 계속 옛 엔진을 가리킨다");
});

// 방장 요청(Fable 5 제안 채택) — 같은 지적이 방마다 되풀이되는데, 감사자는 매번 처음처럼
// 찾는다. 방 기억(sessions/rooms/<방>/<날짜>_위키.md)의 "반복 지적"을 미리 알려준다.
test("반복 지적이 있으면 감사 프롬프트에 실린다", () => {
  const prompt = buildSingleWorkerAuditPrompt("task-1", "ClaudeBot", "고쳤습니다", ["README.md"], [
    "산출물 수집 여부를 확인하지 않는다",
    "완료 조건을 인용하지 않고 통과시킨다"
  ]);

  assert.match(prompt, /되풀이된 지적/);
  assert.match(prompt, /- 산출물 수집 여부를 확인하지 않는다/);
  assert.match(prompt, /- 완료 조건을 인용하지 않고 통과시킨다/);
});

test("반복 지적이 없으면 그 자리를 만들지 않는다", () => {
  // 빈 목록을 넣으면 감사자가 "지적할 것을 찾아야 한다"고 읽는다.
  const prompt = buildSingleWorkerAuditPrompt("task-1", "ClaudeBot", "고쳤습니다", ["README.md"]);

  assert.equal(prompt.includes("되풀이된 지적"), false);
});

// 라이브 결함 회귀 — Antigravity 가 감사한 건인데 보완 요청이 CodexBot 이름으로 나갔다.
// 그 자리는 "claude_code 가 아니면 코덱스"로 봇을 골랐고, 세 번째 엔진은 고려에 없었다.
test("보완 요청은 실제로 작업한 엔진의 봇이 받는다", () => {
  // 감사 요청에는 작업자 엔진이 각인돼 있다(workerAdapterType).
  assert.equal(reportBotRoleForAdapter("claude_code"), "claude_leader");
  assert.equal(reportBotRoleForAdapter("codex"), "codex_leader");
  // Antigravity 가 감사했다고 해서 CodexBot 이 보완 요청을 받을 이유는 없다.
  assert.equal(reportBotRoleForAdapter("antigravity"), "claude_leader");
});

// 세 번째 엔진도 자기 한도에 걸린다. 안 알아보면 "실행 중 오류"로 끝나고 폴백이 안 걸려,
// 남은 두 엔진이 멀쩡한데 작업이 거기서 멈춘다.
test("Antigravity 한도도 다른 엔진으로 넘긴다", () => {
  const request = { ...auditRequest(), adapterType: "antigravity" as const };

  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", "Error: resource-exhausted"), true);
  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", "429 Too Many Requests"), true);
  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", "quota exceeded for this project"), true);
  // 진짜 오류는 넘기지 않는다 — 같은 실패를 두 번 하고 방만 시끄럽다.
  assert.equal(shouldFallbackToOtherEngine(request, "exit-code-1", "설정 파일을 읽지 못했습니다."), false);
});

// 라이브 결함 — Claude 가 막히고 Codex 도 막히자 Antigravity 가 멀쩡한데 작업이 끝났다.
// 폴백이 한 번뿐이라 세 번째 엔진에 닿지 못했다(그래서 2로 올렸고, 이후 PO 요청으로
// 세 엔진을 한 바퀴 다 돈 뒤에도 한 번 더 처음 엔진으로 도는 3으로 다시 올렸다).
test("엔진이 셋이면 한 바퀴 돌고 한 번 더 넘긴다(최대 세 번)", () => {
  assert.equal(fallbackHopCount("attempt_1"), 0);
  assert.equal(fallbackHopCount("attempt_1-fallback"), 1);
  assert.equal(fallbackHopCount("attempt_1-fallback-fallback"), 2);
  assert.equal(fallbackHopCount("attempt_1-fallback-fallback-fallback"), 3);

  const first = { ...auditRequest(), attemptId: "attempt_1", adapterType: "claude_code" as const };
  const second = { ...auditRequest(), attemptId: "attempt_1-fallback", adapterType: "codex" as const };
  const third = { ...auditRequest(), attemptId: "attempt_1-fallback-fallback", adapterType: "antigravity" as const };
  const fourth = { ...auditRequest(), attemptId: "attempt_1-fallback-fallback-fallback", adapterType: "claude_code" as const };

  assert.equal(shouldFallbackToOtherEngine(first, "agent-usage-limit", ""), true);
  assert.equal(shouldFallbackToOtherEngine(second, "agent-usage-limit", ""), true, "두 번째 엔진이 막히면 세 번째로 가야 한다");
  assert.equal(shouldFallbackToOtherEngine(third, "agent-usage-limit", ""), true, "세 번째까지 막히면 처음 엔진으로 한 바퀴 더 돈다");
  // 한 바퀴 더 돈 것마저 막혔다. 계속 넘기면 방만 시끄럽고 아무것도 안 된다.
  assert.equal(shouldFallbackToOtherEngine(fourth, "agent-usage-limit", ""), false);
});

test("이미 써 본 엔진은 다시 고르지 않는다 — 단, 셋 다 써 봤으면 처음부터 한 바퀴 더", () => {
  assert.equal(nextEngineAfterTried(["claude_code"]), "codex");
  assert.equal(nextEngineAfterTried(["claude_code", "codex"]), "gemini_web");
  // 감사라면 작업자 엔진은 뒤로 미룬다 — 자기 일을 자기가 검사하는 것을 마지막 수단으로.
  assert.equal(nextEngineAfterTried(["codex"], "claude_code"), "gemini_web");
  // 남은 것이 작업자 엔진뿐이면 그거라도 쓴다. 아무도 안 보는 것보다 낫다.
  assert.equal(nextEngineAfterTried(["codex", "gemini_web"], "claude_code"), "claude_code");
  // 전부 써 봤으면(한 바퀴 다 돌았으면) 처음 엔진부터 다시 돈다 — 무한은 아니고
  // MAX_FALLBACK_HOPS 가 그다음 한 번으로 막는다.
  assert.equal(nextEngineAfterTried(["claude_code", "codex", "gemini_web"]), "claude_code");
});

// 라이브 확인(2026-08-23): ASSIGNEE=codex_leader 작업이 코덱스 한도로 막혔을 때
// 클로드로 넘어갔다 — PO 는 "코덱스가 막히면 안티그래비티로"를 기대했는데, 고정
// 배열 순서(claude_code 가 항상 먼저) 때문에 어긋났다. 막힌 엔진의 바로 다음 자리부터
// 순환하도록 고쳐 이 기대와 맞춘다.
test("워커 엔진이 코덱스로 막히면(감사 아님) Gemini 웹이 클로드보다 먼저다", () => {
  assert.equal(nextEngineAfterTried(["codex"]), "gemini_web");
  // Gemini 웹까지 막히면 그제서야 클로드.
  assert.equal(nextEngineAfterTried(["codex", "gemini_web"]), "claude_code");
});

test("워커 엔진이 클로드로 막히면 코덱스가 다음이다 (원래 배열 순서와 동일)", () => {
  assert.equal(nextEngineAfterTried(["claude_code"]), "codex");
});

test("워커 엔진이 안티그래비티로 막히면 클로드가 다음이다", () => {
  assert.equal(nextEngineAfterTried(["antigravity"]), "claude_code");
});
