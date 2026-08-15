import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramWebhookHttpServer } from "../src/http.js";
import { FakeBotServiceStore } from "../src/fake-store.js";
import { processTelegramInboundWithPersistence } from "../src/persistence.js";
import { makeTelegramUpdateIdempotencyKey, type TelegramWebhookPorts } from "../src/index.js";
import { type TelegramInboundQueueMessage, type TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";

test("accepts webhook over HTTP and turns queued command into outbox", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const recorded: string[] = [];
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope, _raw, status) {
          recorded.push(`${status}:${envelope.updateId}`);
          return { inserted: true, status, idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: {
        async enqueue(message) {
          queued.push(message);
        }
      }
    }
  });

  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/platoon_bot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "platoon-secret"
      },
      body: JSON.stringify(telegramMessageUpdate("/newtask build the gateway"))
    });
    const ack = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(ack, { httpStatus: 200, queued: true });
    assert.deepEqual(recorded, ["received:7001"]);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.input.kind, "command");

    const store = new FakeBotServiceStore();
    const processed = await processTelegramInboundWithPersistence({
      message: queued[0]!,
      processorPorts: processorPorts(),
      persistence: store
    });

    assert.equal(processed.accepted, true);
    assert.deepEqual(store.snapshot().processedUpdates, ["telegram-update:bot-platoon:7001"]);
    assert.equal(store.snapshot().events.length, 1);
    assert.equal(store.snapshot().events[0]?.eventType, "proposal_created");
    assert.equal(store.snapshot().outbox.length, 1);
    const outboxTarget = store.snapshot().outbox[0]?.target;
    assert.equal(outboxTarget?.kind, "telegram_bot");
    if (outboxTarget?.kind !== "telegram_bot") throw new Error("unexpected-outbox-target");
    assert.equal(outboxTarget.botRole, "platoon_leader");
    assert.equal(JSON.stringify(store.snapshot().outbox).includes("platoon-secret"), false);
  } finally {
    await close(server);
  }
});

test("does not enqueue duplicate webhook update", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope) {
          return { inserted: false, status: "processed", idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue(message) { queued.push(message); } }
    }
  });

  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/platoon_bot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "platoon-secret"
      },
      body: JSON.stringify(telegramMessageUpdate("/help"))
    });
    const ack = await response.json() as Record<string, unknown>;

    assert.deepEqual(ack, { httpStatus: 200, queued: false, reason: "duplicate-update" });
    assert.equal(queued.length, 0);
  } finally {
    await close(server);
  }
});

test("rejects invalid webhook secret before recording update", async () => {
  let recorded = false;
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce() {
          recorded = true;
          throw new Error("should-not-record");
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue() { throw new Error("should-not-enqueue"); } }
    }
  });

  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/platoon_bot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong-secret"
      },
      body: JSON.stringify(telegramMessageUpdate("/help"))
    });
    const ack = await response.json() as Record<string, unknown>;

    assert.deepEqual(ack, { httpStatus: 200, queued: false, reason: "invalid-webhook-secret" });
    assert.equal(recorded, false);
  } finally {
    await close(server);
  }
});

test("records unauthorized chat as ignored without enqueue", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const recorded: string[] = [];
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope, _raw, status) {
          recorded.push(status + ":" + envelope.telegramChatId);
          return { inserted: true, status, idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue(message) { queued.push(message); } }
    }
  });
  const port = await listen(server);
  try {
    const response = await postWebhook(port, telegramMessageUpdate("/newtask outside", 9999), "platoon-secret");
    const ack = await response.json() as Record<string, unknown>;
    assert.deepEqual(ack, { httpStatus: 200, queued: false, reason: "unauthorized-chat" });
    assert.deepEqual(recorded, []);
    assert.equal(queued.length, 0);
  } finally { await close(server); }
});

test("records bot messages as ignored without enqueue", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const recorded: string[] = [];
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope, _raw, status) {
          recorded.push(status + ":" + envelope.updateId);
          return { inserted: true, status, idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue(message) { queued.push(message); } }
    }
  });
  const port = await listen(server);
  try {
    const update = telegramMessageUpdate("/newtask from bot");
    update.message.from.is_bot = true;
    const response = await postWebhook(port, update, "platoon-secret");
    const ack = await response.json() as Record<string, unknown>;
    assert.deepEqual(ack, { httpStatus: 200, queued: false, reason: "bot-message-ignored" });
    assert.deepEqual(recorded, []);
    assert.equal(queued.length, 0);
  } finally { await close(server); }
});

test("logs the ignore reason when a webhook update is yielded to a different bot", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const recorded: string[] = [];
  const server = createTelegramWebhookHttpServer({
    config: twoBotConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope, _raw, status) {
          recorded.push(status + ":" + envelope.updateId);
          return { inserted: true, status, idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue(message) { queued.push(message); } }
    }
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => { logs.push(String(line)); };

  const port = await listen(server);
  try {
    const response = await postWebhook(port, telegramMessageUpdate("@claude_bot 이거 해줘"), "platoon-secret");
    const ack = await response.json() as Record<string, unknown>;

    // ack 자체엔 계약(TelegramWebhookRejectReason) 밖 값을 못 실어서 reason 이 빠진다 —
    // 실제 사유는 로그로 남아야 한다(아래 확인). Telegram 은 ack body 를 읽지 않는다.
    assert.deepEqual(ack, { httpStatus: 200, queued: false });
    assert.equal(queued.length, 0);
    assert.deepEqual(recorded, [], "다른 봇에게 양보한 update 는 기록 자체가 없어야 한다");

    const ignoreLog = logs.find((line) => line.includes("telegram_webhook_ignored"));
    assert.ok(ignoreLog, "무시 사유 로그가 남아야 한다");
    const parsed = JSON.parse(ignoreLog!);
    assert.equal(parsed.reason, "not-addressed-to-this-bot");
    assert.equal(parsed.botUsername, "platoon_bot");
  } finally {
    console.log = originalLog;
    await close(server);
  }
});

test("does not log bot-message-ignored (already routine, would be noise)", async () => {
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope, _raw, status) {
          return { inserted: true, status, idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue() {} }
    }
  });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => { logs.push(String(line)); };

  const port = await listen(server);
  try {
    const update = telegramMessageUpdate("/newtask from bot");
    update.message.from.is_bot = true;
    await postWebhook(port, update, "platoon-secret");
    assert.equal(logs.some((line) => line.includes("telegram_webhook_ignored")), false);
  } finally {
    console.log = originalLog;
    await close(server);
  }
});

test("returns malformed-update for invalid json body", async () => {
  const server = createTelegramWebhookHttpServer({ config: botConfig(), ports: unusedPorts() });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/platoon_bot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "platoon-secret" },
      body: "{bad json"
    });
    assert.deepEqual(await response.json(), { httpStatus: 200, queued: false, reason: "malformed-update" });
  } finally { await close(server); }
});

test("owner approve command creates local gateway outbox when execution defaults exist", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const server = createTelegramWebhookHttpServer({
    config: botConfig(),
    ports: {
      updates: {
        async recordUpdateOnce(envelope, _raw, status) {
          return { inserted: true, status, idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope) };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue(message) { queued.push(message); } }
    }
  });
  const port = await listen(server);
  try {
    const response = await postWebhook(port, telegramMessageUpdate("/approve task-e2e"), "platoon-secret");
    assert.deepEqual(await response.json(), { httpStatus: 200, queued: true });
    const store = new FakeBotServiceStore();
    const processed = await processTelegramInboundWithPersistence({
      message: queued[0]!,
      processorPorts: processorPortsWithExecutionDefaults(),
      persistence: store
    });
    assert.equal(processed.accepted, true);
    assert.equal(store.snapshot().events[0]?.eventType, "owner_task_approved");
    const gatewayOutbox = store.snapshot().outbox.find((item) => item.target.kind === "local_gateway");
    assert.equal(gatewayOutbox?.target.kind, "local_gateway");
    const payload = gatewayOutbox?.payload as Record<string, unknown>;
    assert.equal(typeof payload.executionRequest, "object");
    assert.equal(JSON.stringify(payload).includes("platoon-secret"), false);
  } finally { await close(server); }
});

function postWebhook(port: number, payload: unknown, secret: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/telegram/webhook/platoon_bot`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(payload)
  });
}

function unusedPorts(): TelegramWebhookPorts {
  return {
    updates: {
      async recordUpdateOnce() { throw new Error("unused"); },
      async markUpdateFailed() {}
    },
    inboundQueue: { async enqueue() { throw new Error("unused"); } }
  };
}

function processorPortsWithExecutionDefaults() {
  const ports = processorPorts();
  return {
    ...ports,
    orchestrator: {
      ...ports.orchestrator,
      executionDefaults: {
        roomId: "room-e2e",
        actorId: "actor-codex",
        adapterType: "codex" as const,
        projectPath: process.cwd(),
        timeoutMs: 600000,
        gatewayId: "primary",
        promptForTask(taskId: string) { return `run ${taskId}`; }
      }
    }
  };
}

function botConfig() {
  return {
    allowedChatIds: ["1001"],
    botsByUsername: new Map([
      ["platoon_bot", { telegramBotId: "bot-platoon", botUsername: "platoon_bot", botRole: "platoon_leader" as const, webhookSecret: "platoon-secret" }]
    ])
  };
}

function twoBotConfig() {
  return {
    allowedChatIds: ["1001"],
    botsByUsername: new Map([
      ["platoon_bot", { telegramBotId: "bot-platoon", botUsername: "platoon_bot", botRole: "platoon_leader" as const, webhookSecret: "platoon-secret" }],
      ["claude_bot", { telegramBotId: "bot-claude", botUsername: "claude_bot", botRole: "claude_leader" as const, webhookSecret: "claude-secret" }]
    ])
  };
}

function telegramMessageUpdate(text: string, chatId = 1001) {
  return {
    update_id: 7001,
    message: {
      message_id: 9001,
      chat: { id: chatId },
      from: { id: 2001, is_bot: false, username: "owner" },
      text
    }
  };
}

function processorPorts() {
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
      makeId(prefix: string) { return `${prefix}-e2e`; },
      now() { return "2026-08-10T00:00:00.000Z"; }
    }
  };
}

function listen(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("unexpected-address");
      resolve(address.port);
    });
  });
}

function close(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
