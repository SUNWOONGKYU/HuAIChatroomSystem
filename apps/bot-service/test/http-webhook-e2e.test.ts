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
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/leader_bot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "leader-secret"
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
    assert.deepEqual(store.snapshot().processedUpdates, ["telegram-update:bot-leader:7001"]);
    assert.equal(store.snapshot().events.length, 1);
    assert.equal(store.snapshot().events[0]?.eventType, "proposal_created");
    assert.equal(store.snapshot().outbox.length, 1);
    const outboxTarget = store.snapshot().outbox[0]?.target;
    assert.equal(outboxTarget?.kind, "telegram_bot");
    if (outboxTarget?.kind !== "telegram_bot") throw new Error("unexpected-outbox-target");
    assert.equal(outboxTarget.botRole, "leader");
    assert.equal(JSON.stringify(store.snapshot().outbox).includes("leader-secret"), false);
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
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/leader_bot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "leader-secret"
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
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/leader_bot`, {
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
    const response = await postWebhook(port, telegramMessageUpdate("/newtask outside", 9999), "leader-secret");
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
    const response = await postWebhook(port, update, "leader-secret");
    const ack = await response.json() as Record<string, unknown>;
    assert.deepEqual(ack, { httpStatus: 200, queued: false, reason: "bot-message-ignored" });
    assert.deepEqual(recorded, []);
    assert.equal(queued.length, 0);
  } finally { await close(server); }
});

test("the leader desk handles a message aimed at another bot instead of yielding it", async () => {
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
    const response = await postWebhook(port, telegramMessageUpdate("@claude_bot 이거 해줘"), "leader-secret");
    const ack = await response.json() as Record<string, unknown>;

    // 리더는 다른 봇이 지목된 메시지도 양보하지 않는다.
    //
    // 양보에는 "지목된 봇이 그 메시지를 받는다"는 전제가 있는데, 라이브에서 그 전제가
    // 깨졌다 — 메인방에서 리더 봇만 업데이트를 받고(fetched=1) 양보했고, 지목된 봇에게는
    // Telegram 이 아무것도 주지 않아 큐잉이 0건이었다. 아무도 처리하지 않고 방이 조용히
    // 죽었다. 리더는 방의 기본 창구이므로 여기서 받아야 한다.
    //
    // 작업자 배정은 수신한 봇이 아니라 본문의 지목으로 정해지므로(orchestrator 의
    // detectRequestedExecutionActorRole), 리더가 받아도 일은 지목된 봇에게 간다.
    // 리더가 아닌 봇의 양보는 그대로 유지된다 — multi-bot-mention-race.test.ts 참고.
    assert.deepEqual(ack, { httpStatus: 200, queued: true });
    assert.equal(queued.length, 1, "아무도 처리하지 않았다 — 방이 조용히 죽는다");
    assert.equal(queued[0]?.input.kind, "message");
    assert.match(String(queued[0]?.input.envelope.messageText), /@claude_bot/, "지목이 본문에 남아야 배정이 된다");
    assert.equal(recorded.length, 1);

    const ignoreLog = logs.find((line) => line.includes("telegram_webhook_ignored"));
    assert.equal(ignoreLog, undefined, "리더가 처리했는데 무시 로그가 남았다");
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
    await postWebhook(port, update, "leader-secret");
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
    const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/leader_bot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "leader-secret" },
      body: "{bad json"
    });
    assert.deepEqual(await response.json(), { httpStatus: 200, queued: false, reason: "malformed-update" });
  } finally { await close(server); }
});

test("owner approve command redirects to the collaboration operations center", async () => {
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
    const response = await postWebhook(port, telegramMessageUpdate("/approve task-e2e"), "leader-secret");
    assert.deepEqual(await response.json(), { httpStatus: 200, queued: true });
    const store = new FakeBotServiceStore();
    const processed = await processTelegramInboundWithPersistence({
      message: queued[0]!,
      processorPorts: processorPortsWithExecutionDefaults(),
      persistence: store
    });
    assert.equal(processed.accepted, true);
    assert.deepEqual(store.snapshot().events, []);
    assert.equal(store.snapshot().outbox.length, 1);
    const redirectOutbox = store.snapshot().outbox[0];
    assert.equal(redirectOutbox?.target.kind, "telegram_bot");
    const payload = redirectOutbox?.payload as Record<string, unknown>;
    assert.equal(payload.ownerActionRedirect, true);
    assert.equal(String(payload.text).includes("협업 운영센터에서만 처리합니다"), true);
    assert.equal(store.snapshot().outbox.some((item) => item.target.kind === "local_gateway"), false);
    assert.equal(JSON.stringify(payload).includes("leader-secret"), false);
  } finally { await close(server); }
});

function postWebhook(port: number, payload: unknown, secret: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/telegram/webhook/leader_bot`, {
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
      ["leader_bot", { telegramBotId: "bot-leader", botUsername: "leader_bot", botRole: "leader" as const, webhookSecret: "leader-secret" }]
    ])
  };
}

function twoBotConfig() {
  return {
    allowedChatIds: ["1001"],
    botsByUsername: new Map([
      ["leader_bot", { telegramBotId: "bot-leader", botUsername: "leader_bot", botRole: "leader" as const, webhookSecret: "leader-secret" }],
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
