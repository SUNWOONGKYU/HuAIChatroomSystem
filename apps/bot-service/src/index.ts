import {
  handleTelegramInput,
  type RoomAuthorizationContext,
  type TelegramInputHandlingPorts,
  type TelegramInputHandlingResult
} from "../../../packages/orchestrator/src/index.js";
import {
  TelegramUpdateEnvelope,
  isAddressedToBot,
  isKnownCommand,
  isNamedDirective,
  parseTelegramCallbackData,
  type TelegramInboundQueueMessage,
  type TelegramUpdateReceipt,
  type TelegramWebhookAck,
  type TelegramWebhookRejectReason,
  type TelegramWebhookRequestContext,
  type NormalizedTelegramInput,
  type TelegramBotRole,
  type TelegramCommand
} from "../../../packages/contracts/src/index.js";
import { buildCommandHelp, buildProposalKeyboard } from "../../../packages/telegram-ui/src/index.js";

export type BotServiceConfig = {
  allowedChatIds: readonly string[];
  botsByUsername: ReadonlyMap<string, TelegramBotRuntimeConfig>;
};

export type TelegramBotRuntimeConfig = {
  telegramBotId: string;
  botUsername: string;
  botRole: TelegramBotRole;
  webhookSecret: string;
};

// 봇 4개가 물리적으로 같은 update 사본을 각자 받는다. (chat_id, message_id) unique 로
// 그중 하나만 기록되는데, 이 값은 계약(packages/contracts)의 TelegramWebhookRejectReason 에는
// 없다 — 거절이 아니라 "다른 봇에게 양보"라 의미가 다르고, contracts 는 다른 분대 담당이라
// 여기 로컬로만 넓혀 둔다. HTTP ack 로 내보낼 때만 계약 타입에 맞춰 좁힌다.
export type LocalIgnoreReason = "not-addressed-to-this-bot";

export type WebhookDecision =
  | { kind: "ignored"; reason: TelegramWebhookRejectReason | LocalIgnoreReason; envelope?: TelegramUpdateEnvelope }
  | { kind: "accepted"; input: NormalizedTelegramInput };

export type TelegramUpdateStore = {
  recordUpdateOnce(envelope: TelegramUpdateEnvelope, rawUpdate: unknown, status: "received" | "ignored"): Promise<TelegramUpdateReceipt>;
  markUpdateFailed(envelope: TelegramUpdateEnvelope | undefined, reason: string): Promise<void>;
};

export type TelegramInboundQueue = {
  enqueue(message: TelegramInboundQueueMessage): Promise<void>;
};

export type TelegramWebhookPorts = {
  updates: TelegramUpdateStore;
  inboundQueue: TelegramInboundQueue;
};

export type TelegramInboundProcessorPorts = {
  authorization: RoomAuthorizationContext;
  orchestrator: TelegramInputHandlingPorts;
};

export function verifyTelegramSecret(
  botUsername: string,
  receivedSecret: string | undefined,
  config: BotServiceConfig
): boolean {
  const expected = config.botsByUsername.get(botUsername)?.webhookSecret;
  return Boolean(expected && receivedSecret && timingSafeEqualText(expected, receivedSecret));
}

export function routeTelegramWebhook(
  botUsername: string,
  secretToken: string | undefined,
  payload: unknown,
  config: BotServiceConfig
): WebhookDecision {
  if (!verifyTelegramSecret(botUsername, secretToken, config)) {
    return { kind: "ignored", reason: "invalid-webhook-secret" };
  }
  return routeTelegramUpdate(botUsername, payload, config);
}

// 시크릿 검증을 뺀 공통 경로.
//
// webhook 은 Telegram 이 우리 URL 로 밀어넣는 방식이라 발신자를 시크릿으로 확인해야 한다.
// long polling 은 우리가 봇 토큰으로 Telegram 에 직접 가져오는 방식이라
// 전송 자체가 이미 인증돼 있고 시크릿이 존재하지 않는다.
// 두 방식이 같은 판정을 쓰도록 여기서 갈라 둔다.
export function routeTelegramUpdate(
  botUsername: string,
  payload: unknown,
  config: BotServiceConfig
): WebhookDecision {
  const bot = config.botsByUsername.get(botUsername);
  if (!bot) {
    return { kind: "ignored", reason: "unknown-bot" };
  }

  const envelope = TelegramUpdateEnvelope.parse(bot.telegramBotId, bot.botUsername, bot.botRole, payload);

  if (!config.allowedChatIds.includes(envelope.telegramChatId)) {
    return { kind: "ignored", reason: "unauthorized-chat" };
  }

  if (envelope.fromIsBot) {
    return { kind: "ignored", reason: "bot-message-ignored" };
  }

  const command = extractCommand(envelope.messageText);
  const callback = parseTelegramCallbackData(envelope.callbackData);

  // 버튼 콜백은 그 봇이 발행한 키보드에서 온 것이라 대상이 이미 확정돼 있다.
  if (callback) return { kind: "accepted", input: { kind: "callback", envelope, callback } };

  // 나머지는 전부 "이 발화가 나에게 한 말인가"를 먼저 판정한다.
  // 명령도 예외가 아니다 — 이 검사를 건너뛰면 이름 없는 `/tasks` 하나를 네 봇이 각자 처리한다.
  const addressed = isAddressedToBot({
    envelope,
    thisBotUsername: bot.botUsername,
    thisBotRole: bot.botRole,
    allBotUsernames: [...config.botsByUsername.keys()]
  });
  if (!addressed) {
    // 나에게 온 말이 아니더라도, 다른 특정 봇을 콕 집어 부른 것이면 기록을 양보한다.
    // 기록해 버리면 (chat_id, message_id) unique 경쟁에서 이 관찰이 먼저 꽂혀
    // 실제 대상 봇의 message/command 시도가 duplicate-update 로 버려질 수 있다 —
    // 그 결과가 라이브에서 관측된 "멘션했는데 무응답" 결함이다. envelope 을 안 실어서
    // recordUpdateOnce 자체가 호출되지 않게 한다.
    if (isAddressedToADifferentBot(envelope, bot, config)) {
      // 양보에는 전제가 있다: 지목된 봇이 그 방에서 실제로 이 메시지를 받는다는 것.
      // 라이브에서 그 전제가 깨졌다 — 메인방에서 `@claude_chatroom1_bot ...` 을 보내면
      // 소대장 봇만 업데이트를 받고(fetched=1) 양보했으며, ClaudeBot 에게는 Telegram 이
      // 아무것도 주지 않아 큐잉이 0건이었다. 아무도 처리하지 않고 방이 조용히 죽었다.
      //
      // 그래서 소대장은 양보하지 않는다. 소대장은 방의 기본 창구이고, 작업자 배정은
      // 어차피 수신한 봇이 아니라 본문의 지목(@claude_chatroom1_bot 등)으로 정해진다
      // (packages/orchestrator detectRequestedExecutionActorRole). 지목된 봇이 따로
      // 받아서 기록해도 결과는 같다 — (chat_id, message_id) 중복 판정으로 하나만 남고,
      // 어느 쪽이 남든 같은 작업자에게 간다.
      //
      // 나머지 봇은 계속 양보한다. 그 역할들은 수신 봇 자신이 작업자 배정에 우선 반영되어
      // (예: CodexBot 이 claude 지목 메시지를 처리하면 codex 로 배정된다) 엉뚱한 작업자에게
      // 일이 넘어간다.
      if (bot.botRole !== "platoon_leader") {
        return { kind: "ignored", reason: "not-addressed-to-this-bot" };
      }
      if (command) return { kind: "accepted", input: { kind: "command", envelope, command } };
      return { kind: "accepted", input: { kind: "message", envelope } };
    }
    return { kind: "accepted", input: { kind: "observation", envelope } };
  }
  if (command) return { kind: "accepted", input: { kind: "command", envelope, command } };
  return { kind: "accepted", input: { kind: "message", envelope } };
}

// "이 발화가 나 아닌 특정 다른 봇에게 간 것인가"를 판정한다.
// isAddressedToBot 과 신호가 겹치지만 반대 방향 질문이다 — 거기는 "나에게 왔나",
// 여기는 "남에게 갔나"(그래서 내가 기록을 양보해야 하나)다.
// contracts 의 isAddressedToBot 이 이미 이 신호들을 갖고 있지만 봇 하나 기준으로만
// true/false 를 접어 버려서 "누구에게 갔는지"가 밖으로 안 나온다. 계약을 바꾸지 않고
// bot-service 안에서만 답을 구하려고 같은 신호(멘션·답장·이름 지시)를 여기서 다시 본다.
// 신호 자체가 바뀌면 (BOT_ALIASES, DIRECTIVE_ENDING, 명령 대상 파싱 등) 양쪽을 같이 봐야 한다.
function isAddressedToADifferentBot(
  envelope: TelegramUpdateEnvelope,
  thisBot: TelegramBotRuntimeConfig,
  config: BotServiceConfig
): boolean {
  const text = (envelope.messageText ?? "").trim();

  if (text.startsWith("/")) {
    const first = text.split(/\s+/)[0] ?? "";
    const [, targetUsername] = first.split("@");
    if (targetUsername) return targetUsername !== thisBot.botUsername;
    // 이름 없는 명령은 소대장이 기본 창구다 — 다른 봇 입장에서는 소대장에게 간 것.
    return thisBot.botRole !== "platoon_leader";
  }

  const mentionsOtherBot = [...config.botsByUsername.keys()].some(
    (username) => username !== thisBot.botUsername && text.includes(`@${username}`)
  );
  if (mentionsOtherBot) return true;

  // 답장 대상이 현재 편성에 있는 다른 봇일 때만 "남에게 갔다"로 본다.
  // 편성에서 빠진 옛 봇 username 이면 아무도 대상이 아니라는 뜻이라 관찰로 흘려보내야
  // 한다 — 여기서 양보해 버리면 편성에 있는 어떤 봇도 기록을 안 해 메시지가 통째로
  // 사라진다.
  if (
    envelope.replyToBotUsername &&
    envelope.replyToBotUsername !== thisBot.botUsername &&
    config.botsByUsername.has(envelope.replyToBotUsername)
  ) {
    return true;
  }

  // 이름만 부르는 지시(@ 없이)는 늘 소대장 몫이다 — isAddressedToBot 과 동일 규칙.
  if (isNamedDirective(text)) return thisBot.botRole !== "platoon_leader";

  return false;
}

export async function handleTelegramWebhookFastAck(
  request: TelegramWebhookRequestContext,
  payload: unknown,
  config: BotServiceConfig,
  ports: TelegramWebhookPorts
): Promise<TelegramWebhookAck> {
  const decision = routeTelegramWebhookSafe(request.botUsername, request.secretToken, payload, config);
  if (decision.kind === "ignored") {
    // 봇끼리 잡음(다른 봇을 향한 말)은 정상 흐름이라 로그를 안 남긴다.
    // 나머지 무시 사유는 왜 떨어졌는지 나중에 원인을 찾을 수 있게 남긴다.
    if (decision.reason !== "bot-message-ignored") {
      console.log(
        JSON.stringify({ type: "telegram_webhook_ignored", botUsername: request.botUsername, reason: decision.reason })
      );
    }
    if (decision.envelope) {
      await ports.updates.recordUpdateOnce(decision.envelope, payload, "ignored");
    }
    return { httpStatus: 200, queued: false, reason: toWebhookAckReason(decision.reason) };
  }

  const receipt = await ports.updates.recordUpdateOnce(decision.input.envelope, payload, "received");
  if (!receipt.inserted) {
    return { httpStatus: 200, queued: false, reason: "duplicate-update" };
  }

  await ports.inboundQueue.enqueue({
    input: decision.input,
    idempotencyKey: receipt.idempotencyKey,
    receivedAt: request.receivedAt
  });

  return { httpStatus: 200, queued: true };
}

export function processTelegramInboundQueueMessage(
  message: TelegramInboundQueueMessage,
  ports: TelegramInboundProcessorPorts
): TelegramInputHandlingResult {
  return handleTelegramInput(message.input, ports.authorization, ports.orchestrator);
}

// LocalIgnoreReason 은 계약(TelegramWebhookRejectReason) 밖의 값이라 그대로 못 내보낸다.
// Telegram 은 ack body 의 reason 을 읽지 않으니(우리 쪽 로그·테스트용) undefined 로 접어도
// 무해하다 — 실제 사유는 위에서 이미 console.log 로 남겼다.
function toWebhookAckReason(reason: TelegramWebhookRejectReason | LocalIgnoreReason): TelegramWebhookRejectReason | undefined {
  return reason === "not-addressed-to-this-bot" ? undefined : reason;
}

export function routeTelegramWebhookSafe(
  botUsername: string,
  secretToken: string | undefined,
  payload: unknown,
  config: BotServiceConfig
): WebhookDecision {
  try {
    return routeTelegramWebhook(botUsername, secretToken, payload, config);
  } catch {
    return { kind: "ignored", reason: "malformed-update" };
  }
}

export function renderHelpMessage(): string {
  return buildCommandHelp();
}

export function renderNewTaskActions(taskProposalId: string) {
  return buildProposalKeyboard(taskProposalId);
}

export function makeTelegramUpdateIdempotencyKey(envelope: TelegramUpdateEnvelope): string {
  return `telegram-update:${envelope.telegramBotId}:${envelope.updateId}`;
}

function extractCommand(text: string | undefined): TelegramCommand | undefined {
  if (!text?.startsWith("/")) return undefined;
  const [rawName, ...args] = text.trim().split(/\s+/);
  const name = rawName.split("@")[0];
  if (!isKnownCommand(name)) return undefined;
  return { name, args };
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}
