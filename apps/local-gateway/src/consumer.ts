import { assertExecutionRequestPayload, type ExecutionRequest, type GatewayEvent, type OutboxRecord } from "../../../packages/contracts/src/index.js";
import { executeGatewayRequest, type GatewayEventSink, type ProcessRunner } from "./executor.js";
import { maskSensitiveOutput, type GatewayPolicy } from "./index.js";
import { type ArtifactCollector } from "./artifact-collector.js";

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

// 배치 안에서 방 A의 15분짜리 실행이 방 B/C를 뒤에서 기다리게 하면 "동시 3방 3분"
// 요구를 못 맞춘다. leasePendingLocalGateway 가 돌려준 행들을 워커 풀로 동시 처리한다.
// 동시성 상한을 넘겨받지 않으면(undefined) 기존 동작(사실상 순차)과 동일하게 1로 둔다.
const DEFAULT_CONCURRENCY = 1;

export async function runLocalGatewayConsumerOnce(input: {
  store: LocalGatewayOutboxStore;
  policy: GatewayPolicy;
  runner: ProcessRunner;
  sink: GatewayEventSink;
  artifacts?: ArtifactCollector;
  // 웹 산출물을 올릴 Vercel 프로젝트. 없으면 올리지 않는다.
  artifactVercelProject?: string;
  limit: number;
  leaseUntil: string;
  maxAttempts: number;
  concurrency?: number;
  now?: () => string;
}): Promise<LocalGatewayConsumerResult> {
  const rows = await input.store.leasePendingLocalGateway(input.limit, input.leaseUntil);
  const result: LocalGatewayConsumerResult = { leased: rows.length, completed: 0, retried: 0, dead: 0, rejected: 0 };
  const concurrency = normalizeConcurrency(input.concurrency);

  await runWithConcurrency(rows, concurrency, async (row) => {
    try {
      await processOutboxRow(row, input, result);
    } catch (error) {
      // store 통신 오류 등 예기치 못한 예외 — 이 행 하나 때문에 같은 배치의 다른 행(다른 방) 처리를
      // 막으면 안 된다. 이 행은 상태를 기록하지 못했으므로 processing 으로 남고, locked_until
      // 만료 후 재리스되어 다시 시도된다(기존 순차 처리에서 배치 전체가 죽었을 때와 동일한 복구 경로).
      console.error(JSON.stringify({
        type: "local_gateway_row_processing_error",
        outboxId: row.outboxId,
        error: maskSensitiveOutput(error instanceof Error ? error.message : String(error))
      }));
    }
  });

  return result;
}

async function processOutboxRow(
  row: OutboxRecord,
  input: {
    store: LocalGatewayOutboxStore;
    policy: GatewayPolicy;
    runner: ProcessRunner;
    sink: GatewayEventSink;
    artifacts?: ArtifactCollector;
  // 웹 산출물을 올릴 Vercel 프로젝트. 없으면 올리지 않는다.
  artifactVercelProject?: string;
    maxAttempts: number;
    now?: () => string;
  },
  result: LocalGatewayConsumerResult
): Promise<void> {
  let request: ExecutionRequest;
  try {
    request = parseExecutionRequest(row);
  } catch (error) {
    await input.store.markDead(row.outboxId, maskSensitiveOutput(error instanceof Error ? error.message : String(error)));
    result.dead += 1;
    return;
  }

  const execution = await executeGatewayRequest({
    request,
    policy: input.policy,
    runner: input.runner,
    sink: input.sink,
    artifacts: input.artifacts,
    artifactVercelProject: input.artifactVercelProject,
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
    return;
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
    return;
  }

  await input.store.markDead(row.outboxId, errorKind);
  if (execution.status === "rejected") result.rejected += 1;
  else result.dead += 1;
}

function normalizeConcurrency(concurrency: number | undefined): number {
  if (concurrency === undefined || !Number.isFinite(concurrency) || concurrency < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(concurrency);
}

// 간단한 워커 풀: 외부 라이브러리(세마포어·큐) 없이, 고정 개수의 "워커"가
// 공유 커서를 소진할 때까지 순차로 다음 행을 집어간다. 워커 수 = min(concurrency, rows.length).
// worker 콜백이 개별 행의 예외를 스스로 삼키는 걸 전제한다(호출부 참고) — 그래야 한 워커가
// 죽어도 Promise.all 이 다른 워커까지 끌고 넘어지지 않는다.
async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);

  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
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
