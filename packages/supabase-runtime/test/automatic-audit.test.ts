import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore, buildSingleWorkerAuditPrompt, producedRealArtifacts, realArtifactPaths } from "../src/index.js";
import { type GatewayEvent } from "../../contracts/src/index.js";

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
  assert.equal(producedRealArtifacts([artifact("C:\\Dev\\HuAIChatroomSystem\\sessions\\raw\\x.jsonl")]), false);
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
// 현황판 "대기" 칸만 불렸다. 감사할 대상이 없다는 것이 작업을 방치할 이유는 아니다.
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
  assert.match(String(review.body.payload.text), /작업 현황판/, "어디서 결정하는지 알려줘야 한다");
  assert.equal(review.body.payload.keyboard, undefined, "결정은 현황판에서 한다");
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
