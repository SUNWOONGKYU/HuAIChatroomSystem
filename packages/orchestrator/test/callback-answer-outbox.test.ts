import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { handleTelegramInput } from "../src/index.js";

test("callback outbox preserves callback query id for Telegram answer", () => {
  const envelope = new TelegramUpdateEnvelope(
    "bot-leader",
    "leader_bot",
    "leader",
    "77",
    "1001",
    "7001",
    "2001",
    false,
    undefined,
    "task:task-1:reverify",
    "callback-1"
  );
  const result = handleTelegramInput(
    { kind: "callback", envelope, callback: { entity: "task", entityId: "task-1", action: "reverify" } },
    {
      memberships: [
        {
          telegramChatId: "1001",
          telegramUserId: "2001",
          role: "owner",
          permissions: [],
          status: "active"
        }
      ]
    },
    {
      makeId(prefix) {
        return `${prefix}-1`;
      },
      now() {
        return "2026-08-10T00:00:00.000Z";
      }
    }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.outbox[0]?.payload.callbackQueryId, "callback-1");
});
