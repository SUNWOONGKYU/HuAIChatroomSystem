import assert from "node:assert/strict";
import test from "node:test";
import { generateWebhookCommands } from "./generate-telegram-webhook-commands.mjs";

test("generates four role webhook commands without embedding token values", () => {
  const commands = generateWebhookCommands({
    BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com/",
    BOT_SERVICE_PLATOON_BOT_USERNAME: "platoon_live_bot",
    BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
    BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
    BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot"
  });

  assert.equal(commands.length, 4);
  assert.equal(commands[0].includes("https://ops.example.com/telegram/webhook/platoon_live_bot"), true);
  assert.equal(commands[0].includes("$BOT_SERVICE_PLATOON_BOT_TOKEN"), true);
  assert.equal(commands[0].includes("secret_token"), true);
  assert.equal(commands.join("\n").includes("123456:SECRET"), false);
});

test("requires public base URL", () => {
  assert.throws(() => generateWebhookCommands({}), /missing-env:BOT_SERVICE_PUBLIC_BASE_URL/);
});
