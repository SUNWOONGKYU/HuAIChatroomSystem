import assert from "node:assert/strict";
import test from "node:test";
import { checkTelegramBots, formatBotCheckResults } from "./check-telegram-bots.mjs";

const env = {
  BOT_SERVICE_LEADER_BOT_TOKEN: "111111:LEADER_TOKEN_VALUE",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "222222:CLAUDE_TOKEN_VALUE",
  BOT_SERVICE_CODEX_BOT_TOKEN: "333333:CODEX_TOKEN_VALUE",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "444444:AUDITOR_TOKEN_VALUE",
  BOT_SERVICE_LEADER_BOT_USERNAME: "leader_live_bot",
  BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
  BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot"
};

test("checks all role bot identities without formatting token values", async () => {
  const urls = [];
  const results = await checkTelegramBots(env, async (url) => {
    urls.push(String(url));
    const username = String(url).includes("111111") ? "leader_live_bot"
      : String(url).includes("222222") ? "claude_live_bot"
        : String(url).includes("333333") ? "codex_live_bot"
          : "auditor_live_bot";
    return jsonResponse(200, { ok: true, result: { username } });
  });

  assert.equal(results.length, 4);
  assert.equal(results.every((item) => item.ok), true);
  const formatted = formatBotCheckResults(results);
  assert.equal(formatted.includes("LEADER_TOKEN_VALUE"), false);
  assert.equal(urls[0].includes("111111:LEADER_TOKEN_VALUE"), true);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
