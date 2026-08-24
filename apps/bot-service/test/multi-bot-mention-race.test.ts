// 라이브 실전 결함 재현: 봇 4개가 같은 그룹의 멤버라 텍스트 메시지 한 건이 봇마다
// 각자의 폴링으로 따로 배달된다(같은 chat_id+message_id, 서로 다른 update_id).
// huai_telegram_updates 의 (chat_id, message_id) 부분 unique 제약 때문에 이 4장의
// 사본 중 딱 하나만 기록에서 이기고, 예전 코드는 "이긴 봇 기준으로만" @멘션 판정을
// 했다. 리더가 아닌 봇이 이기면 그 봇 입장에선 "나한테 한 말이 아니다" 로 관찰로
// 떨어지고, 리더의 (진짜 정답인) 판정은 뒤늦게 도착해도 이미 그 슬롯이 차 있어
// 409 로 버려진다 — 방장이 리더를 불러도 무응답.
//
// 이 파일은 그 경쟁을 실제로 재현하는 (chat_id, message_id) 부분 unique 를 흉내내는
// 가짜 저장소로 시나리오를 재현하고, 고친 뒤에도 계속 통과하는지 확인한다.
import assert from "node:assert/strict";
import test from "node:test";
import {
  TelegramPollingOffsets,
  runTelegramPollingCycle,
  type TelegramPollingBot
} from "../src/polling.js";
import { type BotServiceConfig, type TelegramWebhookPorts } from "../src/index.js";
import { type TelegramInboundQueueMessage, type TelegramUpdateEnvelope, type TelegramUpdateReceipt } from "../../../packages/contracts/src/index.js";

const CHAT = "-1009998887776";
const LEADER = "leader_chatroom_bot";
const CLAUDE = "claude_chatroom_bot";
const CODEX = "codex_chatroom_bot";
const AUDITOR = "auditor_chatroom_bot";

const ROLE_BY_USERNAME: Record<string, "leader" | "claude_leader" | "codex_leader" | "auditor"> = {
  [LEADER]: "leader",
  [CLAUDE]: "claude_leader",
  [CODEX]: "codex_leader",
  [AUDITOR]: "auditor"
};

for (const [winnerLabel, winnerUsername] of Object.entries({ auditor: AUDITOR, codex: CODEX, claude: CLAUDE, leader: LEADER })) {
  test(`${winnerLabel} 봇이 기록 경쟁에서 먼저 이겨도 @leader_chatroom_bot 멘션은 결국 리더가 처리한다`, async () => {
    const store = raceAwareStore();
    const config = fourBotConfig();
    const text = "@" + LEADER + " 뭐 하고 있어";
    const messageId = 7001;
    let nextUpdateId = 30000;

    // 1 사이클: winner 봇(과 나머지, 리더 제외)이 먼저 자기 사본을 받는다 —
    // 실제로는 봇마다 독립적인 getUpdates 배달 타이밍과, 순차 폴링(봇 하나당
    // 최대 25초 대기)이 겹쳐서 흔히 벌어지는 상황이다. winner 가 leader 자신이면
    // 경쟁이랄 것도 없이 정상 케이스(양성 대조)가 된다.
    const firstCycleUsernames = Object.values({ auditor: AUDITOR, codex: CODEX, claude: CLAUDE, leader: LEADER })
      .filter((username) => username === winnerUsername || username !== LEADER);
    // winner 가 leader 이 아니면 leader 은 이번 사이클에서 뺀다(뒤늦게 도착 흉내).
    const firstCycleBots = firstCycleUsernames
      .filter((username, index, all) => all.indexOf(username) === index)
      .filter((username) => winnerUsername === LEADER || username !== LEADER)
      .map((username) => bot(username));

    await runTelegramPollingCycle({
      bots: firstCycleBots,
      config,
      ports: store.ports,
      offsets: new TelegramPollingOffsets(),
      deps: { fetchImpl: perBotFetch(firstCycleBots.map((b) => [b.botUsername, [message(nextUpdateId++, CHAT, messageId, text)]])) }
    });

    if (winnerUsername !== LEADER) {
      // 이 시점에 리더 아닌 봇들은 전부 "나한테 온 말 아님" 이어야 한다 —
      // 아무도 리더 대신 이 멘션을 처리하면 안 된다.
      const misrouted = store.queued.filter((m) => m.input.kind !== "observation");
      assert.equal(misrouted.length, 0, "리더가 아닌 봇이 이 멘션을 대신 처리하면 안 된다");

      // 2 사이클: 리더의 자기 사본이 뒤늦게 도착.
      await runTelegramPollingCycle({
        bots: [bot(LEADER)],
        config,
        ports: store.ports,
        offsets: new TelegramPollingOffsets(),
        deps: { fetchImpl: perBotFetch([[LEADER, [message(nextUpdateId++, CHAT, messageId, text)]]]) }
      });
    }

    const leaderHandled = store.queued.filter(
      (m) => m.input.envelope.telegramBotRole === "leader" && (m.input.kind === "message" || m.input.kind === "command")
    );
    assert.equal(leaderHandled.length, 1, `${winnerLabel} 가 먼저 기록을 이겨도 리더가 결국 이 멘션을 처리해야 한다`);
  });
}

test("멘션 없는 일반 대화는 여전히 관찰로만 기록된다(기존 동작 보존)", async () => {
  const store = raceAwareStore();
  const config = fourBotConfig();
  const text = "결제 실패율이 올라간 것 같아";

  await runTelegramPollingCycle({
    bots: [bot(AUDITOR)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: perBotFetch([[AUDITOR, [message(40000, CHAT, 7100, text)]]]) }
  });

  assert.equal(store.queued.length, 1);
  assert.equal(store.queued[0]?.input.kind, "observation");
});

test("이름만 부르는 지시(예: '리더 정리해줘')도 다른 봇이 먼저 기록을 이겨도 결국 리더가 처리한다", async () => {
  const store = raceAwareStore();
  const config = fourBotConfig();
  const text = "리더 이거 정리해줘";
  const messageId = 7200;

  await runTelegramPollingCycle({
    bots: [bot(CODEX)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: perBotFetch([[CODEX, [message(50000, CHAT, messageId, text)]]]) }
  });
  assert.equal(store.queued.filter((m) => m.input.kind !== "observation").length, 0);

  await runTelegramPollingCycle({
    bots: [bot(LEADER)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: perBotFetch([[LEADER, [message(50001, CHAT, messageId, text)]]]) }
  });

  const leaderHandled = store.queued.filter((m) => m.input.envelope.telegramBotRole === "leader" && m.input.kind === "message");
  assert.equal(leaderHandled.length, 1);
});

test("무시 판정 사유가 관측 가능하게 남는다(onIgnored 콜백)", async () => {
  const store = raceAwareStore();
  const config = fourBotConfig();
  const text = "@" + LEADER + " 해줘";
  const ignoredReasons: string[] = [];

  await runTelegramPollingCycle({
    bots: [bot(AUDITOR)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: {
      fetchImpl: perBotFetch([[AUDITOR, [message(60000, CHAT, 7300, text)]]]),
      onIgnored: (botUsername, reason) => ignoredReasons.push(botUsername + ":" + reason)
    }
  });

  assert.deepEqual(ignoredReasons, [AUDITOR + ":not-addressed-to-this-bot"], "다른 봇에게 넘긴 사유가 로그로 남아야 한다");
});

function fourBotConfig(): BotServiceConfig {
  return {
    allowedChatIds: [CHAT],
    botsByUsername: new Map(
      [LEADER, CLAUDE, CODEX, AUDITOR].map((username) => [
        username,
        { telegramBotId: "id-" + username, botUsername: username, botRole: ROLE_BY_USERNAME[username]!, webhookSecret: "s" }
      ])
    )
  };
}

function bot(botUsername: string): TelegramPollingBot {
  return { botUsername, token: "token-" + botUsername };
}

function message(updateId: number, chatId: string, messageId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId },
      from: { id: "5001", is_bot: false, first_name: "방장" },
      text
    }
  };
}

function perBotFetch(pairs: Array<[string, unknown[]]>): typeof fetch {
  const byToken = new Map(pairs.map(([username, updates]) => ["token-" + username, updates]));
  return (async (url: string | URL | Request) => {
    const href = String(url);
    const token = href.match(/\/bot([^/]+)\//)?.[1];
    const updates = (token && byToken.get(token)) ?? [];
    return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// (chat_id, message_id) 부분 unique 제약을 실제로 흉내내는 저장소. 기존
// telegram-polling.test.ts 의 가짜는 (telegram_bot_id, update_id) 로만 dedupe 해서
// 이 경쟁을 재현할 수 없었다 — 그게 이 파일을 새로 만든 이유다.
function raceAwareStore(): {
  ports: TelegramWebhookPorts;
  queued: TelegramInboundQueueMessage[];
} {
  const seenByBotUpdate = new Set<string>();
  const seenByChatMessage = new Set<string>();
  const queued: TelegramInboundQueueMessage[] = [];

  return {
    queued,
    ports: {
      updates: {
        async recordUpdateOnce(envelope: TelegramUpdateEnvelope): Promise<TelegramUpdateReceipt> {
          const pkKey = envelope.telegramBotId + ":" + envelope.updateId;
          if (seenByBotUpdate.has(pkKey)) return { inserted: false, status: "processed", idempotencyKey: pkKey };

          if (envelope.telegramMessageId !== undefined) {
            const chatMessageKey = envelope.telegramChatId + ":" + envelope.telegramMessageId;
            if (seenByChatMessage.has(chatMessageKey)) {
              // 실제 partial unique index 위반과 동일하게 취급한다 — 이 물리
              // 메시지는 이미 다른 봇 사본이 선점했다.
              return { inserted: false, status: "processed", idempotencyKey: pkKey };
            }
            seenByChatMessage.add(chatMessageKey);
          }
          seenByBotUpdate.add(pkKey);
          return { inserted: true, status: "received", idempotencyKey: pkKey };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: {
        async enqueue(message: TelegramInboundQueueMessage) {
          queued.push(message);
        }
      }
    }
  };
}

// 라이브 결함 회귀 — 지목된 봇이 그 방에서 메시지를 못 받는 경우.
//
// 메인방에서 `@claude_chatroom1_bot ...` 을 보내면 리더 봇만 업데이트를 받았다
// (폴링 로그: fetched=1, ignored=1, queued=0). 리더는 "지목된 봇이 처리하겠지" 하고
// 양보했고, ClaudeBot 에게는 Telegram 이 아무것도 주지 않았다. 아무도 처리하지 않아
// 방이 조용히 죽었다 — 에러도 기록도 없이.
test("지목된 봇이 업데이트를 못 받아도 리더가 처리한다", async () => {
  const store = raceAwareStore();
  const config = fourBotConfig();
  const text = "@" + CLAUDE + " 이 저장소 package.json 의 version 값을 조사해서 보고해";

  // 리더 봇에게만 업데이트가 온다 — 라이브에서 관측된 그대로.
  await runTelegramPollingCycle({
    bots: [bot(LEADER)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: perBotFetch([[LEADER, [message(70000, CHAT, 7400, text)]]]) }
  });

  const handled = store.queued.filter((m) => m.input.kind !== "observation");
  assert.equal(handled.length, 1, "아무도 처리하지 않았다 — 방이 조용히 죽는다");
  assert.equal(handled[0]?.input.envelope.telegramBotRole, "leader");
});

test("리더가 처리해도 지목된 작업자 정보는 본문에 그대로 남는다", async () => {
  // 배정은 수신한 봇이 아니라 본문의 지목으로 정해진다. 리더가 대신 받았다고 해서
  // 리더에게 일이 가면 안 된다.
  const store = raceAwareStore();
  const config = fourBotConfig();
  const text = "@" + CLAUDE + " 로그인 세션 문제 조사해";

  await runTelegramPollingCycle({
    bots: [bot(LEADER)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: perBotFetch([[LEADER, [message(70100, CHAT, 7401, text)]]]) }
  });

  const handled = store.queued.filter((m) => m.input.kind !== "observation");
  assert.equal(handled.length, 1);
  assert.match(String(handled[0]?.input.envelope.messageText), new RegExp("@" + CLAUDE));
});

test("리더가 아닌 봇은 여전히 양보한다", async () => {
  // CodexBot 이 claude 지목 메시지를 처리하면 수신 봇 역할이 배정에 우선 반영되어
  // 엉뚱한 작업자에게 일이 넘어간다. 그래서 양보는 나머지 봇에서 유지해야 한다.
  const store = raceAwareStore();
  const config = fourBotConfig();
  const text = "@" + CLAUDE + " 조사해";
  const ignoredReasons: string[] = [];

  await runTelegramPollingCycle({
    bots: [bot(CODEX)],
    config,
    ports: store.ports,
    offsets: new TelegramPollingOffsets(),
    deps: {
      fetchImpl: perBotFetch([[CODEX, [message(70200, CHAT, 7402, text)]]]),
      onIgnored: (botUsername, reason) => ignoredReasons.push(botUsername + ":" + reason)
    }
  });

  assert.deepEqual(ignoredReasons, [CODEX + ":not-addressed-to-this-bot"]);
  assert.equal(store.queued.filter((m) => m.input.kind !== "observation").length, 0);
});
