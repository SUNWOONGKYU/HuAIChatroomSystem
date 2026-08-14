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

export type WebhookDecision =
  | { kind: "ignored"; reason: TelegramWebhookRejectReason; envelope?: TelegramUpdateEnvelope }
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
  if (!addressed) return { kind: "accepted", input: { kind: "observation", envelope } };
  if (command) return { kind: "accepted", input: { kind: "command", envelope, command } };
  return { kind: "accepted", input: { kind: "message", envelope } };
}

export async function handleTelegramWebhookFastAck(
  request: TelegramWebhookRequestContext,
  payload: unknown,
  config: BotServiceConfig,
  ports: TelegramWebhookPorts
): Promise<TelegramWebhookAck> {
  const decision = routeTelegramWebhookSafe(request.botUsername, request.secretToken, payload, config);
  if (decision.kind === "ignored") {
    if (decision.envelope) {
      await ports.updates.recordUpdateOnce(decision.envelope, payload, "ignored");
    }
    return { httpStatus: 200, queued: false, reason: decision.reason };
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
