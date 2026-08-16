// "작업 현황판 열기" 버튼(Direct Link Mini App) 빌더 단위 테스트.
// web_app 타입 인라인 버튼은 core.telegram.org/bots/api 문서상 "Available only in
// private chats between a user and the bot" 라 그룹에서 안 눌린다 — 그래서 평범한 url
// 버튼으로 t.me 딥링크(core.telegram.org/bots/webapps, "Direct Link Mini App")를 연다.
import assert from "node:assert/strict";
import test from "node:test";
import { buildMiniAppDirectLink, buildMiniAppOpenKeyboard, parseMiniAppStartParam } from "../src/index.js";

test("buildMiniAppDirectLink 는 베이스 링크에 ?startapp=<roomId> 를 붙인다", () => {
  const link = buildMiniAppDirectLink("https://t.me/leader_chatroom_bot/board", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(link, "https://t.me/leader_chatroom_bot/board?startapp=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

test("buildMiniAppDirectLink 는 베이스 링크에 이미 쿼리스트링이 있으면 & 로 이어붙인다", () => {
  const link = buildMiniAppDirectLink("https://t.me/leader_chatroom_bot/board?mode=compact", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(link, "https://t.me/leader_chatroom_bot/board?mode=compact&startapp=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

test("buildMiniAppOpenKeyboard 는 url 버튼 하나짜리 인라인 키보드를 만든다 (web_app 아님, callback_data 없음)", () => {
  const keyboard = buildMiniAppOpenKeyboard({ directLinkBaseUrl: "https://t.me/leader_chatroom_bot/board", roomId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

  assert.equal(keyboard.inline_keyboard.length, 1);
  assert.equal(keyboard.inline_keyboard[0]?.length, 1);
  const button = keyboard.inline_keyboard[0]?.[0];
  assert.equal(button?.text, "작업 현황판 열기");
  assert.equal(button?.url, "https://t.me/leader_chatroom_bot/board?startapp=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  // Telegram 제약: 인라인 버튼 하나에 callback_data 와 url(web_app 포함)을 같이 못 넣는다.
  // 타입 자체가 url 만 갖고 있어서 만들 수가 없지만, 직렬화 결과에도 안 섞이는지 구조적으로 확인한다.
  assert.equal("callback_data" in (button as object), false);
  assert.equal("web_app" in (button as object), false);
});

test("서로 다른 room 은 서로 다른 startapp 값을 갖는다 (방 격리)", () => {
  const keyboardA = buildMiniAppOpenKeyboard({ directLinkBaseUrl: "https://t.me/leader_chatroom_bot/board", roomId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const keyboardB = buildMiniAppOpenKeyboard({ directLinkBaseUrl: "https://t.me/leader_chatroom_bot/board", roomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

  const urlA = keyboardA.inline_keyboard[0]?.[0]?.url ?? "";
  const urlB = keyboardB.inline_keyboard[0]?.[0]?.url ?? "";
  assert.notEqual(urlA, urlB);
  assert.match(urlA, /startapp=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa$/);
  assert.match(urlB, /startapp=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb$/);
});

test("생성된 링크는 https 다", () => {
  const keyboard = buildMiniAppOpenKeyboard({ directLinkBaseUrl: "https://t.me/leader_chatroom_bot/board", roomId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const url = keyboard.inline_keyboard[0]?.[0]?.url ?? "";
  assert.match(url, /^https:\/\//);
});

// 방장 요청 — 방 하나 안에서 주제를 갈라 쓰는데 현황판이 방 전체를 보여주면 주제를 나눈
// 의미가 없다. 주제마다 고정한 현황판은 그 주제 작업만 열어야 한다.
test("현황판 링크에 주제를 실어 보낸다", () => {
  const link = buildMiniAppDirectLink("https://t.me/leader_chatroom_bot/board", "9a477b32-15ed-46e3-b575-9488ff09efb6", "613");

  assert.match(link, /startapp=9a477b32-15ed-46e3-b575-9488ff09efb6__t613$/);
  // Telegram Deep Linking 규격: [A-Za-z0-9_-] 1-64자.
  const startParam = link.split("startapp=")[1] ?? "";
  assert.equal(startParam.length <= 64, true, `startapp 이 64자를 넘었다: ${startParam.length}`);
  assert.match(startParam, /^[A-Za-z0-9_-]+$/);
});

test("주제가 없으면 예전 그대로 방 전체를 연다", () => {
  const link = buildMiniAppDirectLink("https://t.me/leader_chatroom_bot/board", "9a477b32-15ed-46e3-b575-9488ff09efb6");

  assert.match(link, /startapp=9a477b32-15ed-46e3-b575-9488ff09efb6$/);
});

test("실어 보낸 주제를 되돌려 읽는다", () => {
  assert.deepEqual(parseMiniAppStartParam("9a477b32-15ed-46e3-b575-9488ff09efb6__t613"), {
    roomId: "9a477b32-15ed-46e3-b575-9488ff09efb6",
    messageThreadId: "613"
  });
  assert.deepEqual(parseMiniAppStartParam("9a477b32-15ed-46e3-b575-9488ff09efb6"), {
    roomId: "9a477b32-15ed-46e3-b575-9488ff09efb6"
  });
});
