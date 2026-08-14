import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  buildBotProfilePhotoPlan,
  formatBotProfilePhotoPlan,
  formatBotProfilePhotoResults,
  setTelegramBotProfilePhotos
} from "./apply-telegram-bot-profile-photos.mjs";

const env = {
  BOT_SERVICE_PLATOON_BOT_TOKEN: "111111:PLATOON_TOKEN_VALUE",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "222222:CLAUDE_TOKEN_VALUE",
  BOT_SERVICE_CODEX_BOT_TOKEN: "333333:CODEX_TOKEN_VALUE",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "444444:AUDITOR_TOKEN_VALUE",
  BOT_SERVICE_PLATOON_BOT_USERNAME: "leader_chatroom_bot",
  BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_chatroom1_bot",
  BOT_SERVICE_CODEX_BOT_USERNAME: "codex_chatroom_bot",
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "audit_chatroom_bot"
};

test("builds role profile photo plan without formatting token values", () => {
  const plan = buildBotProfilePhotoPlan(env, "C:/work");

  assert.equal(plan.length, 4);
  assert.equal(plan[0].username, "leader_chatroom_bot");
  assert.equal(plan[0].filePath.endsWith("leaderbot-deep-orange.jpg"), true);
  const formatted = formatBotProfilePhotoPlan(plan);
  assert.match(formatted, /PLAN platoon username=leader_chatroom_bot file=leaderbot-deep-orange.jpg/);
  assert.equal(formatted.includes("PLATOON_TOKEN_VALUE"), false);
});

test("sets profile photos for all bots and masks formatted results", async () => {
  const root = await makeProfilePhotoFixtureRoot();
  const calls = [];
  const results = await setTelegramBotProfilePhotos(env, async (url, init) => {
    const body = init.body;
    calls.push({
      url: String(url),
      photo: body.get("photo"),
      fileName: body.get("profile_photo")?.name
    });
    return jsonResponse(200, { ok: true, result: true });
  }, root);

  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.includes("111111:PLATOON_TOKEN_VALUE"), true);
  assert.deepEqual(JSON.parse(calls[0].photo), { type: "static", photo: "attach://profile_photo" });
  assert.equal(calls[0].fileName, "leaderbot-deep-orange.jpg");
  const formatted = formatBotProfilePhotoResults(results);
  assert.match(formatted, /OK platoon username=leader_chatroom_bot/);
  assert.equal(formatted.includes("PLATOON_TOKEN_VALUE"), false);
});

async function makeProfilePhotoFixtureRoot() {
  const root = join(tmpdir(), `huai-profile-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dir = join(root, "assets", "telegram-bot-profiles");
  await mkdir(dir, { recursive: true });
  for (const name of ["leaderbot-deep-orange.jpg", "claudebot-orange.jpg", "codexbot-purple.jpg", "auditbot-gold.jpg"]) {
    await writeFile(join(dir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }
  return root;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
