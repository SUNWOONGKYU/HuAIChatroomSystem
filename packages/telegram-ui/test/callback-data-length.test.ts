import test from "node:test";
import assert from "node:assert/strict";
import { parseTelegramCallbackData } from "../../contracts/src/index.js";
import { buildCompletionKeyboard, buildProposalKeyboard, buildTaskDecisionKeyboard, buildWorkProposalMessage } from "../src/index.js";

test("all action keyboards use one compact Korean-label row", () => {
  const keyboards = [
    buildProposalKeyboard("proposal-1"),
    buildTaskDecisionKeyboard("task-1"),
    buildCompletionKeyboard("task-1")
  ];

  assert.deepEqual(keyboards.map((keyboard) => keyboard.inline_keyboard.length), [1, 1, 1]);
  assert.deepEqual(keyboards.map((keyboard) => keyboard.inline_keyboard[0]?.map((button) => button.text)), [
    ["실행", "수정", "반려"],
    ["승인", "반려", "취소"],
    ["검증", "보완", "완료"]
  ]);
});

test("completion keyboard callback_data stays within Telegram 64-byte limit", () => {
  const keyboard = buildCompletionKeyboard("proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8");
  const buttons = keyboard.inline_keyboard.flat();

  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64, button.callback_data);
  }
});

test("short completion callback aliases parse to canonical actions", () => {
  assert.deepEqual(parseTelegramCallbackData("task:proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8:rv"), {
    entity: "task",
    entityId: "proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8",
    action: "reverify"
  });
  assert.deepEqual(parseTelegramCallbackData("task:proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8:rr"), {
    entity: "task",
    entityId: "proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8",
    action: "request_revision"
  });
  assert.deepEqual(parseTelegramCallbackData("task:proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8:fa"), {
    entity: "task",
    entityId: "proposal_e066640b-b1f5-4aad-ad9e-b42a6f3654e8",
    action: "final_approve"
  });
});

test("proposal messages use summarized work categories instead of raw prompts", () => {
  const message = buildWorkProposalMessage({ kind: "new_task", title: "\uC7A5\uC560 \uC6D0\uC778 \uC218\uC815" });

  assert.equal(message.includes("\uC791\uC5C5 \uC81C\uC548"), true);
  assert.equal(message.includes("\uC791\uC5C5: \uC7A5\uC560 \uC6D0\uC778 \uC218\uC815"), true);
  assert.equal(message.includes("\uC6D0\uC778\uC744 \uD655\uC778\uD558\uACE0 \uD544\uC694\uD55C \uCF54\uB4DC\uC640 \uC124\uC815\uC744 \uBC14\uB85C \uBCF4\uC815\uD569\uB2C8\uB2E4"), true);
  assert.equal(message.includes("@leader_chatroom_bot"), false);
});
