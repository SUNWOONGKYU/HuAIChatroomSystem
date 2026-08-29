import test from "node:test";
import assert from "node:assert/strict";
import { TelegramUpdateEnvelope } from "../../contracts/src/index.js";
import { renderOwnerActionRedirect } from "../src/index.js";

function envelope(messageText?: string, callbackData?: string): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope(
    "bot-leader", "leader_bot", "leader", "update-1", "chat-1", "thread-1", "owner-1",
    false, messageText, undefined, callbackData, "callback-1"
  );
}

test("Telegram owner command is redirected without a state-changing event", () => {
  const result = renderOwnerActionRedirect({
    kind: "command",
    envelope: envelope("/approve task-1"),
    command: { name: "/approve", args: ["task-1"] }
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events, []);
  assert.equal(result.outbox[0]?.payload.ownerActionRedirect, true);
});

test("Telegram owner callback is redirected without a state-changing event", () => {
  const result = renderOwnerActionRedirect({
    kind: "callback",
    envelope: envelope(undefined, "task:task-1:final_approve"),
    callback: { entity: "task", entityId: "task-1", action: "final_approve" }
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.events, []);
  assert.match(String(result.outbox[0]?.payload.text), /협업 운영센터/);
});
