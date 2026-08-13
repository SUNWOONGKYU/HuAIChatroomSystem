import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const text = readFileSync(".env.operation.example", "utf8");
const requiredKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BOT_SERVICE_ROOM_ID",
  "BOT_SERVICE_TELEGRAM_CHAT_ID",
  "BOT_SERVICE_OWNER_TELEGRAM_USER_ID",
  "BOT_SERVICE_PUBLIC_BASE_URL",
  "BOT_SERVICE_PLATOON_BOT_TOKEN",
  "BOT_SERVICE_CLAUDE_BOT_TOKEN",
  "BOT_SERVICE_CODEX_BOT_TOKEN",
  "BOT_SERVICE_AUDITOR_BOT_TOKEN",
  "BOT_SERVICE_PLATOON_WEBHOOK_SECRET",
  "BOT_SERVICE_CLAUDE_WEBHOOK_SECRET",
  "BOT_SERVICE_CODEX_WEBHOOK_SECRET",
  "BOT_SERVICE_AUDITOR_WEBHOOK_SECRET",
  "LOCAL_GATEWAY_ALLOWED_ROOTS",
  "LOCAL_GATEWAY_ALLOWED_ADAPTERS"
];

test("operation env template contains required keys", () => {
  for (const key of requiredKeys) {
    assert.match(text, new RegExp(`^${key}=`, "m"));
  }
});

test("operation env template does not include raw token-shaped secrets", () => {
  assert.equal(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/.test(text), false);
  assert.equal(/\bservice_role_[A-Za-z0-9_-]{16,}\b/.test(text), false);
});
