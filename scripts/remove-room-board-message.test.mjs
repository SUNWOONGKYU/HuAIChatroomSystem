import assert from "node:assert/strict";
import test from "node:test";
import { isRemovableBoardMessage } from "./remove-room-board-message.mjs";
import { BOARD_MESSAGE_TEXT, LEGACY_BOARD_MESSAGE_TEXTS } from "./pin-room-board-message.mjs";

const BOT_ID = 8900591933;

// 운영 방에 실제로 고정되어 있는 것은 최신 문구가 아니라 옛 문구다. 최신 문구만 지우면
// 이 스크립트는 라이브에서 한 건도 못 지운다.
test("옛 문구로 고정된 현황판도 삭제 대상으로 잡는다", () => {
  for (const legacy of LEGACY_BOARD_MESSAGE_TEXTS) {
    assert.equal(isRemovableBoardMessage({ from: { id: BOT_ID }, text: legacy }, BOT_ID), true, legacy);
  }
});

test("삭제 대상은 우리 봇이 만든 협업 운영센터 고정 메시지로 제한한다", () => {
  assert.equal(isRemovableBoardMessage({ from: { id: BOT_ID }, text: BOARD_MESSAGE_TEXT }, BOT_ID), true);
  assert.equal(isRemovableBoardMessage({ from: { id: BOT_ID }, text: `${BOARD_MESSAGE_TEXT} 추가 안내` }, BOT_ID), false);
  assert.equal(isRemovableBoardMessage({ from: { id: BOT_ID }, text: "📋 다른 공지" }, BOT_ID), false);
  assert.equal(isRemovableBoardMessage({ from: { id: 111 }, text: BOARD_MESSAGE_TEXT }, BOT_ID), false);
  assert.equal(isRemovableBoardMessage({ from: { id: BOT_ID }, text: "공지" }, BOT_ID), false);
  assert.equal(isRemovableBoardMessage(undefined, BOT_ID), false);
});
