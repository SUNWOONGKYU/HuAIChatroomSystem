import assert from "node:assert/strict";
import test from "node:test";
import { validateOperationEnv } from "./verify-operation-env.mjs";

test("accepts complete production operation env", () => {
  assert.deepEqual(validateOperationEnv(sampleEnv()), []);
});

test("rejects missing bot tokens and invalid gateway adapter", () => {
  const env = sampleEnv();
  delete env.BOT_SERVICE_AUDITOR_BOT_TOKEN;
  env.LOCAL_GATEWAY_ALLOWED_ADAPTERS = "codex,solar";
  env.BOT_SERVICE_OUTBOX_POLL_MS = "0";

  assert.deepEqual(validateOperationEnv(env), [
    "missing-env:BOT_SERVICE_AUDITOR_BOT_TOKEN",
    "invalid-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS:solar",
    "invalid-env:BOT_SERVICE_OUTBOX_POLL_MS"
  ]);
});

test("rejects missing webhook secret and duplicate role credentials", () => {
  const env = sampleEnv();
  delete env.BOT_SERVICE_CODEX_WEBHOOK_SECRET;
  env.BOT_SERVICE_AUDITOR_BOT_TOKEN = env.BOT_SERVICE_PLATOON_BOT_TOKEN;
  env.BOT_SERVICE_AUDITOR_WEBHOOK_SECRET = env.BOT_SERVICE_PLATOON_WEBHOOK_SECRET;

  assert.deepEqual(validateOperationEnv(env), [
    "missing-env:BOT_SERVICE_CODEX_WEBHOOK_SECRET",
    "duplicate-env:BOT_SERVICE_BOT_TOKEN:BOT_SERVICE_PLATOON_BOT_TOKEN:BOT_SERVICE_AUDITOR_BOT_TOKEN",
    "duplicate-env:BOT_SERVICE_WEBHOOK_SECRET:BOT_SERVICE_PLATOON_WEBHOOK_SECRET:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET"
  ]);
});

function sampleEnv() {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010",
    BOT_SERVICE_PLATOON_BOT_TOKEN: "test-platoon-token",
    BOT_SERVICE_CLAUDE_BOT_TOKEN: "test-claude-token",
    BOT_SERVICE_CODEX_BOT_TOKEN: "test-codex-token",
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token",
    BOT_SERVICE_PLATOON_WEBHOOK_SECRET: "test-platoon-secret",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "test-claude-secret",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "test-codex-secret",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "test-auditor-secret",
    BOT_SERVICE_OUTBOX_ENABLED: "true",
    BOT_SERVICE_OUTBOX_POLL_MS: "1000",
    LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem;C:\\tmp",
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code",
    LOCAL_GATEWAY_ALLOW_NETWORK: "false",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "600000"
  };
}