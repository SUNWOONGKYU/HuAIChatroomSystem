import { maskTelegramSensitiveText as maskSensitiveText, safeTelegramTraceUri } from "../../../packages/telegram-ui/src/sanitize.js";
import {
  type OutboxRecord,
  type OutboxTarget,
  type TelegramSendResult,
  type TelegramUpdateEnvelope,
  type TelegramUpdateReceipt
} from "../../../packages/contracts/src/index.js";
import {
  summarizeTelegramSendResult,
  type OrchestratorPersistencePort,
  type PersistedEvent,
  type PersistedOutboxItem
} from "./persistence.js";
import { type OutboxDispatcherStore } from "./outbox.js";
import { makeTelegramUpdateIdempotencyKey } from "./index.js";
import { isForbiddenTransition, transitionTaskStatus, type TaskStatus, type WorkflowContext, type WorkflowEventType } from "../../../packages/workflow/src/index.js";
import { summarizeSupabaseSendResult } from "../../../packages/supabase-runtime/src/index.js";
import { isLeaderPlanningAttempt } from "../../../packages/orchestrator/src/index.js";
import { buildLeaderPlanningPrompt, type RoomTurn } from "../../../packages/orchestrator/src/leader-planning.js";

export type SupabaseStoreConfig = {
  url: string;
  serviceRoleKey: string;
  roomId: string;
  fetchImpl?: typeof fetch;
};

export class SupabaseBotServiceStore implements OrchestratorPersistencePort, OutboxDispatcherStore {
  private readonly client: SupabaseRestClient;
  private readonly roomId: string;

  constructor(config: SupabaseStoreConfig) {
    this.roomId = config.roomId;
    this.client = new SupabaseRestClient({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      fetchImpl: config.fetchImpl
    });
  }

  async recordUpdateOnce(
    envelope: TelegramUpdateEnvelope,
    rawUpdate: unknown,
    status: "received" | "ignored"
  ): Promise<TelegramUpdateReceipt> {
    const idempotencyKey = makeTelegramUpdateIdempotencyKey(envelope);
    const row = {
      telegram_bot_id: envelope.telegramBotId,
      update_id: toBigIntString(envelope.updateId, "update_id"),
      telegram_chat_id: toBigIntString(envelope.telegramChatId, "telegram_chat_id"),
      telegram_message_id: envelope.telegramMessageId === undefined ? null : toBigIntString(envelope.telegramMessageId, "telegram_message_id"),
      status,
      raw_update: rawUpdate
    };

    const response = await this.client.request("POST", "/huai_telegram_updates", {
      body: row,
      prefer: "return=representation"
    });

    if (response.status === 409) {
      const existing = await this.fetchExistingUpdate(envelope);
      return {
        inserted: false,
        status: receiptStatus(existing?.status),
        idempotencyKey
      };
    }

    await response.expectOk();
    return { inserted: true, status, idempotencyKey };
  }

  async markUpdateFailed(envelope: TelegramUpdateEnvelope | undefined, reason: string): Promise<void> {
    if (!envelope) return;
    await this.markTelegramUpdateFailed(makeTelegramUpdateIdempotencyKey(envelope), reason);
  }

  async commitTelegramInputResult(input: Parameters<OrchestratorPersistencePort["commitTelegramInputResult"]>[0]) {
    const createdAt = new Date().toISOString();
    const eventsToPersist = input.result.events;

    const eventRows = eventsToPersist.length === 0
      ? []
      : await this.client
          .request("POST", "/huai_events", {
            body: eventsToPersist.map((event) => ({
              room_id: this.roomId,
              task_id: taskIdFromEventPayload(event.payload) ?? null,
              event_type: event.eventType,
              idempotency_key: event.idempotencyKey,
              payload: event.payload
            })),
            prefer: "return=representation"
          })
          .then((response) => response.json<EventRow[]>());

    const persistedEvents = eventRows.map(toPersistedEvent);
    // 승인 기록은 상태 전이보다 먼저 남긴다. 전이나 아웃박스 hydration 이 실패해도
    // "누가 무엇을 승인했는가"는 사실로서 보존되어야 한다 (NFR-02).
    await this.recordApprovals(eventsToPersist);
    await this.applyTaskTransitions(eventsToPersist);
    const fallbackEventId = persistedEvents[0]?.eventId;
    const outboxRows = input.result.outbox.map((item, index) => ({
      event_id: eventIdForOutbox(item.payload.binding, persistedEvents) ?? fallbackEventId,
      idempotency_key: item.idempotencyKey,
      target_kind: item.target.kind,
      target: JSON.stringify(item.target),
      payload: item.payload
    }));

    const planningHydratedRows = await this.hydrateLeaderPlanningRows(outboxRows);
    const executionHydratedOutboxRows = await this.hydrateExecutionOutboxPrompts(planningHydratedRows);
    const hydratedOutboxRows = await this.hydrateTaskQueryOutboxRows(executionHydratedOutboxRows);
    const insertedOutbox = await this.insertOutboxRowsIdempotently(hydratedOutboxRows);

    return {
      events: persistedEvents.map((event) => ({ ...event, createdAt: event.createdAt ?? createdAt })),
      outbox: insertedOutbox.map(toPersistedOutboxItem)
    };
  }

  async markTelegramUpdateProcessed(idempotencyKey: string): Promise<void> {
    const key = parseTelegramUpdateIdempotencyKey(idempotencyKey);
    await this.patchTelegramUpdate(key.telegramBotId, key.updateId, {
      status: "processed",
      processed_at: new Date().toISOString(),
      locked_until: null
    });
  }

  async markTelegramUpdateFailed(idempotencyKey: string, error: string): Promise<void> {
    const key = parseTelegramUpdateIdempotencyKey(idempotencyKey);
    await this.patchTelegramUpdate(key.telegramBotId, key.updateId, {
      status: "failed",
      error: maskSensitiveText(error),
      last_error: maskSensitiveText(error),
      locked_until: null
    });
  }

  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "telegram_bot");
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "local_gateway");
  }

  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    const updated = await this.client.rpc<boolean>("mark_huai_outbox_sent", {
      p_huai_outbox_id: outboxId,
      p_send_result: summarizeSupabaseSendResult(result)
    });
    if (updated !== true) throw new Error("outbox-state-conflict:mark-sent");
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "retry_pending",
      last_error: maskSensitiveText(error),
      next_attempt_at: nextAttemptAt,
      locked_until: null
    });
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "dead",
      last_error: maskSensitiveText(error),
      locked_until: null
    });
  }

  // 방장·소대장의 결정을 append-only 원장에 남긴다.
  // 승인 시점 대상은 proposal 일 수도 task 일 수도 있으므로 받은 식별자를 entity_ref 에 그대로 보존하고,
  // task UUID 를 이미 아는 경우에만 task_id 를 채운다. 이 테이블은 이후 절대 UPDATE 하지 않는다.
  private async recordApprovals(events: readonly OrchestratorPersistencePortEvent[]): Promise<void> {
    const rows = events
      .map((event) => {
        const mapping = approvalRecordForEvent(event.eventType);
        if (!mapping) return undefined;
        const entityRef = approvalEntityRefFromPayload(event.payload);
        const deciderId = approvalDeciderFromPayload(event.payload);
        if (!entityRef || !deciderId) return undefined;
        return {
          room_id: this.roomId,
          task_id: isUuid(entityRef) ? entityRef : null,
          entity_ref: entityRef,
          stage: mapping.stage,
          decision: mapping.decision,
          decider_telegram_user_id: deciderId,
          reason: approvalReasonFromPayload(event.payload),
          // 이벤트와 같은 재시도 도메인이므로 dedup 경계를 이벤트 멱등키와 일치시킨다.
          idempotency_key: event.idempotencyKey
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    for (const row of rows) {
      const response = await this.client.request("POST", "/huai_approvals", {
        body: row,
        prefer: "return=minimal"
      });
      if (response.status === 409) continue;
      await response.expectOk();
    }
  }

  private async fetchApprovalIdForEntity(entityRef: string, stage: ApprovalStage): Promise<string | undefined> {
    const rows = await this.client
      .request(
        "GET",
        "/huai_approvals?entity_ref=eq." + encodeURIComponent(entityRef) +
          "&stage=eq." + encodeURIComponent(stage) +
          "&decision=eq.approved&select=approval_id&order=created_at.asc&limit=1"
      )
      .then((response) => response.json<Array<{ approval_id: string }>>());
    return rows[0]?.approval_id;
  }

  private async applyTaskTransitions(events: readonly OrchestratorPersistencePortEvent[]): Promise<void> {
    for (const event of events) {
      const taskId = taskIdFromEventPayload(event.payload);
      if (!taskId) continue;
      const current = await this.fetchTaskStatus(taskId);
      if (!current) continue;
      // 명시적 금지 전이를 먼저 차단한다. 화이트리스트만으로도 막히지만,
      // 금지 사유를 구분해 보고해야 승인 전 실행 시도를 운영 기록에서 식별할 수 있다.
      if (isForbiddenTransition(current, event.eventType as WorkflowEventType)) {
        throw new Error(`task-transition-forbidden:${event.eventType}:${current}`);
      }
      const decision = transitionTaskStatus(current, event.eventType as WorkflowEventType, workflowContextFromEvent(event));
      if (!decision.allowed) throw new Error(`task-transition-not-allowed:${event.eventType}:${current}:${decision.reason}`);
      await this.patchTaskStatus(taskId, decision.nextStatus);
    }
  }

  private async fetchTaskStatus(taskId: string): Promise<TaskStatus | undefined> {
    const rows = await this.client
      .request("GET", `/huai_tasks?task_id=eq.${encodeURIComponent(taskId)}&select=task_id,status`)
      .then((response) => response.json<Array<{ task_id: string; status: TaskStatus }>>());
    return rows[0]?.status;
  }

  private async patchTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    await this.client
      .request("PATCH", `/huai_tasks?task_id=eq.${encodeURIComponent(taskId)}`, {
        body: { status, updated_at: new Date().toISOString() },
        prefer: "return=representation"
      })
      .then((response) => response.json<unknown[]>())
      .then((rows) => {
        if (rows.length !== 1) throw new Error("task-state-conflict:patch");
      });
  }

  // 소대장 판단 요청에 방의 직전 논의를 실어준다.
  // 오케스트레이터는 순수 함수라 DB 를 못 읽으므로 여기서 채운다.
  private async hydrateLeaderPlanningRows(rows: OutboxInsertRow[]): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const request = executionRequestPayload(row.payload);
      if (!request || typeof request.attemptId !== "string" || !isLeaderPlanningAttempt(request.attemptId)) {
        hydrated.push(row);
        continue;
      }
      const triggeringText = typeof row.payload.triggeringText === "string" ? row.payload.triggeringText : "";
      const telegramChatId = typeof row.payload.telegramChatId === "string" ? row.payload.telegramChatId : undefined;
      const turns = telegramChatId ? await this.fetchRecentRoomTurns(telegramChatId) : [];
      const leader = await this.fetchLeaderActor();
      hydrated.push({
        ...row,
        payload: {
          ...row.payload,
          executionRequest: {
            ...request,
            prompt: buildLeaderPlanningPrompt({ turns, triggeringText }),
            ...(leader?.actor_id ? { actorId: leader.actor_id } : {}),
            ...(leader?.cli_session_id ? { resumeSessionId: leader.cli_session_id } : {})
          }
        }
      });
    }
    return hydrated;
  }

  // 직전 논의 뭉치 — 마지막으로 작업이 만들어진 시점 이후의 방 대화.
  // 그 시점을 못 찾으면 최근 40건으로 자른다.
  private async fetchRecentRoomTurns(telegramChatId: string): Promise<RoomTurn[]> {
    const since = await this.fetchLastWorkCreatedAt();
    const ownerId = await this.fetchOwnerTelegramUserId();
    const filter = since ? "&received_at=gt." + encodeURIComponent(since) : "";
    const rows = await this.client
      .request(
        "GET",
        "/huai_telegram_updates?telegram_chat_id=eq." + encodeURIComponent(telegramChatId) +
          filter + "&select=raw_update,received_at&order=received_at.desc&limit=40"
      )
      .then((response) => response.json<Array<{ raw_update: Record<string, unknown>; received_at?: string }>>())
      .catch(() => []);

    return rows
      .map((row) => roomTurnFromRawUpdate(row.raw_update, ownerId))
      .filter((turn): turn is RoomTurn => Boolean(turn))
      .reverse();
  }

  private async fetchLastWorkCreatedAt(): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_events?room_id=eq." + encodeURIComponent(this.roomId) + "&event_type=eq.owner_task_approved&select=created_at&order=created_at.desc&limit=1")
      .then((response) => response.json<Array<{ created_at?: string }>>())
      .catch(() => []);
    return rows[0]?.created_at;
  }

  private async fetchOwnerTelegramUserId(): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_room_members?room_id=eq." + encodeURIComponent(this.roomId) + "&role=eq.owner&select=telegram_user_id&limit=1")
      .then((response) => response.json<Array<{ telegram_user_id: string | number }>>())
      .catch(() => []);
    const value = rows[0]?.telegram_user_id;
    return value === undefined || value === null ? undefined : String(value);
  }

  private async fetchLeaderActor(): Promise<{ actor_id: string; cli_session_id?: string } | undefined> {
    const rows = await this.client
      .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(this.roomId) + "&role=eq.platoon_leader&select=actor_id,cli_session_id&limit=1")
      .then((response) => response.json<Array<{ actor_id: string; cli_session_id?: string }>>())
      .catch(() => []);
    return rows[0];
  }

  private async hydrateExecutionOutboxPrompts(rows: Array<{
    event_id: string | undefined;
    idempotency_key: string;
    target_kind: OutboxRow["target_kind"];
    target: string;
    payload: Record<string, unknown>;
  }>): Promise<Array<{
    event_id: string | undefined;
    idempotency_key: string;
    target_kind: OutboxRow["target_kind"];
    target: string;
    payload: Record<string, unknown>;
  }>> {
    const proposalIds = Array.from(new Set(rows.map((row) => proposalIdNeedingPromptHydration(row)).filter((value): value is string => Boolean(value))));
    if (proposalIds.length === 0) return rows;

    const hintsByProposalId = await this.fetchProposalExecutionHints(proposalIds);
    const requestedRoles = Array.from(new Set(Array.from(hintsByProposalId.values()).flatMap((hint) => requestedExecutionRolesForHint(hint))));
    const actorsByRole = await this.fetchActiveExecutionActorsByRole(requestedRoles);
    const hydrated: Array<{
      event_id: string | undefined;
      idempotency_key: string;
      target_kind: OutboxRow["target_kind"];
      target: string;
      payload: Record<string, unknown>;
    }> = [];

    for (const row of rows) {
      const proposalId = proposalIdNeedingPromptHydration(row);
      const hint = proposalId ? hintsByProposalId.get(proposalId) : undefined;
      if (!proposalId || !hint?.prompt) {
        hydrated.push(row);
        continue;
      }
      const executionRequest = executionRequestPayload(row.payload);
      if (!executionRequest) {
        hydrated.push(row);
        continue;
      }
      const primaryActor = hint.executionMode === "multi_ai_review"
        ? actorsByRole.get("codex_leader") ?? actorsByRole.get("claude_leader")
        : hint.requestedActorRole ? actorsByRole.get(hint.requestedActorRole) : undefined;
      const taskId = await this.ensureApprovedProposalTask(proposalId, hint, primaryActor?.actor_id);
      const taskExecutionRequest = { ...executionRequest, taskId, sourceProposalId: proposalId };
      if (hint.executionMode === "multi_ai_review") {
        hydrated.push(...buildMultiAiExecutionRows(row, taskExecutionRequest, hint, actorsByRole));
        continue;
      }
      const actor = hint.requestedActorRole ? actorsByRole.get(hint.requestedActorRole) : undefined;
      hydrated.push({ ...row, payload: { ...row.payload, executionRequest: { ...taskExecutionRequest, ...(actor ? { actorId: actor.actor_id, adapterType: actor.adapter_type } : {}), prompt: hint.prompt } } });
    }

    return hydrated;
  }

  private async fetchProposalExecutionHints(proposalIds: readonly string[]): Promise<Map<string, ProposalExecutionHint>> {
    if (proposalIds.length === 0) return new Map();
    const rows = await this.client
      .request("GET", "/huai_events?event_type=eq.proposal_created&select=payload,created_at&order=created_at.desc&limit=200")
      .then((response) => response.json<Array<{ payload: Record<string, unknown> }>>());
    const wanted = new Set(proposalIds);
    const hints = new Map<string, ProposalExecutionHint>();
    for (const row of rows) {
      const proposalId = typeof row.payload.proposalId === "string" ? row.payload.proposalId : undefined;
      if (!proposalId || !wanted.has(proposalId) || hints.has(proposalId)) continue;
      const prompt = proposalPromptFromPayload(row.payload);
      if (prompt) hints.set(proposalId, { prompt, title: proposalTitleFromPayload(row.payload), requestedActorRole: proposalActorRoleFromPayload(row.payload), executionMode: proposalExecutionModeFromPayload(row.payload), rawText: proposalRequestTextFromPayload(row.payload), purpose: proposalFieldFromPayload(row.payload, "purpose"), scope: proposalFieldFromPayload(row.payload, "scope"), completionCriteria: proposalFieldFromPayload(row.payload, "completionCriteria") });
    }
    return hints;
  }

  private async fetchActiveExecutionActorsByRole(roles: readonly ExecutionActorRole[]): Promise<Map<ExecutionActorRole, ExecutionActorRow>> {
    if (roles.length === 0) return new Map();
    const quoted = roles.map((role) => '"' + escapePostgrestInValue(role) + '"').join(",");
    const rows = await this.client
      .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(this.roomId) + "&role=in.(" + encodeURIComponent(quoted) + ")&status=eq.active&select=actor_id,role,adapter_type")
      .then((response) => response.json<ExecutionActorRow[]>());
    return new Map(rows.map((row) => [row.role, row]));
  }

  private async ensureApprovedProposalTask(proposalId: string, hint: ProposalExecutionHint, assigneeActorId: string | undefined): Promise<string> {
    const proposalUuid = uuidFromProposalId(proposalId);
    const existing = proposalUuid ? await this.fetchTaskByProposalId(proposalUuid) : undefined;
    if (existing) return existing.task_id;

    if (proposalUuid) {
      await this.insertProposalIfMissing(proposalUuid, hint);
    }

    const taskRows = await this.insertTaskForProposal(proposalId, proposalUuid, hint, assigneeActorId);
    return taskRows[0]?.task_id ?? await this.fetchTaskIdByIdempotencyKey(taskIdempotencyKey(proposalId));
  }

  private async fetchTaskByProposalId(proposalUuid: string): Promise<{ task_id: string } | undefined> {
    const rows = await this.client
      .request("GET", "/huai_tasks?proposal_id=eq." + encodeURIComponent(proposalUuid) + "&select=task_id&limit=1")
      .then((response) => response.json<Array<{ task_id: string }>>());
    return rows[0];
  }

  private async fetchTaskIdByIdempotencyKey(idempotencyKey: string): Promise<string> {
    const rows = await this.client
      .request("GET", "/huai_tasks?idempotency_key=eq." + encodeURIComponent(idempotencyKey) + "&select=task_id&limit=1")
      .then((response) => response.json<Array<{ task_id: string }>>());
    const taskId = rows[0]?.task_id;
    if (!taskId) throw new Error("approved-task-materialization-missing");
    return taskId;
  }

  private async insertProposalIfMissing(proposalUuid: string, hint: ProposalExecutionHint): Promise<void> {
    const response = await this.client.request("POST", "/huai_task_proposals", {
      body: {
        proposal_id: proposalUuid,
        room_id: this.roomId,
        title: hint.title,
        purpose: hint.purpose ?? hint.title,
        scope: hint.scope ?? hint.rawText ?? hint.title,
        completion_criteria: hint.completionCriteria ?? DEFAULT_COMPLETION_CRITERIA,
        status: "approved",
        decided_at: new Date().toISOString()
      },
      prefer: "return=minimal"
    });
    if (response.status !== 409) await response.expectOk();
  }

  private async insertTaskForProposal(proposalId: string, proposalUuid: string | undefined, hint: ProposalExecutionHint, assigneeActorId: string | undefined): Promise<Array<{ task_id: string }>> {
    // 승인 원장은 절대 수정하지 않는다. 대신 task 를 만들 때 그 task 가 어느 승인으로 생겼는지를
    // 여기서 한 번 연결한다 (AC-08 "완료 전 3단계 승인 증거").
    const approvalId = await this.fetchApprovalIdForEntity(proposalId, "task_approval");
    const response = await this.client.request("POST", "/huai_tasks", {
      body: {
        room_id: this.roomId,
        proposal_id: proposalUuid ?? null,
        approved_by_approval_id: approvalId ?? null,
        assignee_actor_id: assigneeActorId ?? null,
        idempotency_key: taskIdempotencyKey(proposalId),
        status: "scheduled",
        title: hint.title,
        purpose: hint.purpose ?? hint.title,
        scope: hint.scope ?? hint.rawText ?? hint.title,
        completion_criteria: hint.completionCriteria ?? DEFAULT_COMPLETION_CRITERIA
      },
      prefer: "return=representation"
    });
    if (response.status === 409) return [{ task_id: await this.fetchTaskIdByIdempotencyKey(taskIdempotencyKey(proposalId)) }];
    return response.json<Array<{ task_id: string }>>();
  }

  private async hydrateTaskQueryOutboxRows(rows: OutboxInsertRow[]): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const query = taskQueryPayload(row.payload);
      if (!query || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }

      const text = query.kind === "tasks"
        ? await this.renderTaskListQuery(query.limit)
        : query.kind === "search"
          ? await this.renderTaskSearchQuery(query.term)
          : query.kind === "trace"
            ? await this.renderTaskTraceQuery(query.taskId)
            : await this.renderTaskDetailQuery(query.taskId);
      hydrated.push({ ...row, payload: { ...row.payload, text } });
    }
    return hydrated;
  }

  private async renderTaskListQuery(limit: number): Promise<string> {
    const safeLimit = Math.max(1, Math.min(limit, 20));
    const rows = await this.client
      .request("GET", "/huai_tasks?room_id=eq." + encodeURIComponent(this.roomId) + "&select=task_id,title,status,priority,assignee_actor_id,updated_at,created_at&order=updated_at.desc&limit=" + safeLimit)
      .then((response) => response.json<TaskSummaryRow[]>());

    if (rows.length === 0) return "작업 목록\n현재 등록된 작업이 없습니다.";
    return [
      "작업 목록",
      ...rows.map((task, index) => `${index + 1}. ${shortTaskId(task.task_id)} · ${task.title || "제목 없음"}\n상태: ${humanTaskStatus(task.status)}${task.priority ? ` · 우선순위: ${task.priority}` : ""}`)
    ].join("\n");
  }

  private async renderTaskSearchQuery(term: string): Promise<string> {
    const normalized = term.trim();
    if (!normalized) return "작업 검색\n검색어를 함께 보내주세요. 예: /search 버튼";
    const encodedTerm = encodeURIComponent("*" + normalized.replace(/[*,()]/g, " ").trim() + "*");
    const rows = await this.client
      .request("GET", "/huai_tasks?room_id=eq." + encodeURIComponent(this.roomId) + "&or=(title.ilike." + encodedTerm + ",purpose.ilike." + encodedTerm + ",scope.ilike." + encodedTerm + ")&select=task_id,title,status,priority,assignee_actor_id,updated_at,created_at&order=updated_at.desc&limit=10")
      .then((response) => response.json<TaskSummaryRow[]>());
    if (rows.length === 0) return "작업 검색\n검색 결과가 없습니다: " + normalized;
    return [
      "작업 검색: " + normalized,
      ...rows.map((task, index) => `${index + 1}. ${shortTaskId(task.task_id)} · ${task.title || "제목 없음"}\n상태: ${humanTaskStatus(task.status)}`)
    ].join("\n");
  }
  private async renderTaskTraceQuery(taskId: string): Promise<string> {
    const normalizedTaskId = taskId.trim();
    if (!isUuid(normalizedTaskId)) return "작업 이력\n작업 UUID를 함께 보내주세요. 예: /trace <task_id>";

    const encodedTaskId = encodeURIComponent(normalizedTaskId);
    const [events, artifacts, verifications] = await Promise.all([
      this.client
        .request("GET", "/huai_events?task_id=eq." + encodedTaskId + "&select=event_type,created_at&order=created_at.desc&limit=10")
        .then((response) => response.json<TaskTraceEventRow[]>()),
      this.client
        .request("GET", "/huai_artifacts?task_id=eq." + encodedTaskId + "&select=uri,version,is_final,created_at&order=created_at.desc&limit=10")
        .then((response) => response.json<TaskTraceArtifactRow[]>()),
      this.client
        .request("GET", "/huai_verifications?task_id=eq." + encodedTaskId + "&select=verdict,target_version,created_at&order=created_at.desc&limit=10")
        .then((response) => response.json<TaskTraceVerificationRow[]>())
    ]);

    return [
      "작업 이력: " + shortTaskId(normalizedTaskId),
      "이벤트:",
      ...(events.length === 0 ? ["- 없음"] : events.map((event) => "- " + event.event_type + formatTraceTime(event.created_at))),
      "산출물:",
      ...(artifacts.length === 0 ? ["- 없음"] : artifacts.map((artifact) => "- " + artifact.version + (artifact.is_final ? " · final" : "") + " · " + safeTelegramTraceUri(artifact.uri) + formatTraceTime(artifact.created_at))),
      "검증:",
      ...(verifications.length === 0 ? ["- 없음"] : verifications.map((verification) => "- " + verification.verdict + " · " + verification.target_version + formatTraceTime(verification.created_at)))
    ].join("\n");
  }

  private async renderTaskDetailQuery(taskId: string): Promise<string> {
    const normalizedTaskId = taskId.trim();
    if (!normalizedTaskId) return "작업 상세\n작업 ID를 함께 보내주세요. 예: /task task_id";

    const task = normalizedTaskId.startsWith("proposal_")
      ? await this.fetchTaskDetailByProposalId(normalizedTaskId)
      : await this.fetchTaskDetailByTaskId(normalizedTaskId);
    if (!task) return `작업 상세\n해당 작업을 찾지 못했습니다: ${normalizedTaskId}`;

    return [
      "작업 상세",
      `ID: ${shortTaskId(task.task_id)}`,
      `작업: ${task.title || "제목 없음"}`,
      `상태: ${humanTaskStatus(task.status)}`,
      task.priority ? `우선순위: ${task.priority}` : undefined,
      task.purpose ? `목적: ${task.purpose}` : undefined,
      task.scope ? `범위: ${task.scope}` : undefined,
      task.completion_criteria ? `완료 기준: ${task.completion_criteria}` : undefined,
      task.updated_at ? `최근 갱신: ${task.updated_at}` : undefined
    ].filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
  }

  private async fetchTaskDetailByTaskId(taskId: string): Promise<TaskDetailRow | undefined> {
    if (!isUuid(taskId)) return undefined;
    const rows = await this.client
      .request("GET", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId) + "&select=task_id,title,status,priority,purpose,scope,completion_criteria,updated_at,created_at&limit=1")
      .then((response) => response.json<TaskDetailRow[]>());
    return rows[0];
  }

  private async fetchTaskDetailByProposalId(proposalId: string): Promise<TaskDetailRow | undefined> {
    const proposalUuid = uuidFromProposalId(proposalId);
    const query = proposalUuid
      ? "proposal_id=eq." + encodeURIComponent(proposalUuid)
      : "idempotency_key=eq." + encodeURIComponent(taskIdempotencyKey(proposalId));
    const rows = await this.client
      .request("GET", "/huai_tasks?" + query + "&select=task_id,title,status,priority,purpose,scope,completion_criteria,updated_at,created_at&limit=1")
      .then((response) => response.json<TaskDetailRow[]>());
    return rows[0];
  }
  private async insertOutboxRowsIdempotently(rows: Array<{
    event_id: string | undefined;
    idempotency_key: string;
    target_kind: OutboxRow["target_kind"];
    target: string;
    payload: Record<string, unknown>;
  }>): Promise<OutboxRow[]> {
    if (rows.length === 0) return [];
    const body = rows.map((row) => ({ ...row, event_id: row.event_id ?? null }));
    const response = await this.client.request("POST", "/huai_outbox", {
      body,
      prefer: "return=representation"
    });
    if (response.status !== 409) return response.json<OutboxRow[]>();

    const existing = await this.fetchOutboxRowsByIdempotencyKeys(rows.map((row) => row.idempotency_key));
    const existingByKey = new Map(existing.map((row) => [row.idempotency_key, row]));
    for (const row of rows) {
      const found = existingByKey.get(row.idempotency_key);
      if (!found || !sameOutboxContent(row, found)) {
        throw new Error("outbox-idempotency-conflict");
      }
    }
    return rows.map((row) => existingByKey.get(row.idempotency_key)).filter((row): row is OutboxRow => Boolean(row));
  }

  private async fetchOutboxRowsByIdempotencyKeys(keys: string[]): Promise<OutboxRow[]> {
    const quoted = keys.map((key) => '"' + escapePostgrestInValue(key) + '"').join(",");
    return this.client
      .request("GET", "/huai_outbox?idempotency_key=in.(" + encodeURIComponent(quoted) + ")&select=huai_outbox_id,event_id,idempotency_key,target_kind,target,payload,status,attempts,created_at,sent_at,last_error")
      .then((response) => response.json<OutboxRow[]>());
  }

  private async leaseOutbox(limit: number, leaseUntil: string, targetKind: "telegram_bot" | "local_gateway"): Promise<OutboxRecord[]> {
    const rows = await this.client.rpc<OutboxRow[]>("lease_huai_outbox", {
      p_limit: limit,
      p_locked_until: leaseUntil,
      p_target_kind: targetKind
    });
    return rows.map(toOutboxRecord);
  }

  private async fetchExistingUpdate(envelope: TelegramUpdateEnvelope): Promise<TelegramUpdateRow | undefined> {
    const rows = await this.client
      .request("GET", `/huai_telegram_updates?telegram_bot_id=eq.${encodeURIComponent(envelope.telegramBotId)}&update_id=eq.${encodeURIComponent(envelope.updateId)}&select=status`)
      .then((response) => response.json<TelegramUpdateRow[]>());
    return rows[0];
  }

  private async patchTelegramUpdate(telegramBotId: string, updateId: string, body: Record<string, unknown>): Promise<void> {
    await this.client
      .request("PATCH", `/huai_telegram_updates?telegram_bot_id=eq.${encodeURIComponent(telegramBotId)}&update_id=eq.${encodeURIComponent(updateId)}`, { body })
      .then((response) => response.expectOk());
  }

  private async patchOutbox(outboxId: string, body: Record<string, unknown>): Promise<void> {
    await this.client
      .request("PATCH", `/huai_outbox?huai_outbox_id=eq.${encodeURIComponent(outboxId)}&status=eq.processing`, {
        body,
        prefer: "return=representation"
      })
      .then((response) => response.json<OutboxRow[]>())
      .then((rows) => {
        if (rows.length !== 1) throw new Error("outbox-state-conflict:patch");
      });
  }
}

export function buildSupabaseBotServiceStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    roomId: requiredEnv(env, "BOT_SERVICE_ROOM_ID")
  });
}

class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: { url: string; serviceRoleKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = input.url.replace(/\/+$/, "");
    this.serviceRoleKey = input.serviceRoleKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async rpc<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rpc/${name}`, { body }).then((response) => response.json<T>());
  }

  async request(method: string, path: string, options: { body?: unknown; prefer?: string } = {}): Promise<SupabaseRestResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      method,
      headers: stripUndefined({
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: options.prefer
      }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return new SupabaseRestResponse(response);
  }
}

class SupabaseRestResponse {
  constructor(private readonly response: Response) {}

  get status(): number {
    return this.response.status;
  }

  async expectOk(): Promise<void> {
    if (!this.response.ok) {
      throw new Error(`supabase-rest-error:${this.response.status}:${await safeResponseText(this.response)}`);
    }
  }

  async json<T>(): Promise<T> {
    await this.expectOk();
    if (this.response.status === 204) return undefined as T;
    return (await this.response.json()) as T;
  }
}

type OrchestratorPersistencePortEvent = Parameters<OrchestratorPersistencePort["commitTelegramInputResult"]>[0]["result"]["events"][number];

type EventRow = {
  event_id: string;
  room_id: string;
  task_id?: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type OutboxRow = {
  huai_outbox_id: string;
  event_id?: string | null;
  idempotency_key: string;
  target_kind: "telegram_bot" | "local_gateway";
  target: string | OutboxTarget;
  payload: Record<string, unknown>;
  status: PersistedOutboxItem["status"];
  attempts: number;
  created_at: string;
  sent_at?: string | null;
  last_error?: string | null;
};

type TelegramUpdateRow = {
  status?: string;
};

type ExecutionActorRole = "claude_leader" | "codex_leader";

type ProposalExecutionHint = {
  prompt: string;
  title: string;
  requestedActorRole?: ExecutionActorRole;
  executionMode?: "multi_ai_review";
  rawText?: string;
  // FR-007: 제안 단계에서 구조화된 목적·범위·완료조건. 완료조건은 검증 판정 기준이 된다.
  purpose?: string;
  scope?: string;
  completionCriteria?: string;
};

type OutboxInsertRow = {
  event_id: string | undefined;
  idempotency_key: string;
  target_kind: OutboxRow["target_kind"];
  target: string;
  payload: Record<string, unknown>;
};

type ExecutionActorRow = {
  actor_id: string;
  role: ExecutionActorRole;
  adapter_type: "claude_code" | "codex";
};


type TaskSummaryRow = {
  task_id: string;
  title?: string | null;
  status: TaskStatus;
  priority?: string | null;
  assignee_actor_id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

type TaskDetailRow = TaskSummaryRow & {
  purpose?: string | null;
  scope?: string | null;
  completion_criteria?: string | null;
};

type TaskTraceEventRow = {
  event_type: string;
  created_at?: string | null;
};

type TaskTraceArtifactRow = {
  uri: string;
  version: string;
  is_final?: boolean | null;
  created_at?: string | null;
};

type TaskTraceVerificationRow = {
  verdict: string;
  target_version: string;
  created_at?: string | null;
};

type TaskQueryPayload =
  | { kind: "tasks"; limit: number }
  | { kind: "task"; taskId: string }
  | { kind: "search"; term: string }
  | { kind: "trace"; taskId: string };
function taskQueryPayload(payload: Record<string, unknown>): TaskQueryPayload | undefined {
  const value = payload.query;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  if (query.kind === "tasks") {
    const limit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.trunc(query.limit) : 10;
    return { kind: "tasks", limit };
  }
  if (query.kind === "task") {
    return { kind: "task", taskId: typeof query.taskId === "string" ? query.taskId : "" };
  }
  if (query.kind === "search") {
    return { kind: "search", term: typeof query.term === "string" ? query.term : "" };
  }
  if (query.kind === "trace") {
    return { kind: "trace", taskId: typeof query.taskId === "string" ? query.taskId : "" };
  }
  return undefined;
}


function formatTraceTime(value?: string | null): string {
  return value ? " · " + value : "";
}

function shortTaskId(taskId: string): string {
  return taskId.length <= 12 ? taskId : taskId.slice(0, 8);
}

function humanTaskStatus(status: string): string {
  switch (status) {
    case "proposed":
      return "제안됨";
    case "approved":
      return "승인됨";
    case "scheduled":
      return "실행 대기";
    case "running":
      return "실행 중";
    case "blocked":
      return "조치 필요";
    case "verification_requested":
      return "검증 대기";
    case "verified":
      return "검증 완료";
    case "commander_completed":
      return "완료 승인 대기";
    case "completed":
      return "완료";
    case "cancelled":
      return "취소됨";
    case "proposal_rejected":
    case "rejected_or_cancelled":
      return "반려됨";
    default:
      return status;
  }
}
function requestedExecutionRolesForHint(hint: ProposalExecutionHint): ExecutionActorRole[] {
  if (hint.executionMode === "multi_ai_review") return ["claude_leader", "codex_leader"];
  return hint.requestedActorRole ? [hint.requestedActorRole] : [];
}

function buildMultiAiExecutionRows(row: OutboxInsertRow, executionRequest: Record<string, unknown>, hint: ProposalExecutionHint, actorsByRole: Map<ExecutionActorRole, ExecutionActorRow>): OutboxInsertRow[] {
  const baseAttemptId = typeof executionRequest.attemptId === "string" ? executionRequest.attemptId : "attempt";
  const rows: OutboxInsertRow[] = [];
  const claude = actorsByRole.get("claude_leader");
  const codex = actorsByRole.get("codex_leader");
  const requestText = hint.rawText ?? hint.prompt;
  if (claude) rows.push(buildRoleExecutionRow(row, executionRequest, "claude", claude, buildRoleSpecificPrompt("claude_leader", requestText), `${baseAttemptId}-claude`));
  if (codex) rows.push(buildRoleExecutionRow(row, executionRequest, "codex", codex, buildRoleSpecificPrompt("codex_leader", requestText), `${baseAttemptId}-codex`));
  return rows.length > 0 ? rows : [{ ...row, payload: { ...row.payload, executionRequest: { ...executionRequest, prompt: hint.prompt } } }];
}

function buildRoleExecutionRow(row: OutboxInsertRow, executionRequest: Record<string, unknown>, suffix: string, actor: ExecutionActorRow, prompt: string, attemptId: string): OutboxInsertRow {
  return { ...row, idempotency_key: row.idempotency_key + ":" + suffix, payload: { ...row.payload, executionRequest: { ...executionRequest, attemptId, actorId: actor.actor_id, adapterType: actor.adapter_type, prompt, reportBotRole: actor.role } } };
}

function buildRoleSpecificPrompt(role: "claude_leader" | "codex_leader" | "auditor", requestText: string): string {
  const roleLine = role === "claude_leader"
    ? "역할: ClaudeBot. 설계 관점, 누락 위험, 보완 의견을 제시하세요."
    : role === "codex_leader"
      ? "역할: CodexBot. 구현 관점, 실행 가능성, 필요한 코드 조치를 제시하세요."
      : "역할: AuditBot. ClaudeBot과 CodexBot 결과를 독립 검증할 기준과 최종 판정을 제시하세요.";
  return [
    "HuAI Collab Chatroom System의 승인된 다중 AI 협의 작업입니다.",
    roleLine,
    "사람이 알아야 할 결론과 필요한 조치만 간결하게 보고하세요.",
    "내부 JSON, hook log, stack trace, token, API key, 원문 시크릿은 출력하지 마세요.",
    "",
    "USER_REQUEST:",
    requestText
  ].join("\n");
}

function proposalExecutionModeFromPayload(payload: Record<string, unknown>): "multi_ai_review" | undefined {
  return payload.intent === "multi_ai_review" ? "multi_ai_review" : undefined;
}

// Telegram raw update 에서 사람 발화만 뽑는다. 봇 메시지와 콜백은 대화가 아니다.
function roomTurnFromRawUpdate(rawUpdate: Record<string, unknown>, ownerTelegramUserId: string | undefined): RoomTurn | undefined {
  const message = (rawUpdate?.message ?? undefined) as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const from = message.from as Record<string, unknown> | undefined;
  if (from?.is_bot === true) return undefined;
  const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const userId = from?.id === undefined ? undefined : String(from.id);
  const isOwner = Boolean(userId && ownerTelegramUserId && userId === ownerTelegramUserId);
  const speaker = isOwner ? "방장" : nameFromTelegramUser(from, userId);
  return { speaker, text: maskSensitiveText(trimmed).slice(0, 500), isOwner };
}

function nameFromTelegramUser(from: Record<string, unknown> | undefined, userId: string | undefined): string {
  const first = typeof from?.first_name === "string" ? from.first_name.trim() : "";
  const username = typeof from?.username === "string" ? from.username.trim() : "";
  return first || username || (userId ? "참여자" + userId.slice(-4) : "참여자");
}

function proposalTitleFromPayload(payload: Record<string, unknown>): string {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  return title || rawText.slice(0, 80) || "승인된 Telegram 작업";
}

// 완료 조건이 없으면 검증자가 판정할 기준이 없다. 제안 단계에서 못 뽑았을 때만 쓰는 최후 기본값.
const DEFAULT_COMPLETION_CRITERIA = "요청 내용이 실제로 수행되어 결과가 확인 가능한 형태로 보고된다.";

function proposalFieldFromPayload(payload: Record<string, unknown>, key: "purpose" | "scope" | "completionCriteria"): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function proposalRequestTextFromPayload(payload: Record<string, unknown>): string | undefined {
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  return rawText || title || undefined;
}
function proposalIdNeedingPromptHydration(row: {
  target_kind: OutboxRow["target_kind"];
  payload: Record<string, unknown>;
}): string | undefined {
  if (row.target_kind !== "local_gateway") return undefined;
  const executionRequest = executionRequestPayload(row.payload);
  if (!executionRequest) return undefined;
  const taskId = executionRequest.taskId;
  if (typeof taskId !== "string" || !taskId.startsWith("proposal_")) return undefined;
  const prompt = executionRequest.prompt;
  if (typeof prompt === "string" && prompt.trim() && !prompt.startsWith("Execute approved task ")) return undefined;
  return taskId;
}

function executionRequestPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = payload.executionRequest;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function proposalPromptFromPayload(payload: Record<string, unknown>): string | undefined {
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const requestText = rawText || title;
  if (!requestText) return undefined;
  return buildApprovedTelegramTaskPrompt(requestText);
}

function proposalActorRoleFromPayload(payload: Record<string, unknown>): ExecutionActorRole | undefined {
  const value = payload.requestedActorRole;
  if (value === "claude_leader" || value === "codex_leader") return value;
  return undefined;
}

function buildApprovedTelegramTaskPrompt(requestText: string): string {
  return [
    "You are CodexBot executing an approved Telegram project-room task for the HuAI Collab Chatroom System.",
    "Treat the Telegram user request below as authoritative.",
    "Do not call this product an MVP. Use '완성 제품' or '정식 운영 버전' when describing scope.",
    "For project progress or operation-status questions, inspect OPERATION_STATUS.md first if it exists, then verify live scripts or runtime state before reporting.",
    "Do not infer that Telegram/Supabase/webhook/local-gateway operation is incomplete only because older Gate documents describe setup steps.",
    "Report only verified facts. If a check cannot run, say exactly which check failed.",
    "",
    "USER_REQUEST:",
    requestText
  ].join("\n");
}

function uuidFromProposalId(proposalId: string): string | undefined {
  const value = proposalId.startsWith("proposal_") ? proposalId.slice("proposal_".length) : proposalId;
  return isUuid(value) ? value : undefined;
}

function taskIdempotencyKey(proposalId: string): string {
  return "task:approved-proposal:" + proposalId;
}
function workflowContextFromEvent(event: OrchestratorPersistencePortEvent): WorkflowContext {
  const payload = event.payload;
  const actorRole = stringValue(payload.actorRole) ?? inferredActorRoleFromEvent(event.eventType);
  const actorId = stringValue(payload.actorId);
  const verifierActorId = stringValue(payload.verifierActorId) ?? (actorRole === "auditor" ? actorId : undefined);
  return {
    actorRole,
    isOwner: actorRole === "human_owner" || event.eventType.startsWith("owner_"),
    isAssignee: actorRole === "claude_leader" || actorRole === "codex_leader",
    isVerifier: actorRole === "auditor" || Boolean(verifierActorId),
    authorActorId: stringValue(payload.authorActorId),
    verifierActorId,
    hasOwnerTaskApproval: booleanValue(payload.hasOwnerTaskApproval),
    hasVerificationPass: booleanValue(payload.hasVerificationPass),
    hasCommanderCompletionDecision: booleanValue(payload.hasCommanderCompletionDecision),
    hasOwnerFinalApproval: booleanValue(payload.hasOwnerFinalApproval),
    changedScope: changedScopeValue(payload.changedScope),
    idempotencyKey: event.idempotencyKey
  };
}

// 승인성 이벤트 -> huai_approvals 의 (stage, decision).
// 기획서 FR-008 / FR-015 / AC-08 이 요구하는 "완료 전 3단계 승인 증거"를 남기기 위한 매핑이다.
// 여기에 없는 이벤트는 승인 기록 대상이 아니다.
const APPROVAL_STAGE_BY_EVENT: Readonly<Record<string, { stage: ApprovalStage; decision: ApprovalDecision }>> = {
  owner_task_approved: { stage: "task_approval", decision: "approved" },
  owner_task_rejected: { stage: "task_approval", decision: "rejected" },
  proposal_rejected: { stage: "task_approval", decision: "rejected" },
  proposal_revision_requested: { stage: "task_approval", decision: "revision_requested" },
  owner_mid_approved: { stage: "midpoint_approval", decision: "approved" },
  owner_mid_rejected: { stage: "midpoint_approval", decision: "rejected" },
  commander_completion_approved: { stage: "commander_completion", decision: "approved" },
  owner_final_approved: { stage: "final_approval", decision: "approved" },
  owner_final_rejected: { stage: "final_approval", decision: "rejected" },
  owner_supplement_requested: { stage: "final_approval", decision: "revision_requested" },
  owner_cancel_requested: { stage: "cancellation", decision: "cancelled" },
  cancel_approved: { stage: "cancellation", decision: "cancelled" }
};

export type ApprovalStage = "task_approval" | "midpoint_approval" | "commander_completion" | "final_approval" | "cancellation";
export type ApprovalDecision = "approved" | "rejected" | "revision_requested" | "cancelled";

export function approvalRecordForEvent(eventType: string): { stage: ApprovalStage; decision: ApprovalDecision } | undefined {
  return APPROVAL_STAGE_BY_EVENT[eventType];
}

// 승인 시점 대상 식별자. proposal 단계면 "proposal_xxxx", 이후 단계면 task UUID 가 들어온다.
export function approvalEntityRefFromPayload(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.entityId) ?? stringValue(payload.targetId) ?? stringValue(payload.taskId) ?? stringValue(payload.proposalId);
}

export function approvalDeciderFromPayload(payload: Record<string, unknown>): string | undefined {
  const value = payload.telegramUserId ?? payload.deciderTelegramUserId;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? value.trim() : undefined;
}

export function approvalReasonFromPayload(payload: Record<string, unknown>): string | null {
  const reason = stringValue(payload.reason) ?? stringValue(payload.rawText);
  return reason ? maskSensitiveText(reason).slice(0, 2000) : null;
}

function inferredActorRoleFromEvent(eventType: string): string {
  if (eventType.startsWith("owner_")) return "human_owner";
  if (eventType.startsWith("verification") || eventType.startsWith("reverification")) return "auditor";
  if (eventType.startsWith("commander_")) return "platoon_leader";
  return "system";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function changedScopeValue(value: unknown): WorkflowContext["changedScope"] {
  return value === "format_only" || value === "content" || value === "scope_change" ? value : undefined;
}
function taskIdFromEventPayload(payload: Record<string, unknown>): string | undefined {
  const value = payload.targetId ?? payload.entityId ?? payload.taskId;
  return typeof value === "string" && isUuid(value) ? value : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toPersistedEvent(row: EventRow): PersistedEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type as PersistedEvent["eventType"],
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    createdAt: row.created_at
  };
}

function toPersistedOutboxItem(row: OutboxRow): PersistedOutboxItem {
  return {
    ...toOutboxRecord(row),
    eventId: row.event_id ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    lastError: row.last_error ?? undefined
  };
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    outboxId: row.huai_outbox_id,
    idempotencyKey: row.idempotency_key,
    target: parseTarget(row.target),
    payload: row.payload,
    status: row.status,
    attempts: row.attempts
  };
}

function parseTarget(target: string | OutboxTarget): OutboxTarget {
  if (typeof target !== "string") return target;
  const parsed = JSON.parse(target) as OutboxTarget;
  if (parsed.kind !== "telegram_bot" && parsed.kind !== "local_gateway") {
    throw new Error("invalid-outbox-target");
  }
  return parsed;
}

function sameOutboxContent(expected: {
  target_kind: OutboxRow["target_kind"];
  target: string;
  payload: Record<string, unknown>;
}, existing: OutboxRow): boolean {
  return expected.target_kind === existing.target_kind
    && stableStringify(JSON.parse(expected.target)) === stableStringify(parseTarget(existing.target))
    && stableStringify(expected.payload) === stableStringify(existing.payload);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + stableStringify(item))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function eventIdForOutbox(binding: unknown, events: PersistedEvent[]): string | undefined {
  const eventId = typeof binding === "object" && binding !== null && "eventId" in binding
    ? (binding as { eventId?: unknown }).eventId
    : undefined;
  if (typeof eventId !== "string") return undefined;
  return events.find((event) => event.idempotencyKey === eventId || event.eventId === eventId)?.eventId;
}

function parseTelegramUpdateIdempotencyKey(idempotencyKey: string): { telegramBotId: string; updateId: string } {
  const parts = idempotencyKey.split(":");
  if (parts.length !== 3 || parts[0] !== "telegram-update") {
    throw new Error("invalid-telegram-update-idempotency-key");
  }
  return { telegramBotId: parts[1] ?? "", updateId: parts[2] ?? "" };
}

function receiptStatus(status: string | undefined): Extract<TelegramUpdateReceipt, { inserted: false }>["status"] {
  if (status === "processing" || status === "retry_pending" || status === "failed") return status;
  return "processed";
}

function toBigIntString(value: string, field: string): string {
  if (!/^-?\d+$/.test(value)) throw new Error(`invalid-${field}`);
  return value;
}

function stripUndefined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function safeResponseText(response: Response): Promise<string> {
  return maskSensitiveText(await response.text().catch(() => "unreadable-response"));
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}











