import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_MESSAGE_TEXT,
  buildBoardMessagePayload,
  needsBoardPin
} from "./pin-room-board-message.mjs";

const BOT_ID = 8900591933;

test("고정된 게 없으면 고정한다", () => {
  assert.equal(needsBoardPin(undefined, BOT_ID), true);
  assert.equal(needsBoardPin(null, BOT_ID), true);
});

test("우리가 올린 작업판이 이미 고정돼 있으면 다시 만들지 않는다", () => {
  // 이걸 놓치면 실행할 때마다 방에 작업판 메시지가 하나씩 더 쌓인다.
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

test("우리 봇이 올렸어도 작업판이 아닌 메시지면 우리 것으로 보지 않는다", () => {
  const pinned = { from: { id: BOT_ID }, text: "작업 3건이 완료됐습니다" };
  assert.equal(needsBoardPin(pinned, BOT_ID), true);
});

test("botId 가 문자열로 와도 같게 판정한다", () => {
  const pinned = { from: { id: BOT_ID }, text: BOARD_MESSAGE_TEXT };
  assert.equal(needsBoardPin(pinned, String(BOT_ID)), false);
});

test("고정 메시지 링크에 그 방의 roomId 가 실린다", () => {
  // 방마다 다른 링크여야 한다. 하나라도 섞이면 다른 방 작업판이 열린다.
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
