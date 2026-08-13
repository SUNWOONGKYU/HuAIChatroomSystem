import assert from "node:assert/strict";
import test from "node:test";
import { buildBotServiceRuntimeFromEnv } from "../src/local-runtime.js";

test("uses local runtime when Supabase env is absent", () => {
  const runtime = buildBotServiceRuntimeFromEnv(baseEnv());

  assert.equal(runtime.storeKind, "local");
});

test("uses Supabase runtime when required Supabase env is present", () => {
  const runtime = buildBotServiceRuntimeFromEnv({
    ...baseEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010"
  });

  assert.equal(runtime.storeKind, "supabase");
  assert.equal(typeof runtime.outboxStore?.leasePending, "function");
});


test("fails loudly when Supabase env is partially configured", () => {
  assert.throws(
    () => buildBotServiceRuntimeFromEnv({
      ...baseEnv(),
      SUPABASE_URL: "https://example.supabase.co"
    }),
    /missing-env:SUPABASE_SERVICE_ROLE_KEY/
  );
});
function baseEnv(): NodeJS.ProcessEnv {
  return {
    BOT_SERVICE_ALLOWED_CHAT_IDS: "1001",
    BOT_SERVICE_PLATOON_BOT_USERNAME: "platoon_bot",
    BOT_SERVICE_PLATOON_BOT_ID: "00000000-0000-0000-0000-000000000001",
    BOT_SERVICE_PLATOON_WEBHOOK_SECRET: "platoon-secret",
    BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_bot",
    BOT_SERVICE_CLAUDE_BOT_ID: "00000000-0000-0000-0000-000000000002",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "claude-secret",
    BOT_SERVICE_CODEX_BOT_USERNAME: "codex_bot",
    BOT_SERVICE_CODEX_BOT_ID: "00000000-0000-0000-0000-000000000003",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "codex-secret",
    BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_bot",
    BOT_SERVICE_AUDITOR_BOT_ID: "00000000-0000-0000-0000-000000000004",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "auditor-secret"
  };
}
