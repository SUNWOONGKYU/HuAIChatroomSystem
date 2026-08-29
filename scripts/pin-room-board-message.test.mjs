import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_MESSAGE_TEXT,
  boardPinNeedsRewording,
  buildBoardMessagePayload,
  needsBoardPin
} from "./pin-room-board-message.mjs";

const BOT_ID = 8900591933;

test("고정된 게 없으면 고정한다", () => {
  assert.equal(needsBoardPin(undefined, BOT_ID), true);
  assert.equal(needsBoardPin(null, BOT_ID), true);
});

test("우리가 올린 협업 운영센터가 이미 고정돼 있으면 다시 만들지 않는다", () => {
  // 이걸 놓치면 실행할 때마다 방에 협업 운영센터 메시지가 하나씩 더 쌓인다.
  const pinned = { from: { id: BOT_ID }, text: BOARD_MESSAGE_TEXT };
  assert.equal(needsBoardPin(pinned, BOT_ID), false);
});

test("방장이 고정해 둔 다른 메시지는 우리 것으로 보지 않는다", () => {
  // 판정이 틀리면 호출부가 방장의 공지를 덮어쓴다.
  const pinned = { from: { id: 52485734 }, text: "이번 주 회의는 목요일" };
  assert.equal(needsBoardPin(pinned, BOT_ID), true);
});

test("다른 봇이 올린 같은 문구도 우리 것으로 보지 않는다", () => {
  const pinned = { from: { id: 111111 }, text: BOARD_MESSAGE_TEXT };
  assert.equal(needsBoardPin(pinned, BOT_ID), true);
});

test("우리 봇이 올렸어도 협업 운영센터가 아닌 메시지면 우리 것으로 보지 않는다", () => {
  const pinned = { from: { id: BOT_ID }, text: "작업 3건이 완료됐습니다" };
  assert.equal(needsBoardPin(pinned, BOT_ID), true);
});

test("botId 가 문자열로 와도 같게 판정한다", () => {
  const pinned = { from: { id: BOT_ID }, text: BOARD_MESSAGE_TEXT };
  assert.equal(needsBoardPin(pinned, String(BOT_ID)), false);
});

test("고정 메시지 링크에 그 방의 roomId 가 실린다", () => {
  // 방마다 다른 링크여야 한다. 하나라도 섞이면 다른 방 협업 운영센터가 열린다.
  const a = buildBoardMessagePayload(-1001, "room-a", "https://t.me/leader_chatroom_bot");
  const b = buildBoardMessagePayload(-1002, "room-b", "https://t.me/leader_chatroom_bot");

  const urlA = a.reply_markup.inline_keyboard[0][0].url;
  const urlB = b.reply_markup.inline_keyboard[0][0].url;

  assert.equal(urlA, "https://t.me/leader_chatroom_bot?startapp=room-a");
  assert.equal(urlB, "https://t.me/leader_chatroom_bot?startapp=room-b");
  assert.equal(a.chat_id, -1001);
  assert.equal(b.chat_id, -1002);
});

test("고정 메시지 본문에는 작업 목록을 싣지 않는다", () => {
  // 목록을 실으면 고정된 순간의 상태가 방 맨 위에 박제돼 낡는다.
  const payload = buildBoardMessagePayload(-1001, "room-a", "https://t.me/leader_chatroom_bot");
  assert.equal(payload.text, BOARD_MESSAGE_TEXT);
  assert.equal(payload.disable_web_page_preview, true);
});

// 이름을 다듬어도 이미 고정된 우리 메시지를 계속 알아봐야 한다.
// 본문 앞부분을 비교하던 시절에는 문구가 바뀌는 순간 남의 메시지로 오인해서,
// 갱신도 못 하고 새로 올리지도 못한 채 옛 문구가 방 맨 위에 그대로 남았다.
test("문구가 바뀌어도 우리가 고정한 협업 운영센터를 알아본다", () => {
  const oldWording = { from: { id: BOT_ID }, text: "📋 작업판 — 이 방의 작업과 승인 대기를 한 화면에서 봅니다." };
  assert.equal(needsBoardPin(oldWording, BOT_ID), false, "새로 올리면 방에 같은 메시지가 쌓인다");
});

test("문구가 낡았으면 새로 올리지 않고 본문만 고친다", () => {
  const oldWording = { from: { id: BOT_ID }, text: "📋 작업판 — 이 방의 작업과 승인 대기를 한 화면에서 봅니다." };
  assert.equal(boardPinNeedsRewording(oldWording, BOT_ID), true);
});

test("문구가 최신이면 아무것도 하지 않는다", () => {
  const current = { from: { id: BOT_ID }, text: BOARD_MESSAGE_TEXT };
  assert.equal(boardPinNeedsRewording(current, BOT_ID), false);
});

test("남이 고정한 메시지는 문구를 고치지 않는다", () => {
  const notOurs = { from: { id: 52485734 }, text: "📋 이번 주 일정" };
  assert.equal(boardPinNeedsRewording(notOurs, BOT_ID), false);
});
