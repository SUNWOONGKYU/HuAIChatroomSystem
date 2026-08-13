import {
  type TelegramInboundQueueMessage,
  type TelegramSendResult
} from "../../../packages/contracts/src/index.js";
import {
  type OrchestratorEvent,
  type OrchestratorOutboxItem,
  type TelegramInputHandlingResult
} from "../../../packages/orchestrator/src/index.js";
import {
  processTelegramInboundQueueMessage,
  type TelegramInboundProcessorPorts
} from "./index.js";

export type PersistedEvent = OrchestratorEvent & {
  eventId: string;
  createdAt: string;
};

export type PersistedOutboxItem = OrchestratorOutboxItem & {
  outboxId: string;
  eventId?: string;
  status: "pending" | "processing" | "sent" | "retry_pending" | "failed" | "dead";
  attempts: number;
  createdAt: string;
  sentAt?: string;
  lastError?: string;
  nextAttemptAt?: string;
};

export type OrchestratorPersistencePort = {
  commitTelegramInputResult(input: {
    message: TelegramInboundQueueMessage;
    result: Extract<TelegramInputHandlingResult, { accepted: true }>;
  }): Promise<{ events: PersistedEvent[]; outbox: PersistedOutboxItem[] }>;
  markTelegramUpdateProcessed(idempotencyKey: string): Promise<void>;
  markTelegramUpdateFailed(idempotencyKey: string, error: string): Promise<void>;
};

export async function processTelegramInboundWithPersistence(input: {
  message: TelegramInboundQueueMessage;
  processorPorts: TelegramInboundProcessorPorts;
  persistence: OrchestratorPersistencePort;
}): Promise<TelegramInputHandlingResult> {
  try {
    const result = processTelegramInboundQueueMessage(input.message, input.processorPorts);
    if (!result.accepted) {
      await input.persistence.markTelegramUpdateFailed(
        input.message.idempotencyKey,
        result.authorization.allowed ? "authorization-not-accepted" : result.authorization.reason
      );
      return result;
    }

    await input.persistence.commitTelegramInputResult({ message: input.message, result });
    await input.persistence.markTelegramUpdateProcessed(input.message.idempotencyKey);
    return result;
  } catch (error) {
    await input.persistence.markTelegramUpdateFailed(
      input.message.idempotencyKey,
      maskSensitiveText(error instanceof Error ? error.message : String(error))
    );
    throw error;
  }
}

export function summarizeTelegramSendResult(result: TelegramSendResult): Record<string, unknown> {
  return { telegramMessageId: result.telegramMessageId };
}

function maskSensitiveText(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

