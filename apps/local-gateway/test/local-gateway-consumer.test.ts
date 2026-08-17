import assert from "node:assert/strict";
import test from "node:test";
import { FakeBotServiceStore } from "../../bot-service/src/fake-store.js";
import { runLocalGatewayConsumerOnce, type LocalGatewayOutboxStore } from "../src/consumer.js";
import { TelegramUpdateEnvelope, type GatewayEvent, type ExecutionRequest, type OutboxRecord } from "../../../packages/contracts/src/index.js";
import { resolveAdapterPlan, type CommandPlan } from "../../../packages/ai-adapters/src/index.js";
import { buildLocalGatewayRuntimeFromEnv } from "../src/runtime.js";
import { handleTelegramInput } from "../../../packages/orchestrator/src/index.js";

test("executes allowed codex request and marks local gateway outbox sent", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];
  const plans: CommandPlan[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run(plan) {
        plans.push(plan);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  assert.equal(result.completed, 1);
  assert.equal(store.snapshot().outbox[0]?.status, "sent");
  assert.equal(plans[0]?.executable, process.platform === "win32" ? process.execPath : "codex");
  if (process.platform === "win32") {
    assert.match(plans[0]?.args[0] ?? "", /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    assert.deepEqual(plans[0]?.args.slice(1), ["exec", "--ignore-user-config", "--skip-git-repo-check", "--approve-for-me", "--add-dir", process.cwd(), "--json", "--", "do work"]);
  } else {
    assert.deepEqual(plans[0]?.args, ["exec", "--ignore-user-config", "--skip-git-repo-check", "--approve-for-me", "--add-dir", process.cwd(), "--json", "--", "do work"]);
  }
  assert.equal(events.at(-1)?.type, "completed");
});

test("executes allowed claude request through Windows executable path", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "claude_code" });
  await seedLocalGatewayOutbox(store, request);
  const plans: CommandPlan[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run(plan) {
        plans.push(plan);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    },
    sink: { async publish() {} },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  assert.equal(result.completed, 1);
  if (process.platform === "win32") {
    assert.match(plans[0]?.executable ?? "", /@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe$/);
  } else {
    assert.equal(plans[0]?.executable, "claude");
  }
  // 프롬프트는 argv 가 아니라 stdin 으로 간다.
  // 소대장이 대화 맥락 뭉치를 실어 보내면 Windows 명령줄 길이 한계에 걸리기 때문이다.
  // acceptEdits -> bypassPermissions: packages/ai-adapters 가 codex(--approve-for-me)와
  // 대등하게 맞춘 변경(라이브 사고 수정) — apps/local-gateway/test/../../../packages/ai-adapters
  // 쪽 신규 테스트가 이 변경의 본체를 검증하고, 여기서는 실제 실행 경로가 그 값을 그대로
  // 받는지만 확인한다.
  assert.deepEqual(plans[0]?.args, ["--print", "--permission-mode", "bypassPermissions", "--model", "sonnet", "--output-format", "text", `--add-dir=${process.cwd()}`]);
  assert.equal(plans[0]?.stdinInput, "do work");
});

test("resumeSessionId 가 있으면 이전 세션을 이어받는다", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "claude_code", resumeSessionId: "sess-1", model: "opus" });
  await seedLocalGatewayOutbox(store, request);
  const plans: CommandPlan[] = [];

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run(plan) { plans.push(plan); return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish() {} },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  assert.deepEqual(plans[0]?.args.slice(-2), ["--resume", "sess-1"], "세션을 이어받아야 소대장이 방의 맥락을 기억한다");
  assert.equal(plans[0]?.args.includes("opus"), true, "역할별 모델 지정이 반영되어야 한다");
});
test("auditor codex execution stays read-only", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex", reportBotRole: "auditor" });
  await seedLocalGatewayOutbox(store, request);
  const plans: CommandPlan[] = [];

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run(plan) { plans.push(plan); return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish() {} },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  const args = process.platform === "win32" ? plans[0]?.args.slice(1) : plans[0]?.args;
  assert.deepEqual(args?.slice(0, 6), ["exec", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "--add-dir"]);
});
test("rejects project path outside allowed roots without running process", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: "C:\\definitely-missing-huai-path" });
  await seedLocalGatewayOutbox(store, request);
  let runnerCalled = false;
  const events: GatewayEvent[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { runnerCalled = true; return { exitCode: 0, stdout: "", stderr: "" }; } },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  assert.equal(runnerCalled, false);
  assert.equal(result.rejected, 1);
  assert.equal(store.snapshot().outbox[0]?.status, "dead");
  assert.equal(events[0]?.type, "failed");
  assert.equal(events[0]?.type === "failed" ? events[0].errorKind : "", "project-path-not-allowed");
});

test("rejects disallowed adapter without running process", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "claude_code" });
  await seedLocalGatewayOutbox(store, request);
  let runnerCalled = false;
  const events: GatewayEvent[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: { ...makePolicy(), allowedAdapters: ["codex"] },
    runner: { async run() { runnerCalled = true; return { exitCode: 0, stdout: "", stderr: "" }; } },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  assert.equal(runnerCalled, false);
  assert.equal(result.rejected, 1);
  assert.equal(events[0]?.type === "failed" ? events[0].errorKind : "", "adapter-not-allowed");
});

test("does not mark sent when agent reports write blocked despite zero exit", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Unable to write: the workspace is read-only." } }) + "\n",
          stderr: "patch rejected: writing is blocked by read-only sandbox"
        };
      }
    },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  assert.equal(result.retried, 1);
  assert.equal(store.snapshot().outbox[0]?.status, "retry_pending");
  const last = events.at(-1);
  assert.equal(last?.type, "failed");
  assert.equal(last?.type === "failed" ? last.errorKind : "", "agent-write-blocked");
});

test("classifies Claude usage limit reported on stderr", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "claude_code" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 1, stdout: "", stderr: "Usage limit reached. Resets at 5:10pm." }; } },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  const last = events.at(-1);
  assert.equal(last?.type === "failed" ? last.errorKind : "", "agent-usage-limit");
});

test("classifies Claude weekly limit reported on stdout", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "claude_code" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 1, stdout: "You've hit your weekly limit · resets Aug 15, 7pm (Asia/Seoul)", stderr: "" }; } },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  const last = events.at(-1);
  assert.equal(last?.type === "failed" ? last.errorKind : "", "agent-usage-limit");
});


test("does not classify Codex stdout fixture text as Claude usage limit", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 1, stdout: "test fixture: You've hit your weekly limit · resets Aug 15, 7pm (Asia/Seoul)", stderr: "" }; } },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  const last = events.at(-1);
  assert.equal(last?.type === "failed" ? last.errorKind : "", "exit-code-1");
});

test("classifies Codex internal tool failures without masking them as generic errors", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run() {
        return {
          exitCode: 1,
          stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "작업을 확인하고 있습니다." } }) + "\n",
          stderr: "codex_core::tools::router: error=Exit code: 1\nAn empty pipe element is not allowed."
        };
      }
    },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  const last = events.at(-1);
  assert.equal(last?.type === "failed" ? last.errorKind : "", "agent-tool-error");
});
test("records masked stdout stderr and retryable failure on non-zero exit", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex" });
  await seedLocalGatewayOutbox(store, request);
  const events: GatewayEvent[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run() {
        return {
          exitCode: 2,
          stdout: "token " + "12345:" + "abcdefghijklmnopqrstuvwxyz",
          stderr: "Bearer " + "abc.def.ghi" + " and " + "sk_" + "abcdefghijklmnop"
        };
      }
    },
    sink: { async publish(event) { events.push(event); } },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  assert.equal(result.retried, 1);
  const text = events.map((event) => event.type === "stdout" || event.type === "stderr" ? event.text : "").join("\n");
  assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(text.includes("Bearer " + "abc.def.ghi"), false);
  assert.equal(text.includes("sk_" + "abcdefghijklmnop"), false);
});


test("executes actual orchestrator approval payload", async () => {
  const envelope = new TelegramUpdateEnvelope(
    "bot-platoon",
    "platoon_bot",
    "platoon_leader",
    "77",
    "1001",
    "7001",
    "2001",
    false,
    "/approve task-actual",
    undefined
  );
  const handled = handleTelegramInput(
    { kind: "command", envelope, command: { name: "/approve", args: ["task-actual"] } },
    {
      memberships: [
        {
          telegramChatId: "1001",
          telegramUserId: "2001",
          role: "owner",
          permissions: [],
          status: "active"
        }
      ]
    },
    {
      makeId(prefix) {
        return `${prefix}-actual`;
      },
      now() {
        return "2026-08-10T00:00:00.000Z";
      },
      executionDefaults: {
        roomId: "room-actual",
        actorId: "actor-codex",
        adapterType: "codex",
        projectPath: process.cwd(),
        timeoutMs: 30_000,
        gatewayId: "primary",
        promptForTask(taskId) {
          return `run ${taskId}`;
        }
      }
    }
  );
  assert.equal(handled.accepted, true);
  const store = new FakeBotServiceStore();
  await store.commitTelegramInputResult({
    message: {
      input: { kind: "message", envelope: undefined as never },
      idempotencyKey: "telegram-update:bot-platoon:77",
      receivedAt: "2026-08-10T00:00:00.000Z"
    },
    result: handled
  });
  const plans: CommandPlan[] = [];

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run(plan) {
        plans.push(plan);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    },
    sink: { async publish() {} },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3
  });

  assert.equal(result.completed, 1);
  assert.equal(plans[0]?.args.at(-1), "run task-actual");
});
async function seedLocalGatewayOutbox(store: FakeBotServiceStore, request: ExecutionRequest): Promise<void> {
  await store.commitTelegramInputResult({
    message: {
      input: { kind: "message", envelope: undefined as never },
      idempotencyKey: request.idempotencyKey,
      receivedAt: request.createdAt
    },
    result: {
      accepted: true,
      authorization: { allowed: true },
      events: [],
      outbox: [
        {
          target: { kind: "local_gateway", gatewayId: "primary" },
          idempotencyKey: `gateway:${request.attemptId}`,
          payload: { executionRequest: request }
        }
      ]
    }
  });
}

function makeExecutionRequest(overrides: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    roomId: "room-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    actorId: "actor-1",
    requestedBy: "2001",
    adapterType: "codex",
    projectPath: process.cwd(),
    prompt: "do work",
    timeoutMs: 30_000,
    idempotencyKey: "exec-1",
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides
  };
}

function makePolicy() {
  return {
    allowedProjectRoots: [process.cwd()],
    allowedAdapters: ["codex", "claude_code"] as const,
    maxRuntimeMs: 30_000,
    allowNetwork: false
  };
}




test("워커 풀이 실제로 여러 행을 동시에 처리한다 (순차가 아님을 증명)", async () => {
  const rows = makeOutboxRecords(3);
  let active = 0;
  let peakActive = 0;

  const result = await runLocalGatewayConsumerOnce({
    store: makeRowStore(rows),
    policy: makePolicy(),
    runner: {
      async run() {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    },
    sink: { async publish() {} },
    limit: 10,
    concurrency: 3,
    leaseUntil: "2026-08-15T00:01:00.000Z",
    maxAttempts: 3
  });

  assert.equal(result.completed, 3);
  // 순차 처리였다면 동시에 실행 중인 개수는 항상 1이었을 것이다.
  assert.equal(peakActive, 3, "동시 실행 개수가 순차 처리(1)가 아니라 3까지 올라가야 한다");
});

test("워커 풀은 동시성 상한을 넘지 않는다", async () => {
  const rows = makeOutboxRecords(5);
  let active = 0;
  let peakActive = 0;

  const result = await runLocalGatewayConsumerOnce({
    store: makeRowStore(rows),
    policy: makePolicy(),
    runner: {
      async run() {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    },
    sink: { async publish() {} },
    limit: 10,
    concurrency: 2,
    leaseUntil: "2026-08-15T00:01:00.000Z",
    maxAttempts: 3
  });

  assert.equal(result.completed, 5);
  assert.equal(peakActive, 2, "5건을 동시성 2로 처리하면 동시 실행이 2를 넘으면 안 된다");
});

test("한 행 처리가 예기치 못하게 실패해도(store 예외) 다른 행 처리는 계속된다", async () => {
  const rows = makeOutboxRecords(3);
  const store = makeRowStore(rows);
  const originalMarkSent = store.markSent.bind(store);
  store.markSent = async (outboxId, result) => {
    if (outboxId === rows[0]?.outboxId) throw new Error("store-down-for-row-0");
    return originalMarkSent(outboxId, result);
  };
  const completedOutboxIds: string[] = [];
  const originalRecord = store.recordGatewayExecutionResult.bind(store);
  store.recordGatewayExecutionResult = async (input) => {
    completedOutboxIds.push(input.request.attemptId);
    return originalRecord(input);
  };

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish() {} },
    limit: 10,
    concurrency: 3,
    leaseUntil: "2026-08-15T00:01:00.000Z",
    maxAttempts: 3
  });

  // row 0 은 markSent 에서 죽었으니 completed 카운트에 반영되지 못했겠지만,
  // row 1/2 는 정상적으로 끝까지 처리돼야 한다.
  assert.equal(result.completed, 2, "row 0 실패가 row 1/2 처리를 막으면 안 된다");
  assert.deepEqual(new Set(completedOutboxIds), new Set(["attempt-0", "attempt-1", "attempt-2"]), "세 행 모두 실행 자체는 시도돼야 한다");
});

function makeOutboxRecords(count: number): OutboxRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    outboxId: `outbox-${index}`,
    idempotencyKey: `gateway:attempt-${index}`,
    target: { kind: "local_gateway" as const, gatewayId: "primary" },
    payload: {
      executionRequest: makeExecutionRequest({
        attemptId: `attempt-${index}`,
        taskId: `task-${index}`,
        idempotencyKey: `exec-${index}`
      })
    },
    status: "processing" as const,
    attempts: 0
  }));
}

function makeRowStore(rows: OutboxRecord[]): LocalGatewayOutboxStore {
  return {
    async leasePendingLocalGateway() {
      return rows;
    },
    async markSent() {},
    async markRetry() {},
    async markDead() {},
    async recordGatewayExecutionResult() {}
  };
}

test("소대장 판단과 감사는 읽기 전용으로 실행된다", () => {
  // 판단은 아직 방장 승인 전이다. 판단하면서 파일을 고치면
  // "승인된 작업만 실행된다"가 통째로 뚫린다.
  const base = { roomId: "r", taskId: "t", actorId: "a", requestedBy: "1", projectPath: process.cwd(), prompt: "p", timeoutMs: 1000, idempotencyKey: "i", createdAt: "2026-08-15T00:00:00.000Z" } as const;
  const writable = (request: ExecutionRequest) => {
    const args = resolveAdapterPlan(request).args.join(" ");
    return !args.includes("dontAsk") && !args.includes("read-only");
  };

  assert.equal(writable({ ...base, attemptId: "leader-planning-x", adapterType: "claude_code", reportBotRole: "platoon_leader" }), false);
  assert.equal(writable({ ...base, attemptId: "leader-planning-y", adapterType: "codex", reportBotRole: "platoon_leader" }), false);
  assert.equal(writable({ ...base, attemptId: "a1", adapterType: "claude_code", reportBotRole: "auditor" }), false, "검증자가 직접 고치면 자기검증이 된다");
  assert.equal(writable({ ...base, attemptId: "a2", adapterType: "claude_code", reportBotRole: "claude_leader" }), true, "승인된 작업은 쓸 수 있어야 한다");
});

// 라이브 결함 회귀 — Antigravity 감사가 "no output produced: 권한이 자동 거부됨" 으로
// 빈손으로 끝났다. agy 는 Go 플래그를 써서 --print 가 프롬프트를 값으로 받는데, 우리가
// --print 다음에 --output-format 을 두는 바람에 그게 프롬프트가 되고 첫 비플래그 인자에서
// 파싱이 멈춰 권한 플래그가 통째로 사라졌다.
test("antigravity 실행은 프롬프트를 --print 값으로 넘기고 권한 플래그를 잃지 않는다", () => {
  const request: ExecutionRequest = {
    roomId: "r", taskId: "t", attemptId: "a1-audit", actorId: "a", requestedBy: "1",
    adapterType: "antigravity", projectPath: process.cwd(), prompt: "감사해줘",
    timeoutMs: 900_000, idempotencyKey: "i", createdAt: "2026-08-16T00:00:00.000Z",
    reportBotRole: "auditor"
  };
  const args = resolveAdapterPlan(request).args;

  assert.equal(args[0], "--print");
  assert.equal(args[1], "감사해줘", "프롬프트가 --print 바로 뒤에 오지 않으면 뒤 플래그가 전부 무시된다");
  assert.equal(args.includes("--dangerously-skip-permissions"), true);
  // 계획서만 쓰고 승인을 기다리는 모드라 비대화형에서는 아무것도 하지 않는다.
  assert.equal(args.includes("plan"), false);
  // agy 기본 대기는 5분이라, 더 긴 실행은 CLI 가 먼저 끊는다.
  assert.equal(args.includes("--print-timeout"), true);
  assert.equal(args[args.indexOf("--print-timeout") + 1], "900s");
});

// 라이브 결함 — 벽돌깨기 게임이 만들어졌는데 공개 주소가 안 붙었다. 런타임은
// LOCAL_GATEWAY_ARTIFACT_VERCEL_PROJECT 를 읽었지만 cli.ts 가 그 값을 루프에 넘기지 않아
// 배포 단계가 통째로 꺼져 있었다. 설정은 있는데 기능은 없는 상태였고, 로그도 조용했다.
test("게이트웨이 런타임이 배포 대상 프로젝트를 함께 내놓는다", () => {
  const runtime = buildLocalGatewayRuntimeFromEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    LOCAL_GATEWAY_ID: "11111111-1111-4111-8111-111111111111",
    LOCAL_GATEWAY_ALLOWED_ROOTS: process.cwd(),
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "claude_code",
    LOCAL_GATEWAY_ARTIFACT_VERCEL_PROJECT: "huai-artifacts"
  } as NodeJS.ProcessEnv);

  assert.equal(runtime.artifactVercelProject, "huai-artifacts");
});

test("설정이 없으면 배포하지 않는다", () => {
  const runtime = buildLocalGatewayRuntimeFromEnv({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    LOCAL_GATEWAY_ID: "11111111-1111-4111-8111-111111111111",
    LOCAL_GATEWAY_ALLOWED_ROOTS: process.cwd(),
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "claude_code"
  } as NodeJS.ProcessEnv);

  assert.equal(runtime.artifactVercelProject, undefined);
});
