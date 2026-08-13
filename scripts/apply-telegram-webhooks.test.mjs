import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTelegramWebhooks,
  buildWebhookPlan,
  formatWebhookApplyResults,
  formatWebhookPlan
} from "./apply-telegram-webhooks.mjs";

const env = {
  BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com/",
  BOT_SERVICE_PLATOON_BOT_TOKEN: "tok-platoon",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "tok-claude",
  BOT_SERVICE_CODEX_BOT_TOKEN: "tok-codex",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "tok-auditor",
  BOT_SERVICE_PLATOON_WEBHOOK_SECRET: "sec-platoon",
  BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "sec-claude",
  BOT_SERVICE_CODEX_WEBHOOK_SECRET: "sec-codex",
  BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "sec-auditor",
  BOT_SERVICE_PLATOON_BOT_USERNAME: "platoon_live_bot",
  BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
  BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot"
};

test("builds token-free webhook dry-run plan", () => {
  const plan = buildWebhookPlan(env);
  const formatted = formatWebhookPlan(plan);

  assert.equal(plan.length, 4);
  assert.equal(plan[0].url, "https://ops.example.com/telegram/webhook/platoon_live_bot");
  assert.equal(formatted.includes("tok-platoon"), false);
  assert.equal(formatted.includes("sec-platoon"), false);
});

test("applies four webhooks without formatting token or secret values", async () => {
  const calls = [];
  const results = await applyTelegramWebhooks(env, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return jsonResponse(200, { ok: true, result: true });
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "https://api.telegram.org/bottok-platoon/setWebhook");
  assert.deepEqual(calls[0].body, {
    url: "https://ops.example.com/telegram/webhook/platoon_live_bot",
    secret_token: "sec-platoon"
  });
  const formatted = formatWebhookApplyResults(results);
  assert.equal(formatted.includes("tok-platoon"), false);
  assert.equal(formatted.includes("sec-platoon"), false);
});

test("requires public base url", () => {
  assert.throws(() => buildWebhookPlan({}), /missing-env:BOT_SERVICE_PUBLIC_BASE_URL/);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
