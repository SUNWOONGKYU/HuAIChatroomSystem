import assert from "node:assert/strict";
import test from "node:test";
import { checkTelegramWebhooks, formatWebhookCheckResults } from "./check-telegram-webhooks.mjs";

const env = {
  BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com/",
  BOT_SERVICE_LEADER_BOT_TOKEN: "111111:LEADER_TOKEN_VALUE",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "222222:CLAUDE_TOKEN_VALUE",
  BOT_SERVICE_CODEX_BOT_TOKEN: "333333:CODEX_TOKEN_VALUE",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "444444:AUDITOR_TOKEN_VALUE",
  BOT_SERVICE_LEADER_BOT_USERNAME: "leader_live_bot",
  BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
  BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot"
};

test("checks webhook URLs and formats token-free summary", async () => {
  const urls = [];
  const usernames = ["leader_live_bot", "claude_live_bot", "codex_live_bot", "auditor_live_bot"];
  const results = await checkTelegramWebhooks(env, async (url) => {
    urls.push(String(url));
    const username = usernames[urls.length - 1];
    return jsonResponse(200, { ok: true, result: { url: `https://ops.example.com/telegram/webhook/${username}`, pending_update_count: 0 } });
  });

  assert.equal(results.length, 4);
  assert.equal(results.every((item) => item.ok), true);
  const formatted = formatWebhookCheckResults(results);
  assert.equal(formatted.includes("TOKEN_VALUE"), false);
  assert.equal(formatted.includes("pending=0"), true);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
