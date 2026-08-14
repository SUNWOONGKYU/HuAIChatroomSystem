import assert from "node:assert/strict";
import test from "node:test";
import { FakeBotServiceStore } from "../../bot-service/src/fake-store.js";
import { runLocalGatewayConsumerOnce } from "../src/consumer.js";
import { TelegramUpdateEnvelope, type GatewayEvent, type ExecutionRequest } from "../../../packages/contracts/src/index.js";
import { type CommandPlan } from "../../../packages/ai-adapters/src/index.js";
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
  assert.deepEqual(plans[0]?.args, ["--print", "--permission-mode", "acceptEdits", "--model", "sonnet", "--output-format", "text", `--add-dir=${process.cwd()}`, "do work"]);
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



