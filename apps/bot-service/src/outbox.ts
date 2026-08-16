import {
  maskTelegramSensitiveText as maskSensitiveText,
  sanitizeTelegramVisibleText
} from "../../../packages/telegram-ui/src/sanitize.js";
import { Api, GrammyError } from "grammy";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 3900;
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
  // attemptsOverride: lease_huai_outbox 는 리스마다 attempts 를 무조건 올린다. 429(rate
  // limit)는 우리 예산을 쓴 게 아니므로, 이번 리스가 attempts 에 더한 +1 을 되돌려야
  // 다음 "진짜" 오류의 소진 판정이 429 이력에 오염되지 않는다 — 생략하면(undefined)
  // 기존과 동일하게 DB 가 이미 갖고 있는 attempts 를 그대로 둔다.
  markRetry(outboxId: string, error: string, nextAttemptAt: string, attemptsOverride?: number): Promise<void>;
  markDead(outboxId: string, error: string): Promise<void>;
};

export type TelegramMessageSender = {
  sendMessage(request: TelegramSendMessageRequest): Promise<TelegramSendResult>;
  editMessageText(request: TelegramEditMessageTextRequest): Promise<TelegramSendResult>;
  answerCallbackQuery?(request: { botRole: TelegramBotRole; callbackQueryId: string; text?: string }): Promise<TelegramSendResult>;
  // 실행이 도는 동안 방 상단에 "…이 입력 중" 을 띄운다. 봇이 낼 수 있는 유일한 움직이는 신호다.
  sendChatAction?(request: { botRole: TelegramBotRole; telegramChatId: string; action: "typing" }): Promise<void>;
  // 포럼 그룹은 주제마다 고정 바가 따로다. 현황판은 주제 안에서 고정돼야 그 주제에서 보인다.
  pinMessage?(request: { botRole: TelegramBotRole; telegramChatId: string; telegramMessageId: string }): Promise<void>;
};

export type TelegramBotTokenResolver = {
  resolveBotToken(botRole: TelegramBotRole): Promise<string>;
};

type GrammyApiLike = Pick<Api, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "pinChatMessage">;

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
            // 주제를 안 실으면 포럼 그룹에서 General 로 떨어진다.
            message_thread_id: optionalNumericMessageId(request.messageThreadId),
            reply_markup: index === chunks.length - 1 ? request.keyboard : undefined
          }));
          result = { telegramMessageId: String(message.message_id), raw: message };
        } catch (error) {
          throw normalizeTelegramError(error);
        }
      }
      return result ?? { telegramMessageId: "" };
    },
    async pinMessage(request) {
      const api = await resolveApi(request.botRole);
      try {
        // 고정 알림까지 울리면 주제마다 한 번씩 방이 시끄럽다.
        await api.pinChatMessage(request.telegramChatId, numericMessageId(request.telegramMessageId), { disable_notification: true });
      } catch (error) {
        throw normalizeTelegramError(error);
      }
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
      // Telegram 429(rate limit)는 우리 잘못이 아니라 우리가 너무 빨리 보냈다는 신호일 뿐이다.
      // attempts 소진으로 markDead 시키면 재시도 몇 번 만에 메시지가 영구 소실된다.
      // 잘못된 chat_id 같은 영구 실패만 attempts 를 소진해야 한다.
      const rateLimited = isRateLimitedTelegramError(message);
      if (!rateLimited && row.attempts + 1 >= input.maxAttempts) {
        await input.store.markDead(row.outboxId, message);
        result.dead += 1;
      } else {
        // 429 는 exhaustion 판정에서만 빠지는 게 아니라, DB attempts 자체도 이번 리스가
        // 더한 +1 을 되돌려야 한다. 그래야 429 를 몇 번 겪었든 그 다음에 오는 진짜 오류
        // (예: 일시적 500)가 온전한 재시도 예산을 본다 — 안 그러면 attempts 만 계속
        // 쌓이다가 첫 비-429 실패에서 즉시 소진 판정을 맞아 markDead 로 죽는다(관찰됨).
        const attemptsOverride = rateLimited ? Math.max(0, row.attempts - 1) : undefined;
        await input.store.markRetry(row.outboxId, message, nextRetryAt(input.now(), row.attempts, error), attemptsOverride);
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
    async pinMessage(request) {
      await callTelegramApi(fetchImpl, input.tokenResolver, request.botRole, "pinChatMessage", {
        chat_id: request.telegramChatId,
        message_id: request.telegramMessageId,
        // 고정 알림까지 울리면 주제마다 한 번씩 방이 시끄럽다.
        disable_notification: true
      }, timeoutMs);
    },
    async answerCallbackQuery(request) {
      return callTelegramApi(fetchImpl, input.tokenResolver, request.botRole, "answerCallbackQuery", {
        callback_query_id: request.callbackQueryId,
        text: request.text
      }, timeoutMs);
    },
    async sendChatAction(request) {
      // 표시가 안 떠도 작업 자체를 막을 이유가 없다. 실패는 삼키되 로그로 남긴다 —
      // 조용히 없어지면 "왜 표시가 안 뜨지"를 나중에 추적할 수 없다.
      try {
        const token = await input.tokenResolver.resolveBotToken(request.botRole);
        await fetchImpl(`https://api.telegram.org/bot${token}/sendChatAction`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: request.telegramChatId, action: request.action }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        console.error(`telegram-chat-action-failed:${maskSensitiveText(String(error).slice(0, 200))}`);
      }
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

  const sent = await sender.sendMessage({
    botRole: row.target.botRole,
    telegramChatId: row.target.telegramChatId,
    // 포럼 그룹에서는 이 값이 있어야 지시가 오간 주제로 답이 간다.
    messageThreadId: optionalString(row.payload.messageThreadId),
    text,
    replyToMessageId,
    keyboard
  });

  // 고정까지가 이 메시지의 목적인 경우가 있다(작업 현황판). 고정에 실패해도 메시지는
  // 이미 나갔으므로 발신 자체를 실패로 되돌리지 않는다 — 재시도하면 같은 글이 또 올라간다.
  if (row.payload.pinMessage === true && sender.pinMessage && sent.telegramMessageId) {
    try {
      await sender.pinMessage({
        botRole: row.target.botRole,
        telegramChatId: row.target.telegramChatId,
        telegramMessageId: sent.telegramMessageId
      });
    } catch (error) {
      console.error(`telegram-pin-failed:${maskSensitiveText(String(error).slice(0, 200))}`);
    }
  }

  return sent;
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
      message_thread_id: request.messageThreadId,
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

// V1 지적: task-list-length-and-isolation.test.ts 가 이 로직을 수동으로 복제해 테스트하고
// 있었다 — 오늘은 같아도 이 함수가 바뀌면 그 테스트는 계속 초록으로 남는다. export 해서
// 테스트가 실물을 쓰게 한다.
export function splitTelegramText(text: string): string[] {
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
  method: "sendMessage" | "editMessageText" | "answerCallbackQuery" | "pinChatMessage",
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

// TelegramApiError / normalizeTelegramError 는 항상 "telegram-api-error:<status>:..." 형태의
// 메시지를 만든다(masking 은 bot 토큰/Bearer 값만 지우므로 상태 코드는 그대로 남는다).
// 429 는 rate limit — 영구 실패가 아니므로 attempts 소진 대상에서 제외한다.
function isRateLimitedTelegramError(maskedMessage: string): boolean {
  return /^telegram-api-error:429:/.test(maskedMessage);
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
