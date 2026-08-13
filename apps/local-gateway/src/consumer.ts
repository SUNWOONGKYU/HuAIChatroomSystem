import { assertExecutionRequestPayload, type ExecutionRequest, type GatewayEvent, type OutboxRecord } from "../../../packages/contracts/src/index.js";
import { executeGatewayRequest, type GatewayEventSink, type ProcessRunner } from "./executor.js";
import { maskSensitiveOutput, type GatewayPolicy } from "./index.js";

export type LocalGatewayOutboxStore = {
  leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]>;
  markSent(outboxId: string, result: { telegramMessageId: string }): Promise<void>;
  markRetry(outboxId: string, error: string, nextAttemptAt: string): Promise<void>;
  markDead(outboxId: string, error: string): Promise<void>;
  recordGatewayExecutionResult(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }): Promise<void>;
};

export type LocalGatewayConsumerResult = {
  leased: number;
  completed: number;
  retried: number;
  dead: number;
  rejected: number;
};

export async function runLocalGatewayConsumerOnce(input: {
  store: LocalGatewayOutboxStore;
  policy: GatewayPolicy;
  runner: ProcessRunner;
  sink: GatewayEventSink;
  limit: number;
  leaseUntil: string;
  maxAttempts: number;
  now?: () => string;
}): Promise<LocalGatewayConsumerResult> {
  const rows = await input.store.leasePendingLocalGateway(input.limit, input.leaseUntil);
  const result: LocalGatewayConsumerResult = { leased: rows.length, completed: 0, retried: 0, dead: 0, rejected: 0 };

  for (const row of rows) {
    let request: ExecutionRequest;
    try {
      request = parseExecutionRequest(row);
    } catch (error) {
      await input.store.markDead(row.outboxId, maskSensitiveOutput(error instanceof Error ? error.message : String(error)));
      result.dead += 1;
      continue;
    }

    const execution = await executeGatewayRequest({
      request,
      policy: input.policy,
      runner: input.runner,
      sink: input.sink,
      now: input.now
    });

    if (execution.status === "completed") {
      await input.store.recordGatewayExecutionResult({
        request,
        status: "completed",
        events: execution.events,
        occurredAt: lastEventAt(execution.events) ?? input.now?.() ?? new Date().toISOString()
      });
      await input.store.markSent(row.outboxId, { telegramMessageId: request.attemptId });
      result.completed += 1;
      continue;
    }

    const errorKind = failureReason(execution.events);
    await input.store.recordGatewayExecutionResult({
      request,
      status: execution.status,
      events: execution.events,
      errorKind,
      occurredAt: input.now?.() ?? new Date().toISOString()
    });
    if (execution.retryable && row.attempts + 1 < input.maxAttempts) {
      await input.store.markRetry(row.outboxId, errorKind, nextRetryAt(row.attempts));
      result.retried += 1;
      continue;
    }

    await input.store.markDead(row.outboxId, errorKind);
    if (execution.status === "rejected") result.rejected += 1;
    else result.dead += 1;
  }

  return result;
}

function parseExecutionRequest(row: OutboxRecord): ExecutionRequest {
  return assertExecutionRequestPayload(row.payload.executionRequest ?? row.payload);
}

function nextRetryAt(attempts: number): string {
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts));
  return new Date(Date.now() + delayMs).toISOString();
}

function failureReason(events: Array<{ type: string }>): string {
  const failed = [...events].reverse().find((event): event is { type: "failed"; errorKind: string } => event.type === "failed" && "errorKind" in event);
  return failed?.errorKind ?? "failed";
}

function lastEventAt(events: GatewayEvent[]): string | undefined {
  const withAt = [...events].reverse().find((event): event is GatewayEvent & { at: string } => "at" in event && typeof event.at === "string");
  return withAt?.at;
}
