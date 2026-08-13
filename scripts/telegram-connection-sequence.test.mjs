import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTelegramConnectionSequence,
  formatTelegramConnectionSequence
} from "./telegram-connection-sequence.mjs";

const completeEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
  BOT_SERVICE_ROOM_ID: "11111111-1111-4111-8111-111111111111",
  BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
  BOT_SERVICE_OWNER_TELEGRAM_USER_ID: "123456789",
  BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com",
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
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot",
  LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem",
  LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code"
};

test("builds the real Telegram connection order when operation env is complete", () => {
  const sequence = buildTelegramConnectionSequence(completeEnv);

  assert.equal(sequence.ready, true);
  assert.deepEqual(sequence.errors, []);
  assert.equal(sequence.steps.map((step) => step.id).join(","), [
    "fill-env",
    "discover-ids",
    "seed-room",
    "dry-run-webhooks",
    "apply-webhooks",
    "check-live",
    "start-services"
  ].join(","));
  assert.equal(sequence.webhookPlan.length, 4);
});

test("formats a token-free blocked sequence when live values are missing", () => {
  const sequence = buildTelegramConnectionSequence({});
  const formatted = formatTelegramConnectionSequence(sequence);

  assert.equal(sequence.ready, false);
  assert.match(formatted, /Telegram connection sequence: BLOCKED/);
  assert.match(formatted, /missing-env:SUPABASE_URL/);
  assert.equal(formatted.includes("tok-platoon"), false);
  assert.equal(formatted.includes("sec-platoon"), false);
});

test("formats webhook plan without leaking bot tokens or webhook secrets", () => {
  const sequence = buildTelegramConnectionSequence(completeEnv);
  const formatted = formatTelegramConnectionSequence(sequence);

  assert.match(formatted, /PLAN platoon username=platoon_live_bot/);
  assert.equal(formatted.includes("tok-platoon"), false);
  assert.equal(formatted.includes("sec-platoon"), false);
});
