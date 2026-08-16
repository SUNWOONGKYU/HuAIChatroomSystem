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
import { buildLeaderPlanningPrompt, type RoomFacts, type RoomTurn } from "../../../packages/orchestrator/src/leader-planning.js";
import { buildMiniAppOpenKeyboard } from "../../../packages/telegram-ui/src/index.js";

export type SupabaseStoreConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  // /tasks 의 경과시간 표시(Phase 3)를 테스트에서 고정 시각으로 검증할 수 있도록 주입 가능하게 뺐다.
  // 운영에서는 기본값(실제 시각)을 그대로 쓴다.
  now?: () => Date;
  // "작업 현황판 열기" 버튼(Direct Link Mini App, BOT_SERVICE_MINIAPP_DIRECT_LINK)의 베이스 링크.
  // 예: https://t.me/leader_chatroom_bot/board — 미설정이면 /tasks 에 버튼을 안 붙인다
  // (기존 동작 그대로). 값이 있는데 https://t.me/ 로 시작하지 않으면 생성자에서 던진다 —
  // web_app 이 아니라 t.me 딥링크여야만 그룹에서 Mini App 으로 열린다(core.telegram.org/
  // bots/api 의 InlineKeyboardButton.web_app 은 "Available only in private chats"라
  // 그룹에서 안 눌린다). t.me 아닌 URL 을 넣으면 버튼은 눌리지만 그냥 외부 브라우저가 열려
  // Mini App 인증(Telegram initData)이 없어 Edge Function 이 401 을 낸다 — 조용히 깨지느니
  // 시작 시점에 던진다.
  miniAppDirectLinkBaseUrl?: string;
};

export class SupabaseBotServiceStore implements OrchestratorPersistencePort, OutboxDispatcherStore {
  private readonly client: SupabaseRestClient;
  // chat_id -> room_id. huai_rooms.telegram_chat_id 는 unique not null 이고 실질 불변이라
  // 프로세스 수명 캐시로 충분하다 (무효화 로직 없음, 방 개수 규모에서 메모리 부담도 무시 가능).
  private readonly roomIdByChatId = new Map<string, string>();
  private readonly now: () => Date;
  private readonly miniAppDirectLinkBaseUrl: string | undefined;

  constructor(config: SupabaseStoreConfig) {
    this.client = new SupabaseRestClient({
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      fetchImpl: config.fetchImpl
    });
    this.now = config.now ?? (() => new Date());
    this.miniAppDirectLinkBaseUrl = config.miniAppDirectLinkBaseUrl
      ? requireMiniAppDirectLinkBaseUrl(config.miniAppDirectLinkBaseUrl)
      : undefined;
  }

  // 한 프로세스가 여러 방을 처리하므로 room_id 는 생성자 고정값이 아니라
  // 요청마다 chat_id 로 해석한다. 모르는 chat_id 는 조용히 아무 방에나 쓰지 않고 실패시킨다.
  private async resolveRoomIdByChatId(telegramChatId: string): Promise<string> {
    const cached = this.roomIdByChatId.get(telegramChatId);
    if (cached) return cached;
    const rows = await this.client
      .request("GET", "/huai_rooms?telegram_chat_id=eq." + encodeURIComponent(telegramChatId) + "&select=room_id&limit=1")
      .then((response) => response.json<Array<{ room_id: string }>>());
    const roomId = rows[0]?.room_id;
    if (!roomId) throw new Error(`room-not-found-for-chat:${telegramChatId}`);
    this.roomIdByChatId.set(telegramChatId, roomId);
    return roomId;
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
    // 프로세스 1개가 여러 방을 처리한다. 이 요청이 어느 방 것인지는 telegram_chat_id 로만 알 수 있다.
    const roomId = await this.resolveRoomIdByChatId(input.message.input.envelope.telegramChatId);

    const eventRows = eventsToPersist.length === 0
      ? []
      : await this.client
          .request("POST", "/huai_events", {
            body: eventsToPersist.map((event) => ({
              room_id: roomId,
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
    await this.recordApprovals(eventsToPersist, roomId);
    await this.applyTaskTransitions(eventsToPersist, roomId);
    const fallbackEventId = persistedEvents[0]?.eventId;
    const outboxRows = input.result.outbox.map((item, index) => ({
      room_id: roomId,
      event_id: eventIdForOutbox(item.payload.binding, persistedEvents) ?? fallbackEventId,
      idempotency_key: item.idempotencyKey,
      target_kind: item.target.kind,
      target: JSON.stringify(item.target),
      payload: item.payload
    }));

    const startedHydratedRows = await this.hydrateExecutionStartedMessages(outboxRows, roomId);
    const planningHydratedRows = await this.hydrateLeaderPlanningRows(startedHydratedRows, roomId);
    const executionHydratedOutboxRows = await this.hydrateExecutionOutboxPrompts(planningHydratedRows, roomId);
    const hydratedOutboxRows = await this.hydrateTaskQueryOutboxRows(executionHydratedOutboxRows, roomId);
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
  private async recordApprovals(events: readonly OrchestratorPersistencePortEvent[], roomId: string): Promise<void> {
    const rows = events
      .map((event) => {
        const mapping = approvalRecordForEvent(event.eventType);
        if (!mapping) return undefined;
        const entityRef = approvalEntityRefFromPayload(event.payload);
        const deciderId = approvalDeciderFromPayload(event.payload);
        if (!entityRef || !deciderId) return undefined;
        return {
          room_id: roomId,
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

  private async fetchApprovalIdForEntity(entityRef: string, stage: ApprovalStage, roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request(
        "GET",
        "/huai_approvals?entity_ref=eq." + encodeURIComponent(entityRef) +
          "&stage=eq." + encodeURIComponent(stage) +
          "&room_id=eq." + encodeURIComponent(roomId) +
          "&decision=eq.approved&select=approval_id&order=created_at.asc&limit=1"
      )
      .then((response) => response.json<Array<{ approval_id: string }>>());
    return rows[0]?.approval_id;
  }

  private async applyTaskTransitions(events: readonly OrchestratorPersistencePortEvent[], roomId: string): Promise<void> {
    for (const event of events) {
      const taskId = taskIdFromEventPayload(event.payload);
      if (!taskId) continue;
      // 다른 방의 task_id 가 콜백에 실려 오면 room_id 불일치로 조회 자체가 비어,
      // 아래의 "존재하지 않는 task" 경로와 동일하게 조용히 건너뛴다.
      const current = await this.fetchTaskStatus(taskId, roomId);
      if (!current) continue;
      // 명시적 금지 전이를 먼저 차단한다. 화이트리스트만으로도 막히지만,
      // 금지 사유를 구분해 보고해야 승인 전 실행 시도를 운영 기록에서 식별할 수 있다.
      if (isForbiddenTransition(current, event.eventType as WorkflowEventType)) {
        throw new Error(`task-transition-forbidden:${event.eventType}:${current}`);
      }
      const decision = transitionTaskStatus(current, event.eventType as WorkflowEventType, workflowContextFromEvent(event));
      if (!decision.allowed) throw new Error(`task-transition-not-allowed:${event.eventType}:${current}:${decision.reason}`);
      await this.patchTaskStatus(taskId, decision.nextStatus, roomId);
    }
  }

  private async fetchTaskStatus(taskId: string, roomId: string): Promise<TaskStatus | undefined> {
    const rows = await this.client
      .request("GET", `/huai_tasks?task_id=eq.${encodeURIComponent(taskId)}&room_id=eq.${encodeURIComponent(roomId)}&select=task_id,status`)
      .then((response) => response.json<Array<{ task_id: string; status: TaskStatus }>>());
    return rows[0]?.status;
  }

  private async patchTaskStatus(taskId: string, status: TaskStatus, roomId: string): Promise<void> {
    await this.client
      .request("PATCH", `/huai_tasks?task_id=eq.${encodeURIComponent(taskId)}&room_id=eq.${encodeURIComponent(roomId)}`, {
        body: { status, updated_at: new Date().toISOString() },
        prefer: "return=representation"
      })
      .then((response) => response.json<unknown[]>())
      .then((rows) => {
        if (rows.length !== 1) throw new Error("task-state-conflict:patch");
      });
  }

  // "작업 실행을 시작했습니다: p_032d2db2..." 처럼 내부 id 만 보여주면
  // 방장은 무슨 작업이 시작됐는지, 누가 하는지 알 수 없다.
  // 소대장이 이미 제목과 담당을 정해뒀으니 그것을 실어 보낸다.
  private async hydrateExecutionStartedMessages(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const targets = rows.filter((row) => row.idempotency_key.startsWith("telegram:execution-started:"));
    if (targets.length === 0) return rows;

    const proposalIds = Array.from(new Set(targets.map((row) => row.idempotency_key.split(":")[2]).filter(Boolean)));
    const hints = await this.fetchProposalExecutionHints(proposalIds, roomId);

    return rows.map((row) => {
      if (!row.idempotency_key.startsWith("telegram:execution-started:")) return row;
      const hint = hints.get(row.idempotency_key.split(":")[2] ?? "");
      if (!hint?.title) return row;
      const worker = executionWorkerLabel(hint.requestedActorRole, hint.executionMode);
      return {
        ...row,
        payload: {
          ...row.payload,
          text: [
            `작업을 시작했습니다: ${hint.title}`,
            worker ? `담당: ${worker}` : undefined,
            hint.completionCriteria ? `완료 조건: ${hint.completionCriteria}` : undefined,
            "",
            "작업에는 보통 몇 분이 걸립니다. 끝나면 결과를 보고하겠습니다."
          ].filter((line) => line !== undefined).join("\n")
        }
      };
    });
  }

  // 소대장 판단 요청에 방의 직전 논의를 실어준다.
  // 오케스트레이터는 순수 함수라 DB 를 못 읽으므로 여기서 채운다.
  private async hydrateLeaderPlanningRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const request = executionRequestPayload(row.payload);
      if (!request || typeof request.attemptId !== "string" || !isLeaderPlanningAttempt(request.attemptId)) {
        hydrated.push(row);
        continue;
      }
      const triggeringText = typeof row.payload.triggeringText === "string" ? row.payload.triggeringText : "";
      const telegramChatId = typeof row.payload.telegramChatId === "string" ? row.payload.telegramChatId : undefined;
      const turns = telegramChatId ? await this.fetchRecentRoomTurns(telegramChatId, roomId) : [];
      const leader = await this.fetchLeaderActor(roomId);
      const facts = await this.fetchRoomFacts(roomId);
      hydrated.push({
        ...row,
        payload: {
          ...row.payload,
          executionRequest: {
            ...request,
            prompt: buildLeaderPlanningPrompt({ turns, triggeringText, facts }),
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
  private async fetchRecentRoomTurns(telegramChatId: string, roomId: string): Promise<RoomTurn[]> {
    const since = await this.fetchLastWorkCreatedAt(roomId);
    const ownerId = await this.fetchOwnerTelegramUserId(roomId);
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

  private async fetchLastWorkCreatedAt(roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_events?room_id=eq." + encodeURIComponent(roomId) + "&event_type=eq.owner_task_approved&select=created_at&order=created_at.desc&limit=1")
      .then((response) => response.json<Array<{ created_at?: string }>>())
      .catch(() => []);
    return rows[0]?.created_at;
  }

  private async fetchOwnerTelegramUserId(roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_room_members?room_id=eq." + encodeURIComponent(roomId) + "&role=eq.owner&select=telegram_user_id&limit=1")
      .then((response) => response.json<Array<{ telegram_user_id: string | number }>>())
      .catch(() => []);
    const value = rows[0]?.telegram_user_id;
    return value === undefined || value === null ? undefined : String(value);
  }

  // 소대장이 방에 대해 이미 알아야 하는 것.
  // 이게 없으면 "이 방에 봇이 몇 개야?" 같은 질문에도 조사 작업을 만든다 —
  // 자기가 모르니까 확인하겠다고 하는 것이고, 방장은 답을 원했는데 일이 하나 생긴다.
  private async fetchRoomFacts(roomId: string): Promise<RoomFacts | undefined> {
    try {
      const [actors, members, tasks] = await Promise.all([
        this.client
          .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.active&select=role")
          .then((response) => response.json<Array<{ role: string }>>()),
        this.client
          .request("GET", "/huai_room_members?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.active&select=telegram_user_id")
          .then((response) => response.json<Array<{ telegram_user_id: string }>>()),
        this.client
          .request("GET", "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&status=not.in.(completed,cancelled,rejected_or_cancelled,proposal_rejected)&select=title,status&order=updated_at.desc&limit=8")
          .then((response) => response.json<Array<{ title: string; status: TaskStatus }>>())
      ]);

      return {
        bots: actors.map((actor) => botLabelForRole(actor.role)),
        memberCount: members.length,
        // TASK_STATUS_META 가 단일 출처다 — 별도 상태 라벨표를 여기 두지 않는다.
        // 이 결과는 소대장 판단 프롬프트(buildLeaderPlanningPrompt)에 순수 텍스트로만
        // 들어간다: `${title}(${status})`. 파싱하는 코드는 없다(packages/orchestrator/src/leader-planning.ts 확인).
        openTasks: tasks.map((task) => ({ title: task.title, status: taskStatusMeta(task.status).label }))
      };
    } catch {
      // 방 정보를 못 읽어도 판단 자체는 진행한다. 맥락이 얕아질 뿐이다.
      return undefined;
    }
  }

  private async fetchLeaderActor(roomId: string): Promise<{ actor_id: string; cli_session_id?: string } | undefined> {
    const rows = await this.client
      .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&role=eq.platoon_leader&select=actor_id,cli_session_id&limit=1")
      .then((response) => response.json<Array<{ actor_id: string; cli_session_id?: string }>>())
      .catch(() => []);
    return rows[0];
  }

  private async hydrateExecutionOutboxPrompts(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const proposalIds = Array.from(new Set(rows.map((row) => proposalIdNeedingPromptHydration(row)).filter((value): value is string => Boolean(value))));
    if (proposalIds.length === 0) return rows;

    const hintsByProposalId = await this.fetchProposalExecutionHints(proposalIds, roomId);
    const requestedRoles = Array.from(new Set(Array.from(hintsByProposalId.values()).flatMap((hint) => requestedExecutionRolesForHint(hint))));
    const actorsByRole = await this.fetchActiveExecutionActorsByRole(requestedRoles, roomId);
    const hydrated: OutboxInsertRow[] = [];

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
      const taskId = await this.ensureApprovedProposalTask(proposalId, hint, primaryActor?.actor_id, roomId);
      const taskExecutionRequest = { ...executionRequest, taskId, sourceProposalId: proposalId };
      if (hint.executionMode === "multi_ai_review") {
        hydrated.push(...buildMultiAiExecutionRows(row, taskExecutionRequest, hint, actorsByRole));
        continue;
      }
      const actor = hint.requestedActorRole ? actorsByRole.get(hint.requestedActorRole) : undefined;
      // reportBotRole 까지 함께 바꿔야 한다.
      // 예전에는 actorId·adapterType 만 바꿔서, 소대장이 ClaudeBot 을 지정해도
      // 보고는 기본값인 CodexBot 이름으로 나갔다 — 방장이 보기에 배분이 무시된 것처럼 보인다.
      hydrated.push({
        ...row,
        payload: {
          ...row.payload,
          executionRequest: {
            ...taskExecutionRequest,
            ...(actor ? { actorId: actor.actor_id, adapterType: actor.adapter_type, reportBotRole: actor.role } : {}),
            prompt: hint.prompt
          }
        }
      });
    }

    return hydrated;
  }

  private async fetchProposalExecutionHints(proposalIds: readonly string[], roomId: string): Promise<Map<string, ProposalExecutionHint>> {
    if (proposalIds.length === 0) return new Map();
    // room_id 필터 없이 전역 최근 200건만 보면, 방이 늘수록 이 창이 남의 방 제안으로
    // 차서 자기 방 제안을 못 찾는다(approved-task-materialization-missing).
    const rows = await this.client
      .request("GET", "/huai_events?event_type=eq.proposal_created&room_id=eq." + encodeURIComponent(roomId) + "&select=payload,created_at&order=created_at.desc&limit=200")
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

  private async fetchActiveExecutionActorsByRole(roles: readonly ExecutionActorRole[], roomId: string): Promise<Map<ExecutionActorRole, ExecutionActorRow>> {
    if (roles.length === 0) return new Map();
    const quoted = roles.map((role) => '"' + escapePostgrestInValue(role) + '"').join(",");
    const rows = await this.client
      .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&role=in.(" + encodeURIComponent(quoted) + ")&status=eq.active&select=actor_id,role,adapter_type")
      .then((response) => response.json<ExecutionActorRow[]>());
    return new Map(rows.map((row) => [row.role, row]));
  }

  private async ensureApprovedProposalTask(proposalId: string, hint: ProposalExecutionHint, assigneeActorId: string | undefined, roomId: string): Promise<string> {
    const proposalUuid = uuidFromProposalId(proposalId);
    const existing = proposalUuid ? await this.fetchTaskByProposalId(proposalUuid) : undefined;
    if (existing) return existing.task_id;

    if (proposalUuid) {
      await this.insertProposalIfMissing(proposalUuid, hint, roomId);
    }

    const taskRows = await this.insertTaskForProposal(proposalId, proposalUuid, hint, assigneeActorId, roomId);
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

  private async insertProposalIfMissing(proposalUuid: string, hint: ProposalExecutionHint, roomId: string): Promise<void> {
    const response = await this.client.request("POST", "/huai_task_proposals", {
      body: {
        proposal_id: proposalUuid,
        room_id: roomId,
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

  private async insertTaskForProposal(proposalId: string, proposalUuid: string | undefined, hint: ProposalExecutionHint, assigneeActorId: string | undefined, roomId: string): Promise<Array<{ task_id: string }>> {
    // 승인 원장은 절대 수정하지 않는다. 대신 task 를 만들 때 그 task 가 어느 승인으로 생겼는지를
    // 여기서 한 번 연결한다 (AC-08 "완료 전 3단계 승인 증거").
    const approvalId = await this.fetchApprovalIdForEntity(proposalId, "task_approval", roomId);
    const response = await this.client.request("POST", "/huai_tasks", {
      body: {
        room_id: roomId,
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

  private async hydrateTaskQueryOutboxRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const query = taskQueryPayload(row.payload);
      if (!query || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }

      const text = query.kind === "tasks"
        ? await this.renderTaskListQuery(query.limit, roomId)
        : query.kind === "search"
          ? await this.renderTaskSearchQuery(query.term, roomId)
          : query.kind === "trace"
            ? await this.renderTaskTraceQuery(query.taskId, roomId)
            : await this.renderTaskDetailQuery(query.taskId, roomId);
      // "작업 현황판 열기" 버튼은 /tasks 에만 붙인다(/search·/task·/trace 는 이번 범위가 아니다).
      // BOT_SERVICE_MINIAPP_DIRECT_LINK 미설정 시 keyboard 필드 자체를 안 만든다 —
      // 기존 payload 에 keyboard 가 없던 것과 완전히 동일하게 유지한다.
      const keyboard = query.kind === "tasks" && this.miniAppDirectLinkBaseUrl
        ? buildMiniAppOpenKeyboard({ directLinkBaseUrl: this.miniAppDirectLinkBaseUrl, roomId })
        : undefined;
      hydrated.push({ ...row, payload: { ...row.payload, text, ...(keyboard ? { keyboard } : {}) } });
    }
    return hydrated;
  }

  // Phase 3: /tasks 를 평문 나열에서 상태별 그룹 + 경과시간 + 담당자 표시로 바꾼다.
  // 상태 분류표는 TASK_STATUS_META(전수 커버리지, huai_tasks_status_check 기준) 참고.
  private async renderTaskListQuery(limit: number, roomId: string): Promise<string> {
    const safeLimit = Math.max(1, Math.min(limit, 30));
    // in_progress 작업은 장기 체류로 updated_at 이 밀려 단일 updated_at.desc 쿼리에서
    // 창 밖으로 탈락하는 결함이 있었다. 별도 조회로 항상 포함시킨다.
    const IN_PROGRESS_CAP = 30;
    const taskSelect = "task_id,title,status,priority,assignee_actor_id,updated_at,created_at";
    const inProgressResponse = await this.client.request(
      "GET",
      "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.in_progress&select=" + taskSelect + "&order=updated_at.desc&limit=" + IN_PROGRESS_CAP,
      { prefer: "count=exact" }
    );
    const inProgressRows = await inProgressResponse.json<TaskSummaryRow[]>();
    const inProgressTotal = parseContentRangeTotal(inProgressResponse.header("content-range")) ?? inProgressRows.length;

    const otherLimit = Math.max(1, safeLimit - inProgressRows.length);
    const otherResponse = await this.client.request(
      "GET",
      "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&status=neq.in_progress&select=" + taskSelect + "&order=updated_at.desc&limit=" + otherLimit,
      { prefer: "count=exact" }
    );
    const otherRows = await otherResponse.json<TaskSummaryRow[]>();
    const otherTotal = parseContentRangeTotal(otherResponse.header("content-range")) ?? otherRows.length;

    const rows = [...inProgressRows, ...otherRows];
    const totalCount = inProgressTotal + otherTotal;

    if (rows.length === 0) return "작업 목록\n현재 등록된 작업이 없습니다.";

    const assigneeActorIds = Array.from(new Set(rows.map((task) => task.assignee_actor_id).filter((value): value is string => Boolean(value))));
    const roleByActorId = await this.fetchActorRolesByActorIds(assigneeActorIds);
    const now = this.now();

    const grouped = new Map<TaskStatusGroupKey, TaskSummaryRow[]>();
    for (const task of rows) {
      const meta = taskStatusMeta(task.status);
      const bucket = grouped.get(meta.group) ?? [];
      bucket.push(task);
      grouped.set(meta.group, bucket);
    }

    const headerLine = totalCount > rows.length
      ? `작업 목록 (최근 ${rows.length}건 표시 · 전체 ${totalCount}건 중 ${totalCount - rows.length}건 더 있음)`
      : `작업 목록 (총 ${rows.length}건)`;
    const lines: string[] = [headerLine];
    let index = 0;
    for (const groupKey of TASK_STATUS_GROUP_ORDER) {
      const tasks = grouped.get(groupKey);
      if (!tasks || tasks.length === 0) continue; // 빈 그룹은 화면을 잡아먹으니 아예 출력하지 않는다.
      const groupInfo = TASK_STATUS_GROUPS[groupKey];
      lines.push("", `${groupInfo.icon} ${groupInfo.label} (${tasks.length})`);
      for (const task of tasks) {
        index += 1;
        // updated_at 은 상태가 바뀔 때마다 patchTaskStatus 가 갱신하고, 아직 한 번도
        // 안 바뀐 task 는 insert 시점 created_at 과 사실상 같은 값이 default now() 로 들어간다.
        // 그래서 상태별로 기준 필드를 분기할 필요 없이 updated_at 하나가
        // "이 상태로 바뀐 시점"과 "생성된 시점"을 동시에 커버한다.
        const elapsed = formatElapsedSince(task.updated_at ?? task.created_at, now);
        const assignee = taskAssigneeLabel(roleByActorId.get(task.assignee_actor_id ?? ""));
        // 그룹 헤더는 스캔용이고, 같은 그룹 안에도 서로 다른 세부 상태가 섞인다
        // (예: "⏳ 대기 중"에는 제안 검토 대기/실행 대기/검증 대기 등 6가지가 섞인다).
        // 그룹만 보여주면 어떤 대기인지 알 수 없어 정보 손실이라, 세부 라벨을 항상 같이 보여준다.
        const detailParts = [`상태: ${taskStatusMeta(task.status).label}`, `담당: ${assignee}`];
        if (elapsed) detailParts.push(elapsed);
        if (task.priority && task.priority !== "normal") detailParts.push(`우선순위: ${task.priority}`);
        lines.push(`${index}. ${shortTaskId(task.task_id)} · ${task.title || "제목 없음"}`);
        lines.push(`   ${detailParts.join(" · ")}`);
      }
    }
    return lines.join("\n");
  }

  // actor_id 는 UUID PK 라 room 필터가 필요 없다 (fetchTaskByProposalId 와 같은 근거).
  private async fetchActorRolesByActorIds(actorIds: readonly string[]): Promise<Map<string, string>> {
    if (actorIds.length === 0) return new Map();
    const quoted = actorIds.map((id) => '"' + escapePostgrestInValue(id) + '"').join(",");
    const rows = await this.client
      .request("GET", "/huai_ai_actors?actor_id=in.(" + encodeURIComponent(quoted) + ")&select=actor_id,role")
      .then((response) => response.json<Array<{ actor_id: string; role: string }>>());
    return new Map(rows.map((row) => [row.actor_id, row.role]));
  }

  private async renderTaskSearchQuery(term: string, roomId: string): Promise<string> {
    const normalized = term.trim();
    if (!normalized) return "작업 검색\n검색어를 함께 보내주세요. 예: /search 버튼";
    const encodedTerm = encodeURIComponent("*" + normalized.replace(/[*,()]/g, " ").trim() + "*");
    const rows = await this.client
      .request("GET", "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&or=(title.ilike." + encodedTerm + ",purpose.ilike." + encodedTerm + ",scope.ilike." + encodedTerm + ")&select=task_id,title,status,priority,assignee_actor_id,updated_at,created_at&order=updated_at.desc&limit=10")
      .then((response) => response.json<TaskSummaryRow[]>());
    if (rows.length === 0) return "작업 검색\n검색 결과가 없습니다: " + normalized;
    return [
      "작업 검색: " + normalized,
      ...rows.map((task, index) => `${index + 1}. ${shortTaskId(task.task_id)} · ${task.title || "제목 없음"}\n상태: ${taskStatusMeta(task.status).label}`)
    ].join("\n");
  }
  private async renderTaskTraceQuery(taskId: string, roomId: string): Promise<string> {
    const normalizedTaskId = taskId.trim();
    if (!isUuid(normalizedTaskId)) return "작업 이력\n작업 UUID를 함께 보내주세요. 예: /trace <task_id>";

    const encodedTaskId = encodeURIComponent(normalizedTaskId);
    // huai_artifacts·huai_verifications 에는 room_id 컬럼이 없어 직접 필터링할 수 없다.
    // 대신 이 task 가 이 방 소유인지 먼저 확인하고, 아니면 실재하지 않는 task 와
    // 똑같이 빈 이력으로 응답한다 — 존재 여부조차 다른 방에 알려주지 않는다.
    const owned = await this.taskBelongsToRoom(normalizedTaskId, roomId);
    const [events, artifacts, verifications] = owned
      ? await Promise.all([
          this.client
            .request("GET", "/huai_events?task_id=eq." + encodedTaskId + "&room_id=eq." + encodeURIComponent(roomId) + "&select=event_type,created_at&order=created_at.desc&limit=10")
            .then((response) => response.json<TaskTraceEventRow[]>()),
          this.client
            .request("GET", "/huai_artifacts?task_id=eq." + encodedTaskId + "&select=uri,version,is_final,created_at&order=created_at.desc&limit=10")
            .then((response) => response.json<TaskTraceArtifactRow[]>()),
          this.client
            .request("GET", "/huai_verifications?task_id=eq." + encodedTaskId + "&select=verdict,target_version,created_at&order=created_at.desc&limit=10")
            .then((response) => response.json<TaskTraceVerificationRow[]>())
        ])
      : [[], [], []] as [TaskTraceEventRow[], TaskTraceArtifactRow[], TaskTraceVerificationRow[]];

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

  private async renderTaskDetailQuery(taskId: string, roomId: string): Promise<string> {
    const normalizedTaskId = taskId.trim();
    if (!normalizedTaskId) return "작업 상세\n작업 ID를 함께 보내주세요. 예: /task task_id";

    const task = normalizedTaskId.startsWith("proposal_")
      ? await this.fetchTaskDetailByProposalId(normalizedTaskId, roomId)
      : await this.fetchTaskDetailByTaskId(normalizedTaskId, roomId);
    if (!task) return `작업 상세\n해당 작업을 찾지 못했습니다: ${normalizedTaskId}`;

    return [
      "작업 상세",
      `ID: ${shortTaskId(task.task_id)}`,
      `작업: ${task.title || "제목 없음"}`,
      `상태: ${taskStatusMeta(task.status).label}`,
      task.priority ? `우선순위: ${task.priority}` : undefined,
      task.purpose ? `목적: ${task.purpose}` : undefined,
      task.scope ? `범위: ${task.scope}` : undefined,
      task.completion_criteria ? `완료 기준: ${task.completion_criteria}` : undefined,
      task.updated_at ? `최근 갱신: ${task.updated_at}` : undefined
    ].filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
  }

  private async fetchTaskDetailByTaskId(taskId: string, roomId: string): Promise<TaskDetailRow | undefined> {
    if (!isUuid(taskId)) return undefined;
    // room_id 를 SELECT 필터에 직접 넣으면, 다른 방 task 는 "존재하지 않음"과
    // 똑같이 빈 결과로 돌아온다 — 별도 분기 없이 유출을 막는다.
    const rows = await this.client
      .request("GET", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId) + "&room_id=eq." + encodeURIComponent(roomId) + "&select=task_id,title,status,priority,purpose,scope,completion_criteria,updated_at,created_at&limit=1")
      .then((response) => response.json<TaskDetailRow[]>());
    return rows[0];
  }

  private async fetchTaskDetailByProposalId(proposalId: string, roomId: string): Promise<TaskDetailRow | undefined> {
    const proposalUuid = uuidFromProposalId(proposalId);
    const query = proposalUuid
      ? "proposal_id=eq." + encodeURIComponent(proposalUuid)
      : "idempotency_key=eq." + encodeURIComponent(taskIdempotencyKey(proposalId));
    const rows = await this.client
      .request("GET", "/huai_tasks?" + query + "&room_id=eq." + encodeURIComponent(roomId) + "&select=task_id,title,status,priority,purpose,scope,completion_criteria,updated_at,created_at&limit=1")
      .then((response) => response.json<TaskDetailRow[]>());
    return rows[0];
  }

  // /trace 가드용. huai_artifacts·huai_verifications 에 room_id 가 없으므로
  // 산출물·검증 이력을 조회하기 전에 이 task 가 이 방 소유인지부터 확인한다.
  private async taskBelongsToRoom(taskId: string, roomId: string): Promise<boolean> {
    const rows = await this.client
      .request("GET", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId) + "&room_id=eq." + encodeURIComponent(roomId) + "&select=task_id&limit=1")
      .then((response) => response.json<Array<{ task_id: string }>>());
    return rows.length > 0;
  }
  private async insertOutboxRowsIdempotently(rows: OutboxInsertRow[]): Promise<OutboxRow[]> {
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
    miniAppDirectLinkBaseUrl: env.BOT_SERVICE_MINIAPP_DIRECT_LINK || undefined
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

  header(name: string): string | null {
    return this.response.headers.get(name);
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
  room_id?: string | null;
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
  // 방 단위 공평 리스(lease_huai_outbox, migration 20260815140000)의 파티션 키.
  // 여기서 안 채우면 새로 들어가는 행은 전부 room_id=null 로 한 버킷에 묶여 공평 리스가 무력화된다.
  room_id: string;
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

// PostgREST 의 `Prefer: count=exact` 응답 헤더 형식: "0-9/25"(부분) 또는 "*/0"(빈 결과).
// 슬래시 뒤의 총 건수만 뽑는다. 헤더가 없거나 형식이 다르면 undefined — 호출부가
// "실제보다 많다고 거짓 안내"하지 않도록 rows.length 로 안전하게 폴백한다.
function parseContentRangeTotal(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\/(\d+)$/);
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : undefined;
}

// ---------- 작업 상태 라벨: 단일 출처 ----------
// 예전엔 humanTaskStatus(status: string) 가 따로 있었다. 실제 huai_tasks_status_check(schema.sql)
// 값과 어긋나는 case 가 섞여 있었고("proposed"/"running"/"verified" 는 실제 TaskStatus 에 존재하지
// 않는 값), 다수의 실제 상태값(proposal_pending/in_progress/mid_approval_pending 등)은 default 로
// 원문 snake_case 그대로 노출됐다. /search·/task·room facts(소대장 판단 프롬프트) 세 경로가 전부
// 이 결함을 물려받고 있었다 — room facts 쪽이 특히 나빴다: 소대장이 방 상태를 판단할 때 원문
// 값을 그대로 읽고 있었다는 뜻이다. TASK_STATUS_META(Record<TaskStatus, ...>, 23개 전수 컴파일
// 타임 강제)가 이미 있었으므로 두 표를 남기지 않고 이걸 유일한 출처로 통일했다.
// Record<TaskStatus, ...> 로 선언해 huai_tasks_status_check 의 23개 값 전수를 컴파일 타임에 강제한다.
type TaskStatusGroupKey = "approval_pending" | "action_needed" | "in_progress" | "waiting" | "paused" | "completed" | "closed";

// 출력 순서: 방장이 지금 결정해야 하는 것(승인 대기) -> 막힌 것(조치 필요) -> 돌고 있는 것(진행 중)
// -> 대기 -> 일시정지 -> 끝난 것(완료/종료됨) 순. 방장이 가장 궁금해할 것을 위로 올린다.
const TASK_STATUS_GROUP_ORDER: readonly TaskStatusGroupKey[] = [
  "approval_pending", "action_needed", "in_progress", "waiting", "paused", "completed", "closed"
];

const TASK_STATUS_GROUPS: Readonly<Record<TaskStatusGroupKey, { icon: string; label: string }>> = {
  approval_pending: { icon: "🗳️", label: "승인 대기" },
  action_needed: { icon: "⚠️", label: "조치 필요" },
  in_progress: { icon: "▶️", label: "진행 중" },
  waiting: { icon: "⏳", label: "대기 중" },
  paused: { icon: "⏸️", label: "일시정지" },
  completed: { icon: "✅", label: "완료" },
  closed: { icon: "🚫", label: "종료됨" }
};

const TASK_STATUS_META: Readonly<Record<TaskStatus, { group: TaskStatusGroupKey; label: string }>> = {
  proposal_pending: { group: "waiting", label: "제안 검토 대기" },
  proposal_revision_requested: { group: "action_needed", label: "제안 보완 필요" },
  proposal_rejected: { group: "closed", label: "제안 반려됨" },
  scheduled: { group: "waiting", label: "실행 대기" },
  waiting_dependencies: { group: "waiting", label: "선행 작업 대기" },
  queued_for_gateway: { group: "waiting", label: "실행 준비 중" },
  in_progress: { group: "in_progress", label: "실행 중" },
  mid_approval_pending: { group: "approval_pending", label: "중간 승인 대기" },
  paused_by_owner: { group: "paused", label: "방장이 일시정지" },
  verification_pending: { group: "waiting", label: "검증 대기" },
  verification_in_progress: { group: "in_progress", label: "검증 중" },
  revision_requested: { group: "action_needed", label: "보완 필요" },
  revision_in_progress: { group: "in_progress", label: "보완 작업 중" },
  reverification_pending: { group: "waiting", label: "재검증 대기" },
  commander_completion_pending: { group: "approval_pending", label: "소대장 완료 확인 대기" },
  completion_approval_pending: { group: "approval_pending", label: "승인 대기" },
  owner_supplement_requested: { group: "action_needed", label: "보완 요청함" },
  completed: { group: "completed", label: "완료" },
  cancel_requested: { group: "action_needed", label: "취소 처리 중" },
  cancelled: { group: "closed", label: "취소됨" },
  failed_retryable: { group: "action_needed", label: "실패(재시도 예정)" },
  blocked: { group: "action_needed", label: "조치 필요" },
  rejected_or_cancelled: { group: "closed", label: "반려/취소됨" }
};

// DB 제약이 지켜지는 한 항상 히트하지만, 방어적으로 미지의 값은 "조치 필요"로 눈에 띄게 분류한다
// (조용히 숨기지 않는다 — 방장이 모르는 상태값이면 그게 더 위험하다).
function taskStatusMeta(status: TaskStatus): { group: TaskStatusGroupKey; label: string } {
  return TASK_STATUS_META[status] ?? { group: "action_needed", label: String(status) };
}

// 우리 방 봇 4개(platoon_leader/claude_leader/codex_leader/auditor)의 사람이 읽는 담당자 이름.
// botLabelForRole() 은 소대장 판단 프롬프트용 긴 표기("LeaderBot(소대장)")라 목적이 다르다 —
// /tasks 는 여러 건을 한 화면에 보여줘야 해서 짧은 표기를 따로 둔다.
const TASK_ASSIGNEE_DISPLAY_BY_ROLE: Readonly<Record<string, string>> = {
  platoon_leader: "소대장",
  claude_leader: "ClaudeBot",
  codex_leader: "CodexBot",
  auditor: "AuditBot"
};

function taskAssigneeLabel(role: string | undefined): string {
  if (!role) return "미배정";
  return TASK_ASSIGNEE_DISPLAY_BY_ROLE[role] ?? role;
}

// 절대 시각은 방장이 직접 계산해야 해서 안 읽힌다 — 상대 표현으로만 보여준다.
function formatElapsedSince(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Math.max(0, now.getTime() - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  return `${months}개월 전`;
}
// ---------- /Phase 3 ----------

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

function botLabelForRole(role: string): string {
  if (role === "platoon_leader") return "LeaderBot(소대장)";
  if (role === "claude_leader") return "ClaudeBot(Claude Code 실행)";
  if (role === "codex_leader") return "CodexBot(Codex 실행)";
  if (role === "auditor") return "AuditBot(독립 검증)";
  return role;
}

function executionWorkerLabel(
  role: ExecutionActorRole | undefined,
  mode: "multi_ai_review" | undefined
): string | undefined {
  if (mode === "multi_ai_review") return "ClaudeBot + CodexBot";
  if (role === "claude_leader") return "ClaudeBot";
  if (role === "codex_leader") return "CodexBot";
  return undefined;
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
  if (typeof taskId !== "string" || !taskId) return undefined;
  // 이미 물질화된 작업(UUID)은 프롬프트가 채워져 있다. 아직 제안 단계인 것만 채운다.
  //
  // 예전에는 `proposal_` 접두사로 판별했는데, Telegram 콜백 64바이트 제한 때문에
  // 소대장 제안 id 를 `p_...` 로 줄이자 이 검사가 걸러내 실행 에이전트가
  // 작업 명세 대신 id 만 받았다("해당 ID 를 조회할 수 없습니다"로 끝남).
  // 접두사가 아니라 "프롬프트가 아직 비어 있는가"로 판별한다.
  if (isUuid(taskId)) return undefined;
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

  // 소대장이 구조화한 것이 있으면 그대로 실행자에게 넘긴다.
  // 특히 완료 조건은 검증자가 합격/불합격을 판정할 기준이라, 실행자가 모르면
  // 무엇을 만족시켜야 하는지 알 수 없는 채로 일하게 된다.
  const purpose = proposalFieldFromPayload(payload, "purpose");
  const scope = proposalFieldFromPayload(payload, "scope");
  const completionCriteria = proposalFieldFromPayload(payload, "completionCriteria");
  const structured = [
    title ? `작업: ${title}` : undefined,
    purpose ? `목적: ${purpose}` : undefined,
    scope ? `범위: ${scope}` : undefined,
    completionCriteria ? `완료 조건: ${completionCriteria}` : undefined
  ].filter(Boolean);

  const body = structured.length > 1 ? structured.join("\n") : requestText;
  return buildApprovedTelegramTaskPrompt(body);
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
    && stableStringify(normalizeVolatileExecutionRequestFields(expected.payload)) === stableStringify(normalizeVolatileExecutionRequestFields(existing.payload));
}

// packages/orchestrator/src/index.ts 의 enqueueExecutionAfterApproval(:516-528)·
// enqueueAuditExecutionIfConfigured(:1039-1047) 는 executionRequest.attemptId 를
// ports.makeId() 로, createdAt 을 ports.now() 로 호출마다 새로 만든다. idempotencyKey
// 필드(executionRequest 내부, outbox 행 자체의 idempotency_key 와는 다른 필드)도
// `...:${attemptId}` 형태라 attemptId 에 종속돼 같이 매번 달라진다.
// 같은 승인 결정을 두 번 제출해도(Telegram 버튼 재클릭, 또는 Telegram·Mini App
// 두 창구에서 같은 결정이 각각 들어올 때) outbox 행의 idempotency_key(entityId 단위,
// 위 두 함수 주석 참고)는 같게 설계돼 있는데 이 3개 필드만 매번 달라서 여기서
// "내용이 다르다"고 오판해 outbox-idempotency-conflict 를 던지고 있었다.
// roomId/taskId/actorId/requestedBy/adapterType/projectPath/prompt/timeoutMs/
// reportBotRole 등 나머지 필드가 전부 같다면 이건 정말 "같은 요청"이 맞다 — 그래서
// 이 3개 필드만 비교에서 뺀다. 진짜 내용이 다른 충돌(다른 actorId, 다른 prompt 등)은
// 이 필드들을 빼도 나머지가 여전히 달라 정상적으로 outbox-idempotency-conflict 로 걸린다.
function normalizeVolatileExecutionRequestFields(payload: Record<string, unknown>): Record<string, unknown> {
  const executionRequest = payload.executionRequest;
  if (!executionRequest || typeof executionRequest !== "object" || Array.isArray(executionRequest)) return payload;
  const { attemptId, idempotencyKey, createdAt, ...stableExecutionRequest } = executionRequest as Record<string, unknown>;
  return { ...payload, executionRequest: stableExecutionRequest };
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

function requireMiniAppDirectLinkBaseUrl(value: string): string {
  if (!value.startsWith("https://t.me/")) {
    throw new Error(`invalid-env:BOT_SERVICE_MINIAPP_DIRECT_LINK must start with https://t.me/ (got: ${maskSensitiveText(value)})`);
  }
  return value;
}











