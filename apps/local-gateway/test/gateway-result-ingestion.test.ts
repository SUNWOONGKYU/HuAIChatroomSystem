import assert from "node:assert/strict";
import test from "node:test";
import { FakeBotServiceStore } from "../../bot-service/src/fake-store.js";
import { runLocalGatewayConsumerOnce } from "../src/consumer.js";
import { type ExecutionRequest } from "../../../packages/contracts/src/index.js";

test("records gateway completion as event and telegram report outbox before marking source outbox sent", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex" });
  await seedLocalGatewayOutbox(store, request);

  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: {
      async run() {
        return { exitCode: 0, stdout: "ok", stderr: "Bearer hidden.token" };
      }
    },
    sink: { async publish() {} },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  assert.equal(result.completed, 1);
  const snapshot = store.snapshot();
  assert.equal(snapshot.outbox.find((item) => item.idempotencyKey === "gateway:attempt-1")?.status, "sent");
  assert.equal(snapshot.events.at(-1)?.eventType, "meaningful_intermediate_ready");
  assert.equal(snapshot.events.at(-1)?.idempotencyKey, "gateway-result:attempt-1:completed");
  const report = snapshot.outbox.find((item) => item.idempotencyKey === "telegram-report:attempt-1:completed");
  assert.equal(report?.target.kind, "telegram_bot");
  assert.equal(report?.target.kind === "telegram_bot" ? report.target.botRole : undefined, "codex_leader");
  assert.equal(JSON.stringify(report?.payload).includes("hidden.token"), false);
  const audit = snapshot.outbox.find((item) => item.idempotencyKey === "telegram-audit:attempt-1:completed");
  assert.equal(audit, undefined);
});

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

function makePolicy() {
  return {
    allowedProjectRoots: [process.cwd()],
    allowedAdapters: ["codex", "claude_code"] as const,
    maxRuntimeMs: 30_000,
    allowNetwork: false
  };
}

test("reportBotRole routes execution result through auditor bot", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex", reportBotRole: "auditor" });
  await seedLocalGatewayOutbox(store, request);
  await runLocalGatewayConsumerOnce({ store, policy: makePolicy(), runner: { async run() { return { exitCode: 0, stdout: "audit ok", stderr: "" }; } }, sink: { async publish() {} }, limit: 10, leaseUntil: "2026-08-10T00:01:00.000Z", maxAttempts: 3, now: () => "2026-08-10T00:00:00.000Z" });
  const report = store.snapshot().outbox.find((item) => item.idempotencyKey === "telegram-report:attempt-1:completed");
  assert.equal(report?.target.kind === "telegram_bot" ? report.target.botRole : undefined, "auditor");
});

test("meaningful completion does not request automatic auditor verification by default", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd(), adapterType: "codex", prompt: "보안 수정 완료. 검증 필요." });
  await seedLocalGatewayOutbox(store, request);

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 0, stdout: "구현 완료. 테스트 통과.", stderr: "" }; } },
    sink: { async publish() {} },
    limit: 10,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    maxAttempts: 3,
    now: () => "2026-08-10T00:00:00.000Z"
  });

  const audit = store.snapshot().outbox.find((item) => item.idempotencyKey === "telegram-audit:attempt-1:completed");
  assert.equal(audit, undefined);
});
