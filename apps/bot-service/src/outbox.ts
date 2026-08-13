import {
  maskTelegramSensitiveText as maskSensitiveText,
  sanitizeTelegramVisibleText
} from "../../../packages/telegram-ui/src/sanitize.js";
import { Api, GrammyError } from "grammy";

const TELEGRAM_TEXT_CHUNK_LIMIT = 3900;
const DEFAULT_TELEGRAM_FETCH_TIMEOUT_MS = 10_000;

import {
  type OutboxRecord,
  type TelegramBotRole,
  type TelegramEditMessageTextRequest,
  type TelegramSendMessageRequest,
  type TelegramSendResult
} from "../../../packages/contracts/src/index.js";

export type OutboxDispatchResult = {
  leased: number;
  sent: number;
  retried: number;
  dead: number;
};

export type OutboxDispatcherStore = {
  leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]>;
  markSent(outboxId: string, result: TelegramSendResult): Promise<void>;
  markRetry(outboxId: string, error: string, nextAttemptAt: string): Promise<void>;
  markDead(outboxId: string, error: string): Promise<void>;
};

export type TelegramMessageSender = {
  sendMessage(request: TelegramSendMessageRequest): Promise<TelegramSendResult>;
  editMessageText(request: TelegramEditMessageTextRequest): Promise<TelegramSendResult>;
  answerCallbackQuery?(request: { botRole: TelegramBotRole; callbackQueryId: string; text?: string }): Promise<TelegramSendResult>;
};

export type TelegramBotTokenResolver = {
  resolveBotToken(botRole: TelegramBotRole): Promise<string>;
};

type GrammyApiLike = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

export function createTelegramGrammySender(input: {
  tokenResolver: TelegramBotTokenResolver;
  apiFactory?: (token: string) => GrammyApiLike;
}): TelegramMessageSender {
  const apiByRole = new Map<TelegramBotRole, GrammyApiLike>();
  const resolveApi = async (role: TelegramBotRole): Promise<GrammyApiLike> => {
    const cached = apiByRole.get(role);
    if (cached) return cached;
    const token = await input.tokenResolver.resolveBotToken(role);
    const api = input.apiFactory ? input.apiFactory(token) : new Api(token);
    apiByRole.set(role, api);
    return api;
  };

  return {
    async sendMessage(request) {
      const chunks = splitTelegramText(request.text);
      let result: TelegramSendResult | undefined;
      const api = await resolveApi(request.botRole);
      for (let index = 0; index < chunks.length; index += 1) {
        try {
          const message = await api.sendMessage(request.telegramChatId, chunks[index] ?? "", stripUndefined({
            reply_to_message_id: index === 0 ? optionalNumericMessageId(request.replyToMessageId) : undefined,
            reply_markup: index === chunks.length - 1 ? request.keyboard : undefined
          }));
          result = { telegramMessageId: String(message.message_id), raw: message };
        } catch (error) {
          throw normalizeTelegramError(error);
        }
      }
      return result ?? { telegramMessageId: "" };
    },
    async editMessageText(request) {
      const chunks = splitTelegramText(request.text);
      const api = await resolveApi(request.botRole);
      let result: TelegramSendResult | undefined;
      try {
        const edited = await api.editMessageText(request.telegramChatId, numericMessageId(request.telegramMessageId), chunks[0] ?? "", stripUndefined({
          reply_markup: chunks.length === 1 ? request.keyboard : undefined
        }));
        result = { telegramMessageId: String(typeof edited === "boolean" ? request.telegramMessageId : edited.message_id), raw: edited };
        for (let index = 1; index < chunks.length; index += 1) {
          const message = await api.sendMessage(request.telegramChatId, chunks[index] ?? "", stripUndefined({
            reply_markup: index === chunks.length - 1 ? request.keyboard : undefined
          }));
          result = { telegramMessageId: String(message.message_id), raw: message };
        }
      } catch (error) {
        throw normalizeTelegramError(error);
      }
      return result ?? { telegramMessageId: request.telegramMessageId };
    },
    async answerCallbackQuery(request) {
      const api = await resolveApi(request.botRole);
      try {
        await api.answerCallbackQuery(request.callbackQueryId, stripUndefined({ text: request.text }));
        return { telegramMessageId: request.callbackQueryId };
      } catch (error) {
        throw normalizeTelegramError(error);
      }
    }
  };
}
export async function dispatchOutboxBatch(input: {
  store: OutboxDispatcherStore;
  telegram: TelegramMessageSender;
  limit: number;
  leaseUntil: string;
  now: () => Date;
  maxAttempts: number;
  allowedChatIds?: readonly string[];
}): Promise<OutboxDispatchResult> {
  const rows = await input.store.leasePending(input.limit, input.leaseUntil);
  const result: OutboxDispatchResult = { leased: rows.length, sent: 0, retried: 0, dead: 0 };

  for (const row of rows) {
    try {
      if (row.target.kind !== "telegram_bot") {
        await input.store.markRetry(row.outboxId, "unsupported-target-kind", nextRetryAt(input.now(), row.attempts));
        result.retried += 1;
        continue;
      }

      if (input.allowedChatIds && !input.allowedChatIds.includes(row.target.telegramChatId)) {
        await input.store.markDead(row.outboxId, "unauthorized-outbound-chat");
        result.dead += 1;
        continue;
      }

      const sendResult = await sendTelegramOutbox(row, input.telegram);
      await input.store.markSent(row.outboxId, sendResult);
      result.sent += 1;
    } catch (error) {
      const message = maskSensitiveText(error instanceof Error ? error.message : String(error));
      if (isExpiredCallbackAnswer(row, message)) {
        await input.store.markSent(row.outboxId, { telegramMessageId: "callback-query-expired" });
        result.sent += 1;
        continue;
      }
      if (row.attempts + 1 >= input.maxAttempts) {
        await input.store.markDead(row.outboxId, message);
        result.dead += 1;
      } else {
        await input.store.markRetry(row.outboxId, message, nextRetryAt(input.now(), row.attempts, error));
        result.retried += 1;
      }
    }
  }

  return result;
}

export function createTelegramFetchSender(input: {
  tokenResolver: TelegramBotTokenResolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): TelegramMessageSender {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TELEGRAM_FETCH_TIMEOUT_MS;
  return {
    async sendMessage(request) {
      return sendTelegramTextChunks(fetchImpl, input.tokenResolver, request, timeoutMs);
    },
    async editMessageText(request) {
      return editTelegramTextChunks(fetchImpl, input.tokenResolver, request, timeoutMs);
    },
    async answerCallbackQuery(request) {
      return callTelegramApi(fetchImpl, input.tokenResolver, request.botRole, "answerCallbackQuery", {
        callback_query_id: request.callbackQueryId,
        text: request.text
      }, timeoutMs);
    }
  };
}

async function sendTelegramOutbox(row: OutboxRecord, sender: TelegramMessageSender): Promise<TelegramSendResult> {
  const rawText = optionalString(row.payload.text);
  const text = rawText === undefined ? undefined : sanitizeTelegramVisibleText(rawText);
  const keyboard = row.payload.keyboard;
  const editMessageId = optionalString(row.payload.editMessageId);
  const replyToMessageId = optionalString(row.payload.replyToMessageId);
  const callbackQueryId = optionalString(row.payload.callbackQueryId);

  if (row.target.kind !== "telegram_bot") {
    throw new Error("unsupported-target-kind");
  }

  if (callbackQueryId && isCallbackAnswerOnlyOutbox(row)) {
    if (!sender.answerCallbackQuery) throw new Error("unsupported-callback-answer");
    return sender.answerCallbackQuery({
      botRole: row.target.botRole,
      callbackQueryId,
      text
    });
  }

  if (!text) throw new Error("missing-payload.text");

  if (editMessageId) {
    return sender.editMessageText({
      botRole: row.target.botRole,
      telegramChatId: row.target.telegramChatId,
      telegramMessageId: editMessageId,
      text,
      keyboard
    });
  }

  return sender.sendMessage({
    botRole: row.target.botRole,
    telegramChatId: row.target.telegramChatId,
    text,
    replyToMessageId,
    keyboard
  });
}

async function sendTelegramTextChunks(
  fetchImpl: typeof fetch,
  tokenResolver: TelegramBotTokenResolver,
  request: TelegramSendMessageRequest,
  timeoutMs: number
): Promise<TelegramSendResult> {
  const chunks = splitTelegramText(request.text);
  let result: TelegramSendResult | undefined;
  for (let index = 0; index < chunks.length; index += 1) {
    result = await callTelegramApi(fetchImpl, tokenResolver, request.botRole, "sendMessage", {
      chat_id: request.telegramChatId,
      text: chunks[index],
      reply_to_message_id: index === 0 ? request.replyToMessageId : undefined,
      reply_markup: index === chunks.length - 1 ? request.keyboard : undefined
    }, timeoutMs);
  }
  return result ?? { telegramMessageId: "" };
}

async function editTelegramTextChunks(
  fetchImpl: typeof fetch,
  tokenResolver: TelegramBotTokenResolver,
  request: TelegramEditMessageTextRequest,
  timeoutMs: number
): Promise<TelegramSendResult> {
  const chunks = splitTelegramText(request.text);
  let result = await callTelegramApi(fetchImpl, tokenResolver, request.botRole, "editMessageText", {
    chat_id: request.telegramChatId,
    message_id: request.telegramMessageId,
    text: chunks[0],
    reply_markup: chunks.length === 1 ? request.keyboard : undefined
  }, timeoutMs);
  for (let index = 1; index < chunks.length; index += 1) {
    result = await callTelegramApi(fetchImpl, tokenResolver, request.botRole, "sendMessage", {
      chat_id: request.telegramChatId,
      text: chunks[index],
      reply_markup: index === chunks.length - 1 ? request.keyboard : undefined
    }, timeoutMs);
  }
  return result;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_TEXT_CHUNK_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_TEXT_CHUNK_LIMIT) {
    const slice = remaining.slice(0, TELEGRAM_TEXT_CHUNK_LIMIT);
    const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = boundary > TELEGRAM_TEXT_CHUNK_LIMIT * 0.6 ? boundary : TELEGRAM_TEXT_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
async function callTelegramApi(
  fetchImpl: typeof fetch,
  tokenResolver: TelegramBotTokenResolver,
  botRole: TelegramBotRole,
  method: "sendMessage" | "editMessageText" | "answerCallbackQuery",
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<TelegramSendResult> {
  const token = await tokenResolver.resolveBotToken(botRole);
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stripUndefined(body)),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await readTelegramApiResponse(response);

  if (!response.ok || payload.ok !== true) {
    throw new TelegramApiError(
      `telegram-api-error:${response.status}:${maskSensitiveText(payload.description ?? "unknown")}`,
      retryAfterMs(payload)
    );
  }

  return {
    telegramMessageId: String(payload.result?.message_id ?? ""),
    raw: payload
  };
}

class TelegramApiError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TelegramApiError";
  }
}

async function readTelegramApiResponse(response: Response): Promise<TelegramApiResponse> {
  try {
    return (await response.json()) as TelegramApiResponse;
  } catch {
    return { ok: false, description: "invalid-json-response" };
  }
}

function retryAfterMs(payload: TelegramApiResponse): number | undefined {
  const retryAfterSeconds = payload.parameters?.retry_after;
  if (typeof retryAfterSeconds !== "number" || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds <= 0) return undefined;
  return retryAfterSeconds * 1000;
}

function nextRetryAt(now: Date, attempts: number, error?: unknown): string {
  if (error instanceof TelegramApiError && error.retryAfterMs) {
    return new Date(now.getTime() + error.retryAfterMs).toISOString();
  }
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts));
  return new Date(now.getTime() + delayMs).toISOString();
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`missing-${name}`);
  }
  return value;
}

function isExpiredCallbackAnswer(row: OutboxRecord, errorMessage: string): boolean {
  return isCallbackAnswerOnlyOutbox(row) && /query is too old|query ID is invalid|response timeout expired/i.test(errorMessage);
}

function isCallbackAnswerOnlyOutbox(row: OutboxRecord): boolean {
  return row.payload.binding === undefined && row.payload.keyboard === undefined && row.payload.editMessageId === undefined && row.payload.replyToMessageId === undefined;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}




type TelegramApiResponse = {
  ok: boolean;
  description?: string;
  parameters?: { retry_after?: number };
  result?: { message_id?: number | string };
};









function optionalNumericMessageId(value: string | undefined): number | undefined {
  return value ? numericMessageId(value) : undefined;
}
function numericMessageId(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("invalid-telegram-message-id");
  return parsed;
}

function normalizeTelegramError(error: unknown): Error {
  if (error instanceof TelegramApiError) return error;
  if (isGrammyError(error)) {
    return new TelegramApiError(
      `telegram-api-error:${error.error_code}:${maskSensitiveText(error.description)}`,
      retryAfterMs({ ok: false, parameters: error.parameters })
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(maskSensitiveText(message));
}

function isGrammyError(error: unknown): error is GrammyError {
  return error instanceof GrammyError;
}
