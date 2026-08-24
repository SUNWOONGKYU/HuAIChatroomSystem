import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBotCommandPlan,
  formatBotCommandPlan,
  formatBotCommandResults,
  setTelegramBotCommands
} from "./set-telegram-bot-commands.mjs";

const env = {
  BOT_SERVICE_LEADER_BOT_TOKEN: "111111:LEADER_TOKEN_VALUE",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "222222:CLAUDE_TOKEN_VALUE",
  BOT_SERVICE_CODEX_BOT_TOKEN: "333333:CODEX_TOKEN_VALUE",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "444444:AUDITOR_TOKEN_VALUE",
  BOT_SERVICE_LEADER_BOT_USERNAME: "leader_chatroom_bot",
  BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_chatroom1_bot",
  BOT_SERVICE_CODEX_BOT_USERNAME: "codex_chatroom_bot",
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "audit_chatroom_bot"
};

test("builds role command plan without formatting token values", () => {
  const plan = buildBotCommandPlan(env);

  assert.equal(plan.length, 4);
  assert.equal(plan[0].username, "leader_chatroom_bot");
  assert.deepEqual(plan[0].commands.map((item) => item.command), ["newtask", "tasks", "task", "search", "trace", "approve", "reject", "verify", "done", "cancel", "help"]);
  assert.deepEqual(plan[1].commands.map((item) => item.command), ["help"]);
  assert.equal(formatBotCommandPlan(plan).includes("LEADER_TOKEN_VALUE"), false);
});

test("sets commands for all bots and masks formatted results", async () => {
  const calls = [];
  const results = await setTelegramBotCommands(env, async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return jsonResponse(200, { ok: true, result: true });
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.includes("111111:LEADER_TOKEN_VALUE"), true);
  assert.equal(calls[0].body.scope.type, "all_group_chats");
  assert.equal(calls[0].body.commands[0].command, "newtask");
  const formatted = formatBotCommandResults(results);
  assert.match(formatted, /OK leader username=leader_chatroom_bot commands=11/);
  assert.equal(formatted.includes("LEADER_TOKEN_VALUE"), false);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
