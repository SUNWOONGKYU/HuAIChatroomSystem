import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramFetchSender, createTelegramGrammySender, dispatchOutboxBatch, type TelegramBotTokenResolver } from "../src/outbox.js";
import { type OutboxRecord, type TelegramBotRole, type TelegramSendResult } from "../../../packages/contracts/src/index.js";

test("uses the token for the requested bot role on send and edit", async () => {
  const resolvedRoles: TelegramBotRole[] = [];
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const tokenResolver: TelegramBotTokenResolver = {
    async resolveBotToken(role) {
      resolvedRoles.push(role);
      return `${role}-token`;
    }
  };
  const sender = createTelegramFetchSender({
    tokenResolver,
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return jsonResponse(200, { ok: true, result: { message_id: urls.length } });
    }
  });

  await sender.sendMessage({ botRole: "platoon_leader", telegramChatId: "1001", text: "hello" });
  await sender.editMessageText({ botRole: "auditor", telegramChatId: "1001", telegramMessageId: "77", text: "checked" });

  assert.deepEqual(resolvedRoles, ["platoon_leader", "auditor"]);
  assert.equal(urls[0], "https://api.telegram.org/botplatoon_leader-token/sendMessage");
  assert.equal(urls[1], "https://api.telegram.org/botauditor-token/editMessageText");
  assert.deepEqual(bodies[0], { chat_id: "1001", text: "hello" });
  assert.deepEqual(bodies[1], { chat_id: "1001", message_id: "77", text: "checked" });
});

test("grammy sender sends messages without optional reply id", async () => {
  const sender = createTelegramGrammySender({
    tokenResolver: { async resolveBotToken() { return "token"; } },
    apiFactory: () => ({
      async sendMessage() { return { message_id: 123 } as never; },
      async editMessageText() { return { message_id: 124 } as never; },
      async answerCallbackQuery() { return true; },
      async pinChatMessage() { return true; }
    })
  });
  const sent = await sender.sendMessage({ botRole: "platoon_leader", telegramChatId: "1001", text: "hello" });
  assert.equal(sent.telegramMessageId, "123");
});
test("honors telegram retry_after when rate limited", async () => {
  const store = new SingleOutboxStore({
    outboxId: "outbox-1",
    idempotencyKey: "idem-1",
    target: { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" },
    payload: { text: "slow down" },
    status: "processing",
    attempts: 0
  });
  const sender = createTelegramFetchSender({
    tokenResolver: { async resolveBotToken() { return "bot123456:SECRET_TOKEN"; } },
    fetchImpl: async () => jsonResponse(429, {
      ok: false,
      description: "Too Many Requests: retry after 17 for bot123456:SECRET_TOKEN",
      parameters: { retry_after: 17 }
    })
  });

  const result = await dispatchOutboxBatch({
    store,
    telegram: sender,
    limit: 1,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    maxAttempts: 3
  });

  assert.equal(result.retried, 1);
  assert.equal(store.nextAttemptAt, "2026-08-10T00:00:17.000Z");
  assert.equal(store.lastError?.includes("SECRET_TOKEN"), false);
  assert.equal(store.lastError?.includes("bot<redacted>"), true);
});


test("treats expired callback answer as non-fatal", async () => {
  const store = new SingleOutboxStore({
    outboxId: "outbox-callback-expired",
    idempotencyKey: "idem-callback-expired",
    target: { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" },
    payload: { callbackQueryId: "old-callback" },
    status: "processing",
    attempts: 0
  });

  const result = await dispatchOutboxBatch({
    store,
    telegram: {
      async sendMessage() { throw new Error("unexpected-send"); },
      async editMessageText() { throw new Error("unexpected-edit"); },
      async answerCallbackQuery() { throw new Error("telegram-api-error:400:Bad Request: query is too old and response timeout expired or query ID is invalid"); }
    },
    limit: 1,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    maxAttempts: 3
  });

  assert.equal(result.sent, 1);
  assert.equal(store.sentResult?.telegramMessageId, "callback-query-expired");
  assert.equal(store.lastError, undefined);
});
test("blocks outbound messages to unauthorized chats before Telegram API call", async () => {
  let sendCalled = false;
  const store = new SingleOutboxStore({
    outboxId: "outbox-unauthorized",
    idempotencyKey: "idem-unauthorized",
    target: { kind: "telegram_bot", botRole: "codex_leader", telegramChatId: "9999" },
    payload: { text: "do not send" },
    status: "processing",
    attempts: 0
  });

  const result = await dispatchOutboxBatch({
    store,
    telegram: {
      async sendMessage() {
        sendCalled = true;
        return { telegramMessageId: "bad" };
      },
      async editMessageText() {
        sendCalled = true;
        return { telegramMessageId: "bad" };
      }
    },
    limit: 1,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    maxAttempts: 3,
    allowedChatIds: ["1001"]
  });

  assert.equal(result.dead, 1);
  assert.equal(sendCalled, false);
  assert.equal(store.lastError, "unauthorized-outbound-chat");
});
class SingleOutboxStore {
  lastError: string | undefined;
  nextAttemptAt: string | undefined;
  sentResult: TelegramSendResult | undefined;

  constructor(private readonly row: OutboxRecord) {}

  async leasePending(): Promise<OutboxRecord[]> {
    return [this.row];
  }

  async markSent(_outboxId: string, result: TelegramSendResult): Promise<void> {
    this.sentResult = result;
  }

  async markRetry(_outboxId: string, error: string, nextAttemptAt: string): Promise<void> {
    this.lastError = error;
    this.nextAttemptAt = nextAttemptAt;
  }

  async markDead(_outboxId: string, error: string): Promise<void> {
    this.lastError = error;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}


test("splits long outbound messages instead of truncating them", async () => {
  const bodies: Array<{ text: string; reply_markup?: unknown }> = [];
  const sender = createTelegramFetchSender({
    tokenResolver: { async resolveBotToken() { return "token"; } },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, { ok: true, result: { message_id: bodies.length } });
    }
  });
  const longText = "가".repeat(4500) + "끝";
  const keyboard = { inline_keyboard: [[{ text: "확인", callback_data: "ok" }]] };
  await sender.sendMessage({ botRole: "auditor", telegramChatId: "1001", text: longText, keyboard });
  assert.equal(bodies.length, 2);
  assert.equal(bodies.map((body) => body.text).join(""), longText);
  assert.equal(bodies[0].reply_markup, undefined);
  assert.deepEqual(bodies[1].reply_markup, keyboard);
});

test("fetch sender attaches timeout signal to Telegram API calls", async () => {
  let signal: unknown;
  const sender = createTelegramFetchSender({
    tokenResolver: { async resolveBotToken() { return "token"; } },
    timeoutMs: 1234,
    fetchImpl: async (_url, init) => {
      signal = init?.signal;
      return jsonResponse(200, { ok: true, result: { message_id: 1 } });
    }
  });

  await sender.sendMessage({ botRole: "platoon_leader", telegramChatId: "1001", text: "hello" });
  assert.equal(signal instanceof AbortSignal, true);
});
