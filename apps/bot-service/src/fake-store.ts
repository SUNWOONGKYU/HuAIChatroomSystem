import { randomUUID } from "node:crypto";
import {
  type ExecutionRequest,
  type GatewayEvent,
  type OutboxRecord,
  type TelegramBotRole,
  type TelegramSendResult
} from "../../../packages/contracts/src/index.js";
import {
  type OutboxDispatcherStore
} from "./outbox.js";
import {
  summarizeTelegramSendResult,
  type OrchestratorPersistencePort,
  type PersistedEvent,
  type PersistedOutboxItem
} from "./persistence.js";

export type FakeStoredArtifact = {
  taskId: string;
  uri: string;
  version: string;
  checksum: string;
  isFinal: boolean;
};

export type FakeStoreSnapshot = {
  events: PersistedEvent[];
  outbox: PersistedOutboxItem[];
  processedUpdates: string[];
  failedUpdates: Array<{ idempotencyKey: string; error: string }>;
  artifacts: FakeStoredArtifact[];
};

export class FakeBotServiceStore implements OrchestratorPersistencePort, OutboxDispatcherStore {
  private readonly events: PersistedEvent[] = [];
  private readonly outbox: PersistedOutboxItem[] = [];
  private readonly processedUpdates = new Set<string>();
  private readonly failedUpdates: Array<{ idempotencyKey: string; error: string }> = [];
  private readonly artifacts: FakeStoredArtifact[] = [];

  async commitTelegramInputResult(input: Parameters<OrchestratorPersistencePort["commitTelegramInputResult"]>[0]) {
    const createdAt = new Date().toISOString();
    const persistedEvents = input.result.events.map((event) => ({
      ...event,
      eventId: randomUUID(),
      createdAt
    }));
    const eventId = persistedEvents[0]?.eventId;
    const persistedOutbox = input.result.outbox.map((item) => ({
      ...item,
      outboxId: randomUUID(),
      eventId,
      status: "pending" as const,
      attempts: 0,
      createdAt
    }));

    this.events.push(...persistedEvents);
    this.outbox.push(...persistedOutbox);
    return { events: persistedEvents, outbox: persistedOutbox };
  }

  async markTelegramUpdateProcessed(idempotencyKey: string): Promise<void> {
    this.processedUpdates.add(idempotencyKey);
  }

  async markTelegramUpdateFailed(idempotencyKey: string, error: string): Promise<void> {
    this.failedUpdates.push({ idempotencyKey, error: maskSensitiveText(error) });
  }

  async leasePending(limit: number): Promise<OutboxRecord[]> {
    const rows = this.outbox
      .filter((row) => row.status === "pending" || row.status === "retry_pending")
      .slice(0, limit);

    const leased = rows.map(toOutboxRecord);
    for (const row of rows) {
      row.status = "processing";
      row.attempts += 1;
    }

    return leased;
  }

  async leasePendingLocalGateway(limit: number): Promise<OutboxRecord[]> {
    const rows = this.outbox
      .filter((row) => (row.status === "pending" || row.status === "retry_pending") && row.target.kind === "local_gateway")
      .slice(0, limit);

    const leased = rows.map(toOutboxRecord);
    for (const row of rows) {
      row.status = "processing";
      row.attempts += 1;
    }

    return leased;
  }
  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    const row = this.requireOutbox(outboxId);
    row.status = "sent";
    row.sentAt = new Date().toISOString();
    row.payload = { ...row.payload, sendResult: summarizeTelegramSendResult(result) };
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string, attemptsOverride?: number): Promise<void> {
    const row = this.requireOutbox(outboxId);
    row.status = "retry_pending";
    row.lastError = maskSensitiveText(error);
    row.nextAttemptAt = nextAttemptAt;
    if (attemptsOverride !== undefined) row.attempts = attemptsOverride;
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    const row = this.requireOutbox(outboxId);
    row.status = "dead";
    row.lastError = maskSensitiveText(error);
  }

  async recordGatewayExecutionResult(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }): Promise<void> {
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const eventType = input.status === "completed" ? "meaningful_intermediate_ready" : "execution_delayed_or_failed";
    const botRole: TelegramBotRole = input.request.reportBotRole ?? (input.request.adapterType === "codex" ? "codex_leader" : "claude_leader");
    this.events.push({
      eventId,
      eventType,
      idempotencyKey: "gateway-result:" + input.request.attemptId + ":" + input.status,
      payload: {
        taskId: input.request.taskId,
        attemptId: input.request.attemptId,
        actorId: input.request.actorId,
        adapterType: input.request.adapterType,
        status: input.status,
        errorKind: maskSensitiveText(input.errorKind ?? ""),
        occurredAt: input.occurredAt,
        events: input.events.map(maskGatewayEvent)
      },
      createdAt
    });
    this.outbox.push({
      outboxId: randomUUID(),
      eventId,
      target: { kind: "telegram_bot", botRole, telegramChatId: "1001" },
      idempotencyKey: "telegram-report:" + input.request.attemptId + ":" + input.status,
      payload: {
        botRole,
        telegramChatId: "1001",
        text: input.status === "completed"
          ? "작업 실행 완료: " + input.request.taskId + "\n검증 요청 대기 상태로 전환할 수 있습니다."
          : "작업 실행 실패: " + input.request.taskId + "\n원인: 실행 중 내부 오류가 발생했습니다. 상세 로그는 운영 기록에서 확인해 주세요.",
        binding: { kind: "event", eventId },
        idempotencyKey: "telegram-report:" + input.request.attemptId + ":" + input.status
      },
      status: "pending",
      attempts: 0,
      createdAt
    });

    if (input.status === "completed") {
      const savedArtifacts = this.storeCollectedArtifacts(input.request, input.events);
      if (savedArtifacts.length > 0) {
        this.events.push({
          eventId: randomUUID(),
          eventType: "artifact_saved",
          idempotencyKey: "artifact-saved:" + input.request.attemptId,
          payload: {
            taskId: input.request.taskId,
            attemptId: input.request.attemptId,
            actorId: input.request.actorId,
            artifactCount: savedArtifacts.length,
            artifacts: savedArtifacts.map((artifact) => ({
              uri: artifact.uri,
              version: artifact.version,
              isFinal: artifact.isFinal
            }))
          },
          createdAt
        });
      }
    }

    if (input.status === "completed" && shouldRequestFakeAutomaticAudit(input.request)) {
      this.outbox.push({
        outboxId: randomUUID(),
        eventId,
        target: { kind: "telegram_bot", botRole: "auditor", telegramChatId: "1001" },
        idempotencyKey: "telegram-audit:" + input.request.attemptId + ":completed",
        payload: {
          botRole: "auditor",
          telegramChatId: "1001",
          text: "검증 요청: " + input.request.taskId + "\n승인·통제는 협업 운영센터에서 처리해 주세요.",
          ownerActionRedirect: true,
          binding: { kind: "verification", verificationId: eventId },
          idempotencyKey: "telegram-audit:" + input.request.attemptId + ":completed"
        },
        status: "pending",
        attempts: 0,
        createdAt
      });
    }
  }

  snapshot(): FakeStoreSnapshot {
    return {
      events: structuredClone(this.events),
      outbox: structuredClone(this.outbox),
      processedUpdates: [...this.processedUpdates],
      failedUpdates: structuredClone(this.failedUpdates),
      artifacts: structuredClone(this.artifacts)
    };
  }

  private storeCollectedArtifacts(request: ExecutionRequest, events: readonly GatewayEvent[]): FakeStoredArtifact[] {
    const saved: FakeStoredArtifact[] = [];
    for (const event of events) {
      if (event.type !== "artifact_collected") continue;
      const uri = event.artifact.uri ?? `${request.projectPath}/${event.artifact.path}`;
      const duplicate = this.artifacts.some(
        (item) => item.taskId === request.taskId && item.uri === uri && item.version === event.artifact.version
      );
      if (duplicate) continue;
      const row: FakeStoredArtifact = {
        taskId: request.taskId,
        uri,
        version: event.artifact.version,
        checksum: event.artifact.checksum,
        isFinal: false
      };
      this.artifacts.push(row);
      saved.push(row);
    }
    return saved;
  }

  private requireOutbox(outboxId: string): PersistedOutboxItem {
    const row = this.outbox.find((item) => item.outboxId === outboxId);
    if (!row) {
      throw new Error("outbox-row-not-found");
    }
    return row;
  }
}

function toOutboxRecord(row: PersistedOutboxItem): OutboxRecord {
  return {
    outboxId: row.outboxId,
    idempotencyKey: row.idempotencyKey,
    target: row.target,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts
  };
}

function maskSensitiveText(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function maskGatewayEvent(event: GatewayEvent): Record<string, unknown> {
  if (event.type === "stdout" || event.type === "stderr") {
    return { type: event.type, text: maskSensitiveText(event.text) };
  }
  if (event.type === "failed") {
    return { ...event, errorKind: maskSensitiveText(event.errorKind) };
  }
  return event;
}




function shouldRequestFakeAutomaticAudit(request: ExecutionRequest): boolean {
  if (process.env.HUAI_AUTO_AUDIT_ENABLED !== "true") return false;
  if (request.reportBotRole === "auditor") return false;
  return /검증|감사|보안|취약|secret|token|credential|배포|마이그레이션|migration|schema|supabase|파일 생성|문서 작성|수정 완료|구현 완료|테스트 통과|build passed|tests passed|typecheck/i.test(request.prompt);
}

