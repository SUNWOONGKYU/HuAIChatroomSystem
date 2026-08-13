import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServiceStartupPreflight,
  formatServiceStartupPreflight
} from "./service-startup-preflight.mjs";

const completeEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
  BOT_SERVICE_ROOM_ID: "11111111-1111-4111-8111-111111111111",
  BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
  BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com",
  BOT_SERVICE_PORT: "8787",
  BOT_SERVICE_PLATOON_BOT_TOKEN: "tok-platoon",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "tok-claude",
  BOT_SERVICE_CODEX_BOT_TOKEN: "tok-codex",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "tok-auditor",
  BOT_SERVICE_PLATOON_WEBHOOK_SECRET: "sec-platoon",
  BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "sec-claude",
  BOT_SERVICE_CODEX_WEBHOOK_SECRET: "sec-codex",
  BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "sec-auditor",
  LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem",
  LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code",
  LOCAL_GATEWAY_HEALTH_PORT: "8797"
};

test("builds startup commands and health checks for both operation services", () => {
  const preflight = buildServiceStartupPreflight(completeEnv);

  assert.equal(preflight.ready, true);
  assert.deepEqual(preflight.commands, [
    "npm run build",
    "node dist/apps/bot-service/src/cli.js",
    "node dist/apps/local-gateway/src/cli.js"
  ]);
  assert.deepEqual(preflight.checks, [
    "http://127.0.0.1:8787/healthz",
    "http://127.0.0.1:8797/healthz",
    "http://127.0.0.1:8797/readyz"
  ]);
});

test("blocks startup when required env or port values are invalid", () => {
  const preflight = buildServiceStartupPreflight({ BOT_SERVICE_PORT: "not-a-port" });

  assert.equal(preflight.ready, false);
  assert.equal(preflight.errors.includes("invalid-env:BOT_SERVICE_PORT"), true);
  assert.equal(preflight.errors.some((error) => error.startsWith("missing-env:SUPABASE_URL")), true);
});

test("formats startup preflight without leaking token or secret values", () => {
  const formatted = formatServiceStartupPreflight(buildServiceStartupPreflight(completeEnv));

  assert.match(formatted, /Service startup preflight: READY/);
  assert.equal(formatted.includes("tok-platoon"), false);
  assert.equal(formatted.includes("sec-platoon"), false);
});
