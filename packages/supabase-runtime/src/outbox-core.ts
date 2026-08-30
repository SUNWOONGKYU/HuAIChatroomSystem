// God file 분리(2026-08, 3차) — index.ts 의 SupabaseOutboxStore 에서 뽑아낸 기반
// 인프라. outbox/event idempotent 삽입, outbox 리스/마감, task 상태 전이, 게이트웨이
// 조회 등 다른 모든 책임(리더 판단·감사/검증·실행 후처리)이 공통으로 쓰는 원시 동작만
// 모았다. index.ts 와 rest-client.ts 가 이미 쓰는 패턴(타입 전용 순환 import)을 그대로
// 따라 SupabaseRuntimeConfig 타입은 index.ts 에서 그대로 가져온다.
import nodePath from "node:path";
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import { type OutboxRecord, type TelegramSendResult, type ExecutionRequest } from "../../contracts/src/index.js";
import {
  isForbiddenTransition,
  transitionTaskStatus,
  type TaskStatus,
  type WorkflowContext,
  type WorkflowEventType
} from "../../workflow/src/index.js";
import { gatewaySystemContext, summarizeSupabaseSendResult } from "./message-rendering.js";
import { isUuid, requireSingle } from "./small-utils.js";
import {
  type OutboxRow,
  type EventRow,
  type EventInsertRow,
  type OutboxInsertRow,
  executionRequestFromOutbox,
  isDependencySatisfiedStatus,
  escapePostgrestInValue,
  toOutboxRecord
} from "./outbox-row-mapping.js";
import { SupabaseRestClient } from "./rest-client.js";
import type { SupabaseRuntimeConfig } from "./index.js";

export class SupabaseOutboxCore {
  readonly client: SupabaseRestClient;
  readonly gatewayId?: string;
  readonly miniAppDirectLinkBaseUrl?: string;
  readonly archiveRootDir: string;

  constructor(config: SupabaseRuntimeConfig) {
    this.client = new SupabaseRestClient(config);
    this.gatewayId = config.gatewayId;
    this.miniAppDirectLinkBaseUrl = config.miniAppDirectLinkBaseUrl;
    this.archiveRootDir = config.archiveRootDir ?? nodePath.join("sessions", "rooms");
  }

  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "telegram_bot");
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    const leased = await this.leaseOutbox(limit, leaseUntil, "local_gateway");
    const runnable: OutboxRecord[] = [];
    for (const row of leased) {
      const request = executionRequestFromOutbox(row);
      if (!request || await this.isTaskRunnable(request.taskId)) {
        // 승인 직후 task 는 scheduled 로 materialize 된다. 실제 gateway가 이
        // outbox 를 인수한 시점에 queued_for_gateway 를 기록해야, gateway가
        // 잠시 재시작되거나 실행 결과가 늦어져도 예약 상태에 고착되지 않는다.
        if (request) await this.advanceTaskStatus(request.taskId, "dependencies_satisfied", {});
        runnable.push(row);
        continue;
      }
      await this.patchOutbox(row.outboxId, {
        status: "retry_pending",
        last_error: "waiting-dependencies",
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        locked_until: null
      });
    }
    return runnable;
  }

  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    const updated = await this.client.rpc<boolean>("mark_huai_outbox_sent", {
      p_huai_outbox_id: outboxId,
      p_send_result: summarizeSupabaseSendResult(result)
    });
    if (updated !== true) throw new Error("outbox-state-conflict:mark-sent");
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string, attemptsOverride?: number): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "retry_pending",
      last_error: maskSensitiveText(error),
      next_attempt_at: nextAttemptAt,
      locked_until: null,
      // 429 등 우리 예산을 안 쓴 실패는 lease_huai_outbox 가 이번 리스에서 올린 attempts
      // +1 을 여기서 되돌린다(apps/bot-service/src/outbox.ts 가 계산해서 넘긴다). 생략하면
      // (undefined) 이 키 자체를 body 에서 뺀다 — attempts: undefined 를 그대로 보내면
      // PostgREST 가 이걸 어떻게 다룰지 보장이 없어서, 값이 아니라 키 존재 여부로 분기한다.
      ...(attemptsOverride !== undefined ? { attempts: attemptsOverride } : {})
    });
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "dead",
      last_error: maskSensitiveText(error),
      locked_until: null
    });
  }

  // 보고 전문을 남긴다. 이벤트·아웃박스는 30일 뒤 지우지만 이 행은 남는다 — 안 그러면
  // "전문 보기" 버튼이 30일 뒤 빈 화면이 된다.
  async saveTaskReport(
    request: ExecutionRequest,
    botRole: string,
    body: string
  ): Promise<{ report_id: string } | undefined> {
    if (!isUuid(request.roomId)) return undefined;
    const kind = request.reportBotRole === "auditor" ? "audit" : "execution";
    const response = await this.client.request("POST", "/huai_task_reports", {
      body: {
        room_id: request.roomId,
        task_id: isUuid(request.taskId) ? request.taskId : null,
        attempt_id: request.attemptId,
        kind,
        body,
        bot_role: botRole,
        telegram_message_thread_id: request.telegramMessageThreadId ?? null
      },
      prefer: "return=representation"
    });

    // 409 = 같은 attempt 가 두 번 기록됐다(리스 만료로 중복 실행). 이미 있는 행을 쓴다.
    if (response.status === 409) {
      const existing = await this.client
        .request(
          "GET",
          "/huai_task_reports?attempt_id=eq." + encodeURIComponent(request.attemptId) +
            "&kind=eq." + kind + "&select=report_id&limit=1"
        )
        .then((found) => found.json<Array<{ report_id: string }>>());
      return existing[0];
    }

    await response.expectOk();
    const rows = await response.json<Array<{ report_id: string }>>();
    return rows[0];
  }

  // 승인된 작업이 실행을 거쳐 검증 대기까지 스스로 이동한다.
  // 사람이 눌러야 하는 지점은 시작 승인과 최종 완료 승인 둘뿐이다.
  async advanceTaskThroughExecution(
    taskId: string,
    status: "completed" | "failed" | "rejected",
    completionEvent?: "mid_approval_required"
  ): Promise<void> {
    if (!isUuid(taskId)) return;
    // scheduled -> queued_for_gateway -> in_progress
    await this.advanceTaskStatus(taskId, "dependencies_satisfied", {});
    await this.advanceTaskStatus(taskId, "task_started", {});
    if (status !== "completed") {
      await this.advanceTaskStatus(taskId, "execution_delayed_or_failed", {});
      return;
    }
    if (completionEvent === "mid_approval_required") {
      await this.advanceTaskStatus(taskId, "mid_approval_required", {});
      return;
    }
    // in_progress -> verification_pending (검증 호출은 방장 결정 사항이 아니다)
    await this.advanceTaskStatus(taskId, "meaningful_intermediate_ready", {});
  }

  // 게이트웨이 결과 경로에서도 상태기계를 적용한다.
  // 이 경로는 원래 이벤트만 쓰고 작업 상태를 바꾸지 않아, 실행 결과가 상태기계에 닿지 않았다.
  async advanceTaskStatus(
    taskId: string,
    eventType: WorkflowEventType,
    context: Partial<WorkflowContext>
  ): Promise<void> {
    if (!isUuid(taskId)) return;
    const rows = await this.client
      .request("GET", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId) + "&select=status")
      .then((response) => response.json<Array<{ status: TaskStatus }>>());
    const current = rows[0]?.status;
    if (!current) return;
    if (isForbiddenTransition(current, eventType)) return;
    const decision = transitionTaskStatus(current, eventType, { ...gatewaySystemContext(), ...context });
    if (!decision.allowed) return;
    await this.client
      .request("PATCH", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId), {
        body: { status: decision.nextStatus, updated_at: new Date().toISOString() },
        prefer: "return=minimal"
      })
      .then((response) => response.expectOk());
  }

  async fetchActiveGatewayId(roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_gateway_instances?room_id=eq." + encodeURIComponent(roomId) + "&select=gateway_id,status&order=created_at.asc&limit=20")
      .then((response) => response.json<Array<{ gateway_id: string; status?: string }>>());
    return rows.find((row) => row.status === "online")?.gateway_id ?? rows.find((row) => row.status !== "disabled")?.gateway_id;
  }

  private async isTaskRunnable(taskId: string): Promise<boolean> {
    if (!isUuid(taskId)) return true;
    const dependencies = await this.client
      .request("GET", "/huai_task_dependencies?successor_task_id=eq." + encodeURIComponent(taskId) + "&is_blocking=eq.true&select=predecessor_task_id,dependency_type,is_blocking")
      .then((response) => response.json<Array<{ predecessor_task_id: string; dependency_type: string; is_blocking: boolean }>>());
    const blockingIds = dependencies
      .filter((dependency) => dependency.is_blocking && dependency.dependency_type !== "related")
      .map((dependency) => dependency.predecessor_task_id);
    if (blockingIds.length === 0) return true;

    const quoted = blockingIds.map((id) => '"' + escapePostgrestInValue(id) + '"').join(",");
    const predecessors = await this.client
      .request("GET", "/huai_tasks?task_id=in.(" + encodeURIComponent(quoted) + ")&select=task_id,status")
      .then((response) => response.json<Array<{ task_id: string; status: string }>>());
    const done = new Set(predecessors.filter((task) => isDependencySatisfiedStatus(task.status)).map((task) => task.task_id));
    return blockingIds.every((taskId) => done.has(taskId));
  }

  private async leaseOutbox(limit: number, leaseUntil: string, targetKind: "telegram_bot" | "local_gateway"): Promise<OutboxRecord[]> {
    const rows = await this.client.rpc<OutboxRow[]>("lease_huai_outbox", {
      p_limit: limit,
      p_locked_until: leaseUntil,
      p_target_kind: targetKind,
      // 방마다 게이트웨이를 하나씩 띄우자 서로 남의 일을 집어갔다. 집어간 쪽은 그 폴더를
      // 허용하지 않으니 project-path-not-allowed 로 실패시켰고, 방에는 "작업 실행 실패"가
      // 떴다 — 실패한 게 아니라 받는 사람이 아닌 자가 뜯어본 것이다.
      ...(targetKind === "local_gateway" && this.gatewayId ? { p_gateway_id: this.gatewayId } : {})
    });
    return rows.map(toOutboxRecord);
  }

  private async patchOutbox(outboxId: string, body: Record<string, unknown>): Promise<void> {
    await this.client
      .request("PATCH", `/huai_outbox?huai_outbox_id=eq.${encodeURIComponent(outboxId)}&status=eq.processing`, {
        body,
        prefer: "return=representation"
      })
      .then((response) => response.json<unknown[]>())
      .then((rows) => {
        if (rows.length !== 1) throw new Error("outbox-state-conflict:patch");
      });
  }

  async fetchRoomTelegramChatId(roomId: string): Promise<string> {
    const rows = await this.client
      .request("GET", `/huai_rooms?room_id=eq.${encodeURIComponent(roomId)}&select=telegram_chat_id`)
      .then((response) => response.json<Array<{ telegram_chat_id: string | number }>>());
    const value = rows[0]?.telegram_chat_id;
    if (value === undefined || value === null) throw new Error("room-telegram-chat-id-not-found");
    return String(value);
  }

  async recordHookAttempt(eventId: string, status: "succeeded" | "failed", error?: string): Promise<void> {
    await this.client.request("POST", "/huai_hook_attempts", {
      body: {
        event_id: eventId,
        hook_type: "gateway_result",
        status,
        attempts: 1,
        last_error: error ? maskSensitiveText(error) : null,
        next_attempt_at: new Date().toISOString()
      },
      prefer: "return=minimal"
    }).then((response) => (response.status === 409 ? undefined : response.expectOk()));
  }

  async recordExecutionAttempt(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    occurredAt: string;
    errorKind?: string;
  }): Promise<void> {
    const gatewayId = this.gatewayId;
    const taskId = input.request.taskId;
    if (typeof taskId !== "string" || !isUuid(taskId) || typeof gatewayId !== "string" || !isUuid(gatewayId)) return;
    await this.client.request("POST", "/huai_execution_attempts", {
      body: {
        task_id: taskId,
        gateway_id: gatewayId,
        adapter_type: input.request.adapterType === "claude_code" ? "claude_code" : input.request.adapterType,
        status: input.status === "completed" ? "completed" : "failed",
        attempt_no: 1,
        idempotency_key: "execution-attempt:" + input.request.attemptId,
        started_at: input.request.createdAt ?? input.occurredAt,
        finished_at: input.occurredAt,
        error: input.errorKind ? maskSensitiveText(input.errorKind) : null,
        telemetry: { reportBotRole: input.request.reportBotRole ?? null }
      },
      prefer: "return=minimal"
    }).then((response) => (response.status === 409 ? undefined : response.expectOk())).catch(() => undefined);
  }

  async insertEventIdempotently(row: EventInsertRow): Promise<EventRow> {
    const response = await this.client.request("POST", "/huai_events", {
      body: row,
      prefer: "return=representation"
    });
    if (response.status !== 409) return response.json<EventRow[]>().then((rows) => requireSingle(rows, "event-insert-missing-row"));

    const existing = await this.client
      .request("GET", `/huai_events?idempotency_key=eq.${encodeURIComponent(row.idempotency_key)}&select=event_id,room_id,task_id,event_type,idempotency_key,payload,created_at`)
      .then((found) => found.json<EventRow[]>())
      .then((rows) => requireSingle(rows, "event-idempotency-conflict"));
    if (existing.event_type !== row.event_type) {
      throw new Error("event-idempotency-conflict");
    }
    return existing;
  }

  async insertOutboxIdempotently(row: OutboxInsertRow): Promise<void> {
    const response = await this.client.request("POST", "/huai_outbox", {
      body: row,
      prefer: "return=representation"
    });
    if (response.status !== 409) {
      await response.expectOk();
      return;
    }

    const existing = await this.client
      .request("GET", `/huai_outbox?idempotency_key=eq.${encodeURIComponent(row.idempotency_key)}&select=idempotency_key,target_kind,target,payload`)
      .then((found) => found.json<Array<{ idempotency_key: string; target_kind: string; target: string; payload: Record<string, unknown> }>>())
      .then((rows) => requireSingle(rows, "outbox-idempotency-conflict"));
    if (existing.target_kind !== row.target_kind || existing.target !== row.target) {
      throw new Error("outbox-idempotency-conflict");
    }
  }
}
