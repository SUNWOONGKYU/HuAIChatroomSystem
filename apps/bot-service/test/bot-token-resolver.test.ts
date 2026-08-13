import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTelegramBotTokenResolverFromEnv,
  parseTelegramBotTokenSecretRefs
} from "../src/bot-token-resolver.js";

test("resolves four role bot tokens from documented env names", async () => {
  const resolver = buildTelegramBotTokenResolverFromEnv(baseTokenEnv());

  assert.equal(await resolver.resolveBotToken("platoon_leader"), "test-platoon-token");
  assert.equal(await resolver.resolveBotToken("claude_leader"), "test-claude-token");
  assert.equal(await resolver.resolveBotToken("codex_leader"), "test-codex-token");
  assert.equal(await resolver.resolveBotToken("auditor"), "test-auditor-token");
});

test("supports explicit role to token secret ref JSON", async () => {
  const env = {
    BOT_SERVICE_BOT_TOKEN_SECRET_REFS_JSON: JSON.stringify({
      platoon_leader: "env:TG_PLATOON_TOKEN",
      claude_leader: "env:TG_CLAUDE_TOKEN",
      codex_leader: "env:TG_CODEX_TOKEN",
      auditor: "env:TG_AUDITOR_TOKEN"
    }),
    TG_PLATOON_TOKEN: "test-platoon-token",
    TG_CLAUDE_TOKEN: "test-claude-token",
    TG_CODEX_TOKEN: "test-codex-token",
    TG_AUDITOR_TOKEN: "test-auditor-token"
  };

  assert.deepEqual(parseTelegramBotTokenSecretRefs(env), {
    platoon_leader: "env:TG_PLATOON_TOKEN",
    claude_leader: "env:TG_CLAUDE_TOKEN",
    codex_leader: "env:TG_CODEX_TOKEN",
    auditor: "env:TG_AUDITOR_TOKEN"
  });

  const resolver = buildTelegramBotTokenResolverFromEnv(env);
  assert.equal(await resolver.resolveBotToken("auditor"), "test-auditor-token");
});

test("rejects a unified bot token reused by multiple roles", () => {
  assert.throws(
    () => buildTelegramBotTokenResolverFromEnv({
      ...baseTokenEnv(),
      BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-platoon-token"
    }),
    /duplicate-telegram-bot-token:auditor/
  );
});

test("rejects missing role secret refs without exposing token values", () => {
  const secretRefs = {
    platoon_leader: "env:TG_PLATOON_TOKEN",
    claude_leader: "env:TG_CLAUDE_TOKEN",
    codex_leader: "env:TG_CODEX_TOKEN"
  };

  assert.throws(
    () => buildTelegramBotTokenResolverFromEnv({
      BOT_SERVICE_BOT_TOKEN_SECRET_REFS_JSON: JSON.stringify(secretRefs),
      TG_PLATOON_TOKEN: "test-platoon-token",
      TG_CLAUDE_TOKEN: "test-claude-token",
      TG_CODEX_TOKEN: "test-codex-token"
    }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /missing-telegram-bot-token-secret-ref:auditor/);
      assert.equal((error as Error).message.includes("platoon-token"), false);
      return true;
    }
  );
});

function baseTokenEnv(): NodeJS.ProcessEnv {
  return {
    BOT_SERVICE_PLATOON_BOT_TOKEN: "test-platoon-token",
    BOT_SERVICE_CLAUDE_BOT_TOKEN: "test-claude-token",
    BOT_SERVICE_CODEX_BOT_TOKEN: "test-codex-token",
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token"
  };
}


