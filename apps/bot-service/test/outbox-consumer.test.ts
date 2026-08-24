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

test("429 rate limit retries instead of exhausting attempts, even at maxAttempts", async () => {
  const store = await seededOutboxStore("send me");

  const dispatch = await runOutboxConsumerOnce({
    store,
    telegram: failingTelegram("telegram-api-error:429:too many requests"),
    limit: 10,
    leaseMs: 30_000,
    intervalMs: 1_000,
    maxAttempts: 1,
    now: () => new Date("2026-08-05T00:00:00.000Z")
  });

  assert.equal(dispatch.dead, 0, "429는 영구 실패가 아니므로 dead 로 가면 안 된다");
  assert.equal(dispatch.retried, 1);
  const row = store.snapshot().outbox[0];
  assert.equal(row?.status, "retry_pending");
  assert.equal(row?.lastError, "telegram-api-error:429:too many requests");
});

// V1 검증에서 지적된 문제: lease_huai_outbox 는 리스마다(429 로 인한 재시도 포함) DB
// attempts 를 무조건 올린다. 위 테스트는 "429 자체가 dead 로 안 간다"만 증명했지,
// "429 가 남긴 attempts 부풀림이 그 다음 진짜 오류를 즉사시키지 않는다"는 증명하지
// 못했다 — 429 를 여러 번 겪은 뒤 DB attempts 가 이미 maxAttempts 근처까지 올라가
// 있으면, 그 다음 일시적 500 단 한 번에 재시도 예산이 남았음에도 markDead 로 간다.
test("429 를 여러 번 겪어도 그 뒤에 오는 첫 진짜 오류의 재시도 예산은 온전하다", async () => {
  const store = await seededOutboxStore("send me");
  const maxAttempts = 5;

  for (let round = 0; round < 5; round += 1) {
    const dispatch = await runOutboxConsumerOnce({
      store,
      telegram: failingTelegram("telegram-api-error:429:too many requests"),
      limit: 10,
      leaseMs: 30_000,
      intervalMs: 1_000,
      maxAttempts,
      now: () => new Date("2026-08-05T00:00:00.000Z")
    });
    assert.equal(dispatch.dead, 0, `round ${round}: 429 만으로는 죽으면 안 된다`);
    assert.equal(dispatch.retried, 1, `round ${round}`);
  }

  const afterRealFailure = await runOutboxConsumerOnce({
    store,
    telegram: failingTelegram("telegram-api-error:500:temporary"),
    limit: 10,
    leaseMs: 30_000,
    intervalMs: 1_000,
    maxAttempts,
    now: () => new Date("2026-08-05T00:00:00.000Z")
  });

  assert.equal(afterRealFailure.dead, 0, "429 5회 뒤에 온 첫 진짜 오류만으로 즉시 죽으면 안 된다(회귀 지점)");
  assert.equal(afterRealFailure.retried, 1, "429 이력이 있어도 진짜 오류는 재시도 예산이 남아있어야 한다");
  assert.equal(store.snapshot().outbox[0]?.status, "retry_pending");
});

test("429 가 연속으로 여러 번(리스 횟수 > maxAttempts) 와도 계속 재시도된다", async () => {
  const store = await seededOutboxStore("send me");

  for (let round = 0; round < 10; round += 1) {
    const dispatch = await runOutboxConsumerOnce({
      store,
      telegram: failingTelegram("telegram-api-error:429:too many requests"),
      limit: 10,
      leaseMs: 30_000,
      intervalMs: 1_000,
      maxAttempts: 1,
      now: () => new Date("2026-08-05T00:00:00.000Z")
    });
    assert.equal(dispatch.dead, 0, `round ${round}`);
    assert.equal(dispatch.retried, 1, `round ${round}`);
  }

  assert.equal(store.snapshot().outbox[0]?.status, "retry_pending");
});

// 과잉 수정 방지 가드: 429 를 겪었더라도, 그 뒤에 반복되는 "진짜" 오류는 예산을 다
// 쓰면 여전히 죽어야 한다. 429 예외 처리를 잘못 넓혀서 모든 오류를 무제한 재시도로
// 만들어버리면 이 테스트가 잡는다.
test("429 이력이 있어도 그 뒤 반복되는 진짜 오류는 예산 소진 시 결국 죽는다(무한 재시도 아님)", async () => {
  const store = await seededOutboxStore("send me");
  const maxAttempts = 3;

  for (let round = 0; round < 2; round += 1) {
    await runOutboxConsumerOnce({
      store,
      telegram: failingTelegram("telegram-api-error:429:too many requests"),
      limit: 10,
      leaseMs: 30_000,
      intervalMs: 1_000,
      maxAttempts,
      now: () => new Date("2026-08-05T00:00:00.000Z")
    });
  }

  let deadCount = 0;
  for (let round = 0; round < maxAttempts + 2; round += 1) {
    const dispatch = await runOutboxConsumerOnce({
      store,
      telegram: failingTelegram("telegram-api-error:500:persistent"),
      limit: 10,
      leaseMs: 30_000,
      intervalMs: 1_000,
      maxAttempts,
      now: () => new Date("2026-08-05T00:00:00.000Z")
    });
    deadCount += dispatch.dead;
    if (dispatch.dead > 0) break;
  }

  assert.equal(deadCount, 1, "429 를 겪었더라도 진짜 오류가 예산을 다 쓰면 결국 죽어야 한다");
  assert.equal(store.snapshot().outbox[0]?.status, "dead");
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
    "bot-leader",
    "leader_bot",
    "leader",
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

