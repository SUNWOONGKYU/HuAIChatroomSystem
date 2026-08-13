import assert from "node:assert/strict";
import test from "node:test";
import { discoverTelegramIds, formatDiscoveredTelegramIds, summarizeUpdates } from "./discover-telegram-ids.mjs";

test("summarizes unique chat and human user ids from Telegram updates", () => {
  const summary = summarizeUpdates([
    {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: -100123, type: "supergroup", title: "Project Room" },
        from: { id: 2001, is_bot: false, username: "owner" }
      }
    },
    {
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: -100123, type: "supergroup", title: "Project Room" },
        from: { id: 9999, is_bot: true, username: "bot" }
      }
    }
  ]);

  assert.deepEqual(summary.chats.map((chat) => chat.telegramChatId), ["-100123"]);
  assert.deepEqual(summary.users.map((user) => user.telegramUserId), ["2001"]);
});

test("calls getUpdates without printing token values", async () => {
  const calls = [];
  const summary = await discoverTelegramIds(
    { BOT_SERVICE_PLATOON_BOT_TOKEN: "tok-platoon" },
    async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return jsonResponse(200, {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              chat: { id: -100123, type: "group", title: "Project Room" },
              from: { id: 2001, is_bot: false, username: "owner" }
            }
          }
        ]
      });
    }
  );

  assert.equal(calls[0].url, "https://api.telegram.org/bottok-platoon/getUpdates");
  assert.deepEqual(calls[0].body, { allowed_updates: ["message", "callback_query"] });
  const formatted = formatDiscoveredTelegramIds(summary);
  assert.equal(formatted.includes("tok-platoon"), false);
  assert.equal(formatted.includes("telegram_chat_id=-100123"), true);
  assert.equal(formatted.includes("telegram_user_id=2001"), true);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
