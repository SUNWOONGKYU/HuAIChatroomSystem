import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramFetchSender, dispatchOutboxBatch, type TelegramBotTokenResolver } from "../src/outbox.js";
import { type OutboxRecord, type TelegramSendResult } from "../../../packages/contracts/src/index.js";

test("answers callback queries from outbox payload without requiring message text", async () => {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const tokenResolver: TelegramBotTokenResolver = {
    async resolveBotToken() {
      return "platoon-token";
    }
  };
  const sender = createTelegramFetchSender({
    tokenResolver,
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return jsonResponse(200, { ok: true, result: true });
    }
  });
  const store = new SingleOutboxStore({
    outboxId: "outbox-callback",
    idempotencyKey: "callback-answer-1",
    target: { kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" },
    payload: { callbackQueryId: "callback-1", text: "접수했습니다." },
    status: "processing",
    attempts: 0
  });

  const result = await dispatchOutboxBatch({
    store,
    telegram: sender,
    limit: 1,
    leaseUntil: "2026-08-10T00:01:00.000Z",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    maxAttempts: 3
  });

  assert.equal(result.sent, 1);
  assert.equal(urls[0], "https://api.telegram.org/botplatoon-token/answerCallbackQuery");
  assert.deepEqual(bodies[0], { callback_query_id: "callback-1", text: "접수했습니다." });
  assert.equal(store.sentResult?.telegramMessageId, "");
});

class SingleOutboxStore {
  sentResult: TelegramSendResult | undefined;
  constructor(private readonly row: OutboxRecord) {}
  async leasePending(): Promise<OutboxRecord[]> { return [this.row]; }
  async markSent(_outboxId: string, result: TelegramSendResult): Promise<void> { this.sentResult = result; }
  async markRetry(): Promise<void> {}
  async markDead(): Promise<void> {}
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("sends bound callback outbox as chat message", async () => {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const sender = createTelegramFetchSender({
    tokenResolver: { async resolveBotToken() { return "auditor-token"; } },
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return jsonResponse(200, { ok: true, result: { message_id: 77 } });
    }
  });
  const store = new SingleOutboxStore({
    outboxId: "outbox-bound-callback",
    idempotencyKey: "bound-callback-1",
    target: { kind: "telegram_bot", botRole: "auditor", telegramChatId: "1001" },
    payload: { callbackQueryId: "old-callback", text: "보완 요청: task-1", keyboard: { inline_keyboard: [] }, binding: { kind: "event", eventId: "e1" } },
    status: "processing",
    attempts: 0
  });
  const result = await dispatchOutboxBatch({ store, telegram: sender, limit: 1, leaseUntil: "2026-08-10T00:01:00.000Z", now: () => new Date("2026-08-10T00:00:00.000Z"), maxAttempts: 3 });
  assert.equal(result.sent, 1);
  assert.equal(urls[0], "https://api.telegram.org/botauditor-token/sendMessage");
  assert.deepEqual(bodies[0], { chat_id: "1001", text: "보완 요청: task-1", reply_markup: { inline_keyboard: [] } });
});
