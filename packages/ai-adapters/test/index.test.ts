import assert from "node:assert/strict";
import test from "node:test";
import { resolveAdapterPlan } from "../src/index.js";
import { type ExecutionRequest } from "../../contracts/src/index.js";

// codex_leader/leader 는 기본 어댑터가 codex 다. `codex exec resume <id>`
// 서브커맨드가 실제로 있다는 것을 codex exec resume --help 로 실측 확인했고, 그 옵션
// 목록에는 --sandbox·--approve-for-me·--add-dir 가 없다 — 세션을 처음 열 때 이미
// readOnly 여부에 맞는 승인 모드로 만들어졌으므로, 이어받을 때는 그 모드를 다시
// 지정할 필요가 없다는 전제로 짰다.

function baseRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    roomId: "room-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    actorId: "actor-1",
    requestedBy: "user-1",
    adapterType: "codex",
    projectPath: "C:\\repo",
    prompt: "작업을 진행해줘",
    timeoutMs: 60_000,
    idempotencyKey: "idem-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides
  };
}

// Windows 에서는 platformPlan 이 codex.js 를 node 로 직접 실행하려고 args 맨 앞에
// entrypoint 경로를 끼워 넣는다(codex.exe 가 아니라 .js 라서) — 실제 codex 서브커맨드
// 인자만 비교하려면 그 한 칸을 건너뛴다.
function codexSubcommandArgs(args: readonly string[]): readonly string[] {
  return args[0]?.endsWith(".js") ? args.slice(1) : args;
}

test("codex, 이전 세션이 없으면 지금까지와 똑같이 새 세션으로 연다 (회귀)", () => {
  const plan = resolveAdapterPlan(baseRequest());
  assert.deepEqual(codexSubcommandArgs(plan.args), [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--approve-for-me",
    "--add-dir",
    "C:\\repo",
    "--json",
    "--",
    "작업을 진행해줘"
  ]);
});

test("codex, resumeSessionId 가 있으면 exec resume <id> 로 이어받는다", () => {
  const plan = resolveAdapterPlan(baseRequest({ resumeSessionId: "01a017c9-95b5-7e93-af21-bb5a94e007c4" }));
  assert.deepEqual(codexSubcommandArgs(plan.args), [
    "exec",
    "resume",
    "01a017c9-95b5-7e93-af21-bb5a94e007c4",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--json",
    "--",
    "작업을 진행해줘"
  ]);
});

test("codex resume 경로는 --sandbox·--approve-for-me·--add-dir 를 안 붙인다 (그 서브커맨드엔 없는 옵션)", () => {
  const plan = resolveAdapterPlan(baseRequest({ resumeSessionId: "01a017c9-95b5-7e93-af21-bb5a94e007c4" }));
  for (const forbidden of ["--sandbox", "--approve-for-me", "--add-dir"]) {
    assert.equal(plan.args.includes(forbidden), false, `${forbidden} 는 codex exec resume 에 없는 옵션이다`);
  }
});

test("codex 읽기전용(리더 판단) 세션도 resumeSessionId 가 있으면 resume 경로를 탄다", () => {
  const plan = resolveAdapterPlan(
    baseRequest({ attemptId: "leader-planning-p1", resumeSessionId: "9c1b1e2a-1111-2222-3333-444455556666" })
  );
  assert.deepEqual(codexSubcommandArgs(plan.args).slice(0, 3), ["exec", "resume", "9c1b1e2a-1111-2222-3333-444455556666"]);
});

test("claude_code 는 여전히 --resume 플래그를 쓴다 (회귀 — codex 분기 추가가 claude 쪽을 안 건드려야 한다)", () => {
  const plan = resolveAdapterPlan(
    baseRequest({ adapterType: "claude_code", resumeSessionId: "sess-abc", model: "sonnet" })
  );
  assert.ok(plan.args.includes("--resume"));
  assert.ok(plan.args.includes("sess-abc"));
});

// text 모드였을 때는 session_id 가 stdout 어디에도 안 실려서 --resume 이 애초에 못
// 걸렸다(실측 확인). json 으로 바꿔야 session_id 를 잡을 수 있다.
test("claude_code 는 --output-format json 을 쓴다 (session_id 캡처를 위한 전환)", () => {
  const plan = resolveAdapterPlan(baseRequest({ adapterType: "claude_code" }));
  const formatIndex = plan.args.indexOf("--output-format");
  assert.ok(formatIndex >= 0);
  assert.equal(plan.args[formatIndex + 1], "json");
});
