import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramWebhookHttpServer } from "../src/http.js";

test("serves token-free bot-service health response", async () => {
  const server = createTelegramWebhookHttpServer({
    config: {
      allowedChatIds: ["1001", "1002"],
      botsByUsername: new Map([
        ["platoon_bot", { telegramBotId: "bot-1", botUsername: "platoon_bot", botRole: "platoon_leader", webhookSecret: "secret-1" }],
        ["claude_bot", { telegramBotId: "bot-2", botUsername: "claude_bot", botRole: "claude_leader", webhookSecret: "secret-2" }],
        ["codex_bot", { telegramBotId: "bot-3", botUsername: "codex_bot", botRole: "codex_leader", webhookSecret: "secret-3" }],
        ["auditor_bot", { telegramBotId: "bot-4", botUsername: "auditor_bot", botRole: "auditor", webhookSecret: "secret-4" }]
      ])
    },
    ports: {
      updates: {
        async recordUpdateOnce() { throw new Error("unused"); },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue() {} }
    }
  });

  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, service: "bot-service", bots: 4, allowedChats: 2 });
    assert.equal(JSON.stringify(body).includes("secret"), false);
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("unexpected-address");
      const port = address.port;
      resolve(port);
    });
  });
}

function close(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
