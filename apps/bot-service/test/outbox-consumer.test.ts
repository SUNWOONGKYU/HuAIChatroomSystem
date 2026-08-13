import assert from "node:assert/strict";
import test from "node:test";
import { FakeBotServiceStore } from "../src/fake-store.js";
import { runOutboxConsumerOnce } from "../src/consumer.js";
import { dispatchOutboxBatch } from "../src/outbox.js";
import { processTelegramInboundWithPersistence } from "../src/persistence.js";
import {
  TelegramUpdateEnvelope,
  type TelegramInboundQueueMessage
} from "../../../packages/contracts/src/index.js";

test("persists accepted telegram input and sends outbox message", async () => {
  const store = new FakeBotServiceStore();
  const message = makeInboundMessage("/help");

  const result = await processTelegramInboundWithPersistence({
    message,
    processorPorts: makeProcessorPorts(),
    persistence: store
  });

  assert.equal(result.accepted, true);
  assert.equal(store.snapshot().events.length, 0);
  assert.equal(store.snapshot().outbox.length, 1);
  assert.deepEqual(store.snapshot().processedUpdates, [message.idempotencyKey]);

  const dispatch = await runOutboxConsumerOnce({
    store,
    telegram: {
      async sendMessage() {
        return { telegramMessageId: "m1" };
      },
      async editMessageText() {
        throw new Error("unexpected-edit");
      }
    },
    limit: 10,
    leaseMs: 30_000,
    intervalMs: 1_000,
    maxAttempts: 3,
    now: () => new Date("2026-08-05T00:00:00.000Z")
  });

  assert.equal(dispatch.sent, 1);
  assert.equal(store.snapshot().outbox[0]?.status, "sent");
  assert.deepEqual(store.snapshot().outbox[0]?.payload.sendResult, { telegramMessageId: "m1" });
});

test("final outbox boundary strips internal JSON and logs before Telegram send", async () => {
  let sentText = "";
  const result = await dispatchOutboxBatch({
    store: {
      async leasePending() {
        return [{
          outboxId: "outbox-internal",
          idempotencyKey: "internal-1",
          target: { kind: "telegram_bot" as const, botRole: "codex_leader" as const, telegramChatId: "1001" },
          payload: { text: '작업 완료\n{"type":"debug","payload":{"path":"C:\\\\Dev"}}\nstderr: private error\n결과: 정상' },
          status: "processing" as const,
          attempts: 0
        }];
      },
      async markSent() {},
      async markRetry() { throw new Error("unexpected-retry"); },
      async markDead() { throw new Error("unexpected-dead"); }
    },
    telegram: {
      async sendMessage(request) { sentText = request.text; return { telegramMessageId: "m-safe" }; },
      async editMessageText() { throw new Error("unexpected-edit"); }
    },
    limit: 1,
    leaseUntil: "2026-08-13T00:01:00.000Z",
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    maxAttempts: 3,
    allowedChatIds: ["1001"]
  });

  assert.equal(result.sent, 1);
  assert.equal(sentText, "작업 완료\n결과: 정상");
});

test("retries retryable outbox failures before max attempts", async () => {
  const store = await seededOutboxStore("send me");

  const dispatch = await runOutboxConsumerOnce({
    store,
    telegram: failingTelegram("telegram-api-error:500:temporary"),
    limit: 10,
    leaseMs: 30_000,
    intervalMs: 1_000,
    maxAttempts: 3,
    now: () => new Date("2026-08-05T00:00:00.000Z")
  });

  assert.equal(dispatch.retried, 1);
  const row = store.snapshot().outbox[0];
  assert.equal(row?.status, "retry_pending");
  assert.equal(row?.lastError, "telegram-api-error:500:temporary");
});

test("marks update failed when orchestrator processing throws", async () => {
  const store = new FakeBotServiceStore();
  const message = makeInboundMessage("explode");

  await assert.rejects(
    processTelegramInboundWithPersistence({
      message,
      processorPorts: {
        authorization: {
          memberships: [
            {
              telegramChatId: "1001",
              telegramUserId: "2001",
              role: "owner" as const,
              permissions: [],
              status: "active" as const
            }
          ]
        },
        orchestrator: {
          makeId() {
            throw new Error("should-not-run");
          },
          now() {
            throw new Error("clock-failed");
          }
        }
      },
      persistence: store
    })
  );

  const snapshot = store.snapshot();
  assert.equal(snapshot.processedUpdates.length, 0);
  assert.equal(snapshot.failedUpdates.length, 1);
  assert.equal(snapshot.failedUpdates[0]?.idempotencyKey, message.idempotencyKey);
});

test("fake runtime gateway failure does not enqueue internal error details for Telegram", async () => {
  const store = new FakeBotServiceStore();
  const internalError = 'C:\\Dev\\secret\\worker.ts {"stderr":"stack","token":"SECRET"}';

  await store.recordGatewayExecutionResult({
    request: {
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
      createdAt: "2026-08-13T00:00:00.000Z"
    },
    status: "failed",
    errorKind: internalError,
    events: [],
    occurredAt: "2026-08-13T00:00:01.000Z"
  });

  const text = String(store.snapshot().outbox[0]?.payload.text ?? "");
  assert.match(text, /내부 오류가 발생했습니다/);
  assert.equal(text.includes("worker.ts"), false);
  assert.equal(text.includes("stderr"), false);
  assert.equal(text.includes("SECRET"), false);
});

test("marks outbox dead when max attempts is reached and masks bot tokens", async () => {
  const store = await seededOutboxStore("send me");

  const dispatch = await runOutboxConsumerOnce({
    store,
    telegram: failingTelegram("telegram-api-error:500:bot123456:SECRET_TOKEN"),
    limit: 10,
    leaseMs: 30_000,
    intervalMs: 1_000,
    maxAttempts: 1,
    now: () => new Date("2026-08-05T00:00:00.000Z")
  });

  assert.equal(dispatch.dead, 1);
  const row = store.snapshot().outbox[0];
  assert.equal(row?.status, "dead");
  assert.equal(row?.lastError?.includes("SECRET_TOKEN"), false);
  assert.equal(row?.lastError?.includes("bot<redacted>"), true);
});

async function seededOutboxStore(text: string): Promise<FakeBotServiceStore> {
  const store = new FakeBotServiceStore();
  const message = makeInboundMessage(text);
  await processTelegramInboundWithPersistence({
    message,
    processorPorts: makeProcessorPorts(),
    persistence: store
  });
  return store;
}

function makeInboundMessage(text: string): TelegramInboundQueueMessage {
  const envelope = new TelegramUpdateEnvelope(
    "bot-platoon",
    "platoon_bot",
    "platoon_leader",
    "1",
    "1001",
    "10",
    "2001",
    false,
    text,
    undefined
  );
  return {
    input: { kind: "command", envelope, command: { name: text === "/help" ? "/help" : "/newtask", args: text === "/help" ? [] : [text] } },
    idempotencyKey: `telegram-update:${envelope.telegramBotId}:${envelope.updateId}`,
    receivedAt: "2026-08-05T00:00:00.000Z"
  };
}

function makeProcessorPorts() {
  return {
    authorization: {
      memberships: [
        {
          telegramChatId: "1001",
          telegramUserId: "2001",
          role: "owner" as const,
          permissions: [],
          status: "active" as const
        }
      ]
    },
    orchestrator: {
      makeId(prefix: string) {
        return `${prefix}_fixed`;
      },
      now() {
        return "2026-08-05T00:00:00.000Z";
      }
    }
  };
}

function failingTelegram(message: string) {
  return {
    async sendMessage() {
      throw new Error(message);
    },
    async editMessageText() {
      throw new Error(message);
    }
  };
}

test("reports loop errors through onError", async () => {
  const { startOutboxConsumerLoop } = await import("../src/consumer.js");
  const errors: string[] = [];

  const handle = startOutboxConsumerLoop({
    store: {
      async leasePending() {
        throw new Error("Bearer secret-token-failed");
      },
      async markSent() {},
      async markRetry() {},
      async markDead() {}
    },
    telegram: {
      async sendMessage() { return { telegramMessageId: "unused" }; },
      async editMessageText() { return { telegramMessageId: "unused" }; }
    },
    limit: 1,
    leaseMs: 1000,
    intervalMs: 100000,
    maxAttempts: 1,
    onError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.stop();

  assert.equal(errors.length, 1);
  assert.equal(errors[0], "Bearer secret-token-failed");
});

