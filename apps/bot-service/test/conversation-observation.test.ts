import assert from "node:assert/strict";
import test from "node:test";
import { routeTelegramWebhookSafe, type BotServiceConfig } from "../src/index.js";
import { handleTelegramInput, type RoomAuthorizationContext } from "../../../packages/orchestrator/src/index.js";
import { isAddressedToBot, TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";

// 이 시스템은 사람 여럿 + AI 여럿이 한 방에서 같이 일하는 협업 공간이다.
// 사람끼리의 대화는 들리되 작업이 되어서는 안 된다.
// 이 구분이 없으면 Telegram Group Privacy 를 끄는 순간 잡담 한 마디마다 승인 버튼이 쌓인다.

const CHAT = "-1001234567890";
const BOT = "leader_chatroom_bot";
const SECRET = "secret";

test("사람끼리의 대화는 관찰로 분류된다", () => {
  const decision = accept(message(1, "2", "결제 실패율이 올라간 것 같아"));
  assert.equal(decision.kind, "accepted");
  assert.equal(decision.kind === "accepted" ? decision.input.kind : undefined, "observation");
});

test("소대장을 부르면 소대장 호출로 분류된다", () => {
  const decision = accept(message(2, "1", "@leader_chatroom_bot 정리해서 진행해줘"));
  assert.equal(decision.kind === "accepted" ? decision.input.kind : undefined, "message");
});

test("명령은 언제나 소대장 호출이다", () => {
  const decision = accept(message(3, "1", "/tasks"));
  assert.equal(decision.kind === "accepted" ? decision.input.kind : undefined, "command");
});

test("관찰은 어떤 작업도 만들지 않는다", () => {
  const decision = accept(message(4, "2", "재시도 횟수도 같이 봐야 할 것 같아"));
  const result = handleTelegramInput(decision.kind === "accepted" ? decision.input : (undefined as never), authorization(), ports());
  assert.equal(result.accepted, true);
  assert.equal(result.accepted ? result.events.length : -1, 0, "관찰은 이벤트를 만들지 않는다");
  assert.equal(result.accepted ? result.outbox.length : -1, 0, "관찰은 메시지를 보내지 않는다");
});

test("4턴 대화에서 제안은 소대장을 부른 1회만 생성된다", () => {
  const conversation: Array<[string, string]> = [
    ["2", "결제 실패율이 올라간 것 같아 확인이 필요해"],
    ["1", "맞아 어제부터야. 재시도 로직 쪽 같은데"],
    ["2", "그럼 재시도 횟수랑 타임아웃 같이 봐야겠다"],
    ["1", "@leader_chatroom_bot 위에 논의한 대로 정리해서 진행해줘"]
  ];
  const shared = ports();
  let observations = 0;
  let proposals = 0;

  conversation.forEach(([user, text], index) => {
    const decision = accept(message(10 + index, user, text));
    if (decision.kind !== "accepted") throw new Error("accepted 여야 한다");
    if (decision.input.kind === "observation") observations += 1;
    const result = handleTelegramInput(decision.input, authorization(), shared);
    if (result.accepted && result.events.some((event) => event.eventType === "proposal_created")) proposals += 1;
  });

  assert.equal(observations, 3, "사람끼리의 3턴은 관찰이어야 한다");
  assert.equal(proposals, 1, "제안은 소대장을 부른 1회만 생성되어야 한다");
});

test("동료도 소대장을 부를 수 있다 (심의는 여럿, 승인은 방장)", () => {
  const decision = accept(message(20, "2", "@leader_chatroom_bot 이 건 정리해줘"));
  const result = handleTelegramInput(decision.kind === "accepted" ? decision.input : (undefined as never), authorization(), ports());
  assert.equal(result.accepted, true, "동료의 소대장 호출은 허용된다");
});

test("동료는 승인 버튼을 누를 수 없다", () => {
  const decision = routeTelegramWebhookSafe(BOT, SECRET, {
    update_id: 21,
    callback_query: { id: "cb", from: { id: "2" }, data: "proposal:p1:approve", message: { message_id: 210, chat: { id: CHAT } } }
  }, config());
  const result = handleTelegramInput(decision.kind === "accepted" ? decision.input : (undefined as never), authorization(), ports());
  assert.equal(result.accepted, false);
  assert.equal(result.accepted === false ? result.authorization.allowed : true, false);
});

test("이 봇의 메시지에 답장하면 태그 없이도 이 봇에게 한 말이다", () => {
  const envelope = parse({
    text: "그럼 그렇게 해줘",
    reply_to_message: { message_id: 299, text: "작업 제안입니다", from: { id: "999", is_bot: true, username: BOT } }
  });
  assert.equal(addressed(envelope), true);
});

test("다른 봇의 메시지에 답장한 것은 내 일이 아니다", () => {
  const envelope = parse({
    text: "그거 다시 해봐",
    reply_to_message: { message_id: 299, text: "실행 완료 보고", from: { id: "998", is_bot: true, username: "codex_chatroom_bot" } }
  });
  assert.equal(addressed(envelope), false, "CodexBot 보고에 대한 답장을 소대장이 가로채면 안 된다");
});

test("사람 메시지에 답장한 것은 사람끼리의 대화다", () => {
  const envelope = parse({
    text: "맞아 그렇게 하자",
    reply_to_message: { message_id: 299, text: "재시도 로직 봐야 할 듯", from: { id: "2", is_bot: false, username: "coworker" } }
  });
  assert.equal(addressed(envelope), false);
});

test("다른 봇을 지목한 발화를 소대장이 자기 지시로 처리하지 않는다", () => {
  const envelope = parse({ text: "@codex_chatroom_bot 그거 다시 해봐" });
  assert.equal(addressed(envelope), false, "네 봇이 한 발화를 각자 처리하면 중복 실행된다");
});

test("이름 없는 명령은 소대장이, 이름 붙은 명령은 지목된 봇이 받는다", () => {
  assert.equal(addressed(parse({ text: "/tasks" })), true, "기본 입력 창구는 소대장이다");
  assert.equal(addressed(parse({ text: "/tasks@codex_chatroom_bot" })), false);
  assert.equal(addressed(parse({ text: "/tasks@leader_chatroom_bot" })), true);
});

test("일반 발화는 관찰이다", () => {
  assert.equal(addressed(parse({ text: "오늘 점심 뭐 먹지" })), false);
});

test("태그 없이 이름만 불러도 소대장이 알아듣는다", () => {
  for (const text of [
    "소대장 이거 정리해서 진행해줘",
    "코덱스는 재시도 로직 좀 고쳐줘",
    "클로드는 테스트 쪽 맡아줘",
    "감사관한테 검토해달라고 하자"
  ]) {
    assert.equal(addressed(parse({ text })), true, text);
  }
});

test("이름이 나와도 지시가 아니면 사람끼리의 대화다", () => {
  for (const text of [
    "클로드가 만든 코드가 좀 이상한데",
    "코덱스 결과가 어제보다 낫네",
    "아까 소대장이 올린 제안 봤어?",
    "결제 실패율이 올라간 것 같아"
  ]) {
    assert.equal(addressed(parse({ text })), false, text);
  }
});

test("이름 호출은 소대장만 받는다 (분대장 직접 수신은 승인 게이트를 우회한다)", () => {
  const envelope = parse({ text: "코덱스는 재시도 로직 좀 고쳐줘" });
  const toCodex = isAddressedToBot({
    envelope,
    thisBotUsername: "codex_chatroom_bot",
    thisBotRole: "codex_leader",
    allBotUsernames: [BOT, "codex_chatroom_bot"]
  });
  assert.equal(toCodex, false, "분대장이 직접 받으면 작업 카드·승인·검증이 빠진다");
  assert.equal(addressed(envelope), true, "소대장이 받아 배분을 판단한다");
});

function parse(message: Record<string, unknown>): TelegramUpdateEnvelope {
  return TelegramUpdateEnvelope.parse("b1", BOT, "platoon_leader", {
    update_id: 30,
    message: { message_id: 300, chat: { id: CHAT }, from: { id: "1" }, ...message }
  });
}

function addressed(envelope: TelegramUpdateEnvelope): boolean {
  return isAddressedToBot({ envelope, thisBotUsername: BOT, thisBotRole: "platoon_leader", allBotUsernames: [BOT, "codex_chatroom_bot"] });
}

function config(): BotServiceConfig {
  return {
    allowedChatIds: [CHAT],
    botsByUsername: new Map([[BOT, { telegramBotId: "b1", botUsername: BOT, botRole: "platoon_leader", webhookSecret: SECRET }]])
  };
}

function message(updateId: number, userId: string, text: string) {
  return { update_id: updateId, message: { message_id: updateId * 10, chat: { id: CHAT }, from: { id: userId, is_bot: false }, text } };
}

function accept(update: unknown) {
  return routeTelegramWebhookSafe(BOT, SECRET, update, config());
}

function authorization(): RoomAuthorizationContext {
  return {
    memberships: [
      { telegramChatId: CHAT, telegramUserId: "1", role: "owner", permissions: ["task:create", "task:read", "task:approve", "task:final_approve"], status: "active" },
      { telegramChatId: CHAT, telegramUserId: "2", role: "human_member", permissions: ["task:create", "task:read"], status: "active" }
    ]
  };
}

function ports() {
  let counter = 0;
  return { makeId: (prefix: string) => `${prefix}_${++counter}`, now: () => "2026-08-15T00:00:00.000Z" };
}
