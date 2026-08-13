import {
  handleTelegramInput,
  type RoomAuthorizationContext,
  type TelegramInputHandlingPorts,
  type TelegramInputHandlingResult
} from "../../../packages/orchestrator/src/index.js";
import {
  TelegramUpdateEnvelope,
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

  return {
    kind: "accepted",
    input: callback
      ? { kind: "callback", envelope, callback }
      : command
        ? { kind: "command", envelope, command }
        : { kind: "message", envelope }
  };
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
