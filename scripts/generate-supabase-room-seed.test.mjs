import assert from "node:assert/strict";
import test from "node:test";
import { generateSupabaseRoomSeed } from "./generate-supabase-room-seed.mjs";

test("generates idempotent room seed without raw bot token values", () => {
  const sql = generateSupabaseRoomSeed(sampleEnv());

  assert.match(sql, /insert into huai_rooms/);
  assert.match(sql, /insert into huai_room_members/);
  assert.equal((sql.match(/insert into huai_ai_actors/g) ?? []).length, 4);
  assert.equal((sql.match(/insert into huai_telegram_bots/g) ?? []).length, 4);
  assert.match(sql, /env:BOT_SERVICE_PLATOON_BOT_TOKEN/);
  assert.match(sql, /env:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET/);
  assert.equal(sql.includes("test-platoon-token"), false);
  assert.equal(sql.includes("test-auditor-token"), false);
  assert.match(sql, /on conflict \(room_id\) do update/);
});

test("uses stable ids for repeated generation", () => {
  assert.equal(generateSupabaseRoomSeed(sampleEnv()), generateSupabaseRoomSeed(sampleEnv()));
});

test("rejects missing and invalid Telegram identifiers", () => {
  assert.throws(() => generateSupabaseRoomSeed({}), /missing-env:BOT_SERVICE_ROOM_ID/);
  assert.throws(
    () => generateSupabaseRoomSeed({ ...sampleEnv(), BOT_SERVICE_TELEGRAM_CHAT_ID: "chat-name" }),
    /invalid-env:BOT_SERVICE_TELEGRAM_CHAT_ID/
  );
});

function sampleEnv() {
  return {
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010",
    BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
    BOT_SERVICE_OWNER_TELEGRAM_USER_ID: "123456789",
    BOT_SERVICE_EXECUTION_GATEWAY_ID: "gateway-local",
    BOT_SERVICE_EXECUTION_PROJECT_PATH: "C:/Dev/HuAIChatroomSystem",
    BOT_SERVICE_PLATOON_BOT_USERNAME: "platoon_live_bot",
    BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
    BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
    BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot",
    BOT_SERVICE_PLATOON_BOT_TOKEN: "test-platoon-token",
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token"
  };
}