import path from "node:path";
import {
  type OutboxRecord,
  type TelegramSendResult,
  type TelegramUpdateEnvelope,
  type TelegramUpdateReceipt
} from "../../../packages/contracts/src/index.js";
import {
  type OrchestratorPersistencePort,
  type PersistedEvent
} from "./persistence.js";
import { type OutboxDispatcherStore } from "./outbox.js";
import { makeTelegramUpdateIdempotencyKey } from "./index.js";
import { isForbiddenTransition, transitionTaskStatus, type TaskStatus, type WorkflowEventType } from "../../../packages/workflow/src/index.js";
import { isLeaderPlanningAttempt } from "../../../packages/orchestrator/src/index.js";

import {
  type OrchestratorPersistencePortEvent,
  type EventRow,
  type OutboxRow,
  type TelegramUpdateRow,
  type OutboxInsertRow,
  taskIdFromBinding,
  buildFinalApprovalResultText
} from "./command-prompt-helpers.js";
import {
  workflowContextFromEvent,
  approvalRecordForEvent,
  approvalEntityRefFromPayload,
  approvalDeciderFromPayload,
  approvalReasonFromPayload,
  taskIdFromEventPayload,
  isUuid,
  toPersistedEvent,
  toPersistedOutboxItem,
  sameOutboxContent,
  escapePostgrestInValue,
  eventIdForOutbox,
  parseTelegramUpdateIdempotencyKey,
  receiptStatus,
  toBigIntString,
  requiredEnv,
  requireMiniAppDirectLinkBaseUrl,
  optionalPayloadString
} from "./event-row-mapping.js";
import { maskTelegramSensitiveText as maskSensitiveText } from "../../../packages/telegram-ui/src/sanitize.js";
import { SupabaseRestClient } from "./rest-client.js";
import { SupabaseOutboxDispatchStore } from "./supabase-outbox-dispatch-store.js";
// God file 분리(2026-08, 3차) — 실행 요청 파이프라인(리더 판단 프롬프트/실행 프롬프트
// hydrate)과 명시적 슬래시 명령·조회 명령 렌더링을 각각 별도 클래스로 뽑았다.
// 아래 두 클래스는 이 파일과 같은 SupabaseRestClient 인스턴스를 공유한다
// (outboxDispatchStore 와 같은 구성 방식 — 2차 분리 때 이미 검증된 패턴).
import { SupabaseExecutionHydrationStore } from "./execution-hydration-store.js";
import { SupabaseChatCommandStore } from "./chat-command-store.js";
export type SupabaseStoreConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  // /tasks 의 경과시간 표시(Phase 3)를 테스트에서 고정 시각으로 검증할 수 있도록 주입 가능하게 뺐다.
  // 운영에서는 기본값(실제 시각)을 그대로 쓴다.
  now?: () => Date;
  // "협업 운영센터 열기" 버튼(Direct Link Mini App, BOT_SERVICE_MINIAPP_DIRECT_LINK)의 베이스 링크.
  // 예: https://t.me/leader_chatroom_bot/board — 미설정이면 /tasks 에 버튼을 안 붙인다
  // (기존 동작 그대로). 값이 있는데 https://t.me/ 로 시작하지 않으면 생성자에서 던진다 —
  // web_app 이 아니라 t.me 딥링크여야만 그룹에서 Mini App 으로 열린다(core.telegram.org/
  // bots/api 의 InlineKeyboardButton.web_app 은 "Available only in private chats"라
  // 그룹에서 안 눌린다). t.me 아닌 URL 을 넣으면 버튼은 눌리지만 그냥 외부 브라우저가 열려
  // Mini App 인증(Telegram initData)이 없어 Edge Function 이 401 을 낸다 — 조용히 깨지느니
  // 시작 시점에 던진다.
  miniAppDirectLinkBaseUrl?: string;
  // 기본값은 sessions/rooms — archive-room-conversations.mjs 의 기본 출력 위치와 같다.
  archiveRootDir?: string;
};

// 고정 메시지 본문. 목록을 싣지 않는다 — 고정해두면 만들어진 시점의 목록이 박제되고,
// 최신 상태는 버튼을 눌러야 보인다(scripts/pin-room-board-message.mjs 와 같은 이유).

// 주제별 현황판 고정 메시지 생성은 제거됐다(ensureTopicBoardRows). 이미 방에 남아 있는
// 옛 고정 메시지의 문구는 지우는 쪽이 알아야 하므로 scripts/pin-room-board-message.mjs 의
// LEGACY_BOARD_MESSAGE_TEXTS 가 들고 있다.

function outboxTargetChatId(target: string): string | undefined {
  try {
    const parsed = JSON.parse(target) as { telegramChatId?: unknown };
    return optionalPayloadString(parsed.telegramChatId);
  } catch {
    return undefined;
  }
}

export class SupabaseBotServiceStore implements OrchestratorPersistencePort, OutboxDispatcherStore {
  private readonly client: SupabaseRestClient;
  // chat_id -> room_id. huai_rooms.telegram_chat_id 는 unique not null 이고 실질 불변이라
  // 프로세스 수명 캐시로 충분하다 (무효화 로직 없음, 방 개수 규모에서 메모리 부담도 무시 가능).
  private readonly roomIdByChatId = new Map<string, string>();
  private readonly now: () => Date;
  private readonly miniAppDirectLinkBaseUrl: string | undefined;
  // 방 기억(위키)을 읽어올 폴더. 아카이브 스크립트가 쓰는 자리와 같아야 한다.
  private readonly archiveRootDir: string;
  // God class 분리(2026-08, 2차) — OutboxDispatcherStore 쪽(leasePending 등 5개)은
  // 이 클래스의 나머지(OrchestratorPersistencePort 쪽)와 아무 상태도 공유하지 않는
  // 별도 클래스로 뽑았다. 같은 client 인스턴스를 그대로 주입해 동작은 바꾸지 않는다.
  private readonly outboxDispatchStore: SupabaseOutboxDispatchStore;
  // God class 분리(2026-08, 3차) — commitTelegramInputResult 의 실행 요청 hydrate
  // 파이프라인과, 명시적 슬래시 명령/조회 명령 렌더링을 각각 별도 클래스로 뽑았다.
  // 위 outboxDispatchStore 와 같은 구성 방식(같은 client 공유, 동작 불변).
  private readonly executionHydrationStore: SupabaseExecutionHydrationStore;
  private readonly chatCommandStore: SupabaseChatCommandStore;

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
    this.archiveRootDir = config.archiveRootDir ?? path.join("sessions", "rooms");
    this.outboxDispatchStore = new SupabaseOutboxDispatchStore(this.client);
    this.executionHydrationStore = new SupabaseExecutionHydrationStore(this.client, this.archiveRootDir);
    this.chatCommandStore = new SupabaseChatCommandStore(this.client, this.now, this.miniAppDirectLinkBaseUrl);
  }

  // /readyz 가 Supabase 도달성을 확인할 때 쓰는 가벼운 왕복.
  // 데이터를 쓰지 않고 가장 가벼운 조회(limit=1)로 연결·인증(서비스 롤 키)이
  // 실제로 살아있는지만 본다 — local-gateway 의 leasePendingLocalGateway(0, ...) 와
  // 같은 목적, 같은 원칙("설정값이 아니라 실제 왕복")이다.
  async ping(): Promise<void> {
    await this.client.request("GET", "/huai_rooms?select=room_id&limit=1").then((response) => response.expectOk());
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
    await this.materializePostCompletionChanges(persistedEvents, roomId);
    const fallbackEventId = persistedEvents[0]?.eventId;
    const outboxRows = input.result.outbox.map((item) => ({
      room_id: roomId,
      event_id: eventIdForOutbox(item.payload.binding, persistedEvents) ?? fallbackEventId,
      idempotency_key: item.idempotencyKey,
      target_kind: item.target.kind,
      target: JSON.stringify(item.target),
      payload: item.payload
    }));

    const startedHydratedRows = await this.executionHydrationStore.hydrateExecutionStartedMessages(outboxRows, roomId);
    const planningHydratedRows = await this.executionHydrationStore.hydrateLeaderPlanningRows(startedHydratedRows, roomId);
    const executionHydratedOutboxRows = await this.executionHydrationStore.hydrateExecutionOutboxPrompts(planningHydratedRows, roomId);
    const taskQueryHydratedRows = await this.chatCommandStore.hydrateTaskQueryOutboxRows(executionHydratedOutboxRows, roomId);
    const finalApprovalHydratedRows = await this.hydrateFinalApprovalRows(taskQueryHydratedRows);
    const personaHydratedRows = await this.chatCommandStore.hydrateAgentPersonaRows(finalApprovalHydratedRows, roomId);
    const hydratedOutboxRows = await this.chatCommandStore.hydrateAiActorRows(personaHydratedRows, roomId);
    const roomHydratedRows = await this.chatCommandStore.hydrateRoomCommandRows(hydratedOutboxRows, roomId);
    const memberHydratedRows = await this.chatCommandStore.hydrateRoomMemberRows(roomHydratedRows, roomId);
    const controlHydratedRows = this.chatCommandStore.hydrateOwnerControlRows(memberHydratedRows, roomId);
    // 현황판 행은 주제당 하나뿐이라 두 번째 메시지부터는 반드시 이미 존재한다. 아래 배치
    // 삽입은 "행 하나라도 이미 있으면 전체 실패"라서, 같이 넣으면 그 주제의 모든 처리가
    // 멎는다(라이브에서 outbox-idempotency-conflict 로 제안 메시지가 통째로 안 나갔다).
    const insertedOutbox = await this.insertOutboxRowsIdempotently(controlHydratedRows);

    return {
      events: persistedEvents.map((event) => ({ ...event, createdAt: event.createdAt ?? createdAt })),
      outbox: insertedOutbox.map(toPersistedOutboxItem)
    };
  }

  private async hydrateFinalApprovalRows(rows: OutboxInsertRow[]): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      if (!row.idempotency_key.startsWith("telegram:final-approved:")) {
        hydrated.push(row);
        continue;
      }
      const taskId = taskIdFromBinding(row.payload.binding);
      if (!taskId) {
        hydrated.push(row);
        continue;
      }
      const [reports, artifacts] = await Promise.all([
        this.client.request("GET", "/huai_task_reports?task_id=eq." + encodeURIComponent(taskId) + "&kind=eq.execution&select=body&order=created_at.desc&limit=1")
          .then((response) => response.json<Array<{ body: string }>>()),
        this.client.request("GET", "/huai_artifacts?task_id=eq." + encodeURIComponent(taskId) + "&select=uri,public_url&order=created_at.desc&limit=10")
          .then((response) => response.json<Array<{ uri: string; public_url?: string | null }>>())
      ]);
      const text = buildFinalApprovalResultText(taskId, reports[0]?.body, artifacts);
      hydrated.push({ ...row, payload: { ...row.payload, text: maskSensitiveText(text).slice(0, 3900) } });
    }
    return hydrated;
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

  // 지금 실행 중인 것들을 방 단위로 알려준다.
  //
  // 실행 중 표시("…이 입력 중")를 유지하려면 어느 방이 도는지 알아야 한다. 별도 상태를
  // 만들지 않고 huai_outbox 를 그대로 읽는다 — 게이트웨이가 리스해서 processing 인 행이
  // 곧 실행 중인 것이고, 끝나면 sent/dead 로 바뀌어 표시도 자연히 멎는다.
  async listInFlightExecutions(): Promise<Array<{ telegramChatId: string; startedAtMs: number; isPlanning: boolean }>> {
    const rows = await this.client
      // 리스 전(pending)·재시도 대기(retry_pending)도 실행 중으로 친다.
      //
      // processing 만 세면 방장이 승인한 뒤 게이트웨이가 그 행을 집어갈 때까지, 그리고 감사
      // 요청이 큐에 올라간 뒤 시작될 때까지 표시가 꺼진다. 방장 눈에는 "움직이던 게 멈췄는데
      // 결과는 안 나온" 구간이 된다 — 실제로는 그 사이에도 일은 진행 중이다.
      .request("GET", "/huai_outbox?target_kind=eq.local_gateway&status=in.(pending,processing,retry_pending)&select=payload,locked_at,created_at&limit=50")
      .then((response) => response.json<Array<{ payload?: Record<string, unknown>; locked_at?: string; created_at?: string }>>());

    return rows
      .map((row) => {
        const telegramChatId = typeof row.payload?.telegramChatId === "string" ? row.payload.telegramChatId : "";
        const request = row.payload?.executionRequest as { telegramMessageThreadId?: unknown; attemptId?: unknown } | undefined;
        const messageThreadId = typeof request?.telegramMessageThreadId === "string" ? request.telegramMessageThreadId : undefined;
        // 언제부터 돌았는지는 리스한 시각이 가장 가깝다. 없으면 행이 생긴 시각으로 대체한다.
        const startedAt = Date.parse(String(row.locked_at ?? row.created_at ?? ""));
        const isPlanning = typeof request?.attemptId === "string" && isLeaderPlanningAttempt(request.attemptId);
        return { telegramChatId, messageThreadId, startedAtMs: Number.isFinite(startedAt) ? startedAt : Date.now(), isPlanning };
      })
      .filter((execution) => execution.telegramChatId.length > 0);
  }

  // OutboxDispatcherStore 구현은 supabase-outbox-dispatch-store.ts 로 위임한다(위 필드 주석 참고).
  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.outboxDispatchStore.leasePending(limit, leaseUntil);
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.outboxDispatchStore.leasePendingLocalGateway(limit, leaseUntil);
  }

  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    return this.outboxDispatchStore.markSent(outboxId, result);
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string): Promise<void> {
    return this.outboxDispatchStore.markRetry(outboxId, error, nextAttemptAt);
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    return this.outboxDispatchStore.markDead(outboxId, error);
  }

  // 방장·리더의 결정을 append-only 원장에 남긴다.
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

  private async materializePostCompletionChanges(events: readonly PersistedEvent[], roomId: string): Promise<void> {
    for (const event of events) {
      if (event.eventType !== "post_completion_scope_change_requested") continue;
      const payload = event.payload as Record<string, unknown>;
      const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
      const scope = typeof payload.scope === "string" ? payload.scope : "";
      if (!taskId || !scope) continue;
      await this.client.request("POST", "/huai_tasks", {
        body: {
          room_id: roomId,
          proposal_id: null,
          idempotency_key: "post-completion-scope-change:" + event.idempotencyKey,
          status: "proposal_pending",
          priority: "normal",
          title: "완료 후 범위 변경: " + taskId.slice(0, 12),
          purpose: "완료된 작업에서 새 범위의 변경을 별도 카드로 관리",
          scope,
          completion_criteria: "변경 범위 실행 후 독립 검증 및 방장 최종 승인",
          telegram_message_thread_id: typeof payload.telegramChatId === "string" ? payload.telegramChatId : null
        },
        prefer: "return=minimal"
      }).then((response) => (response.status === 409 ? undefined : response.expectOk()));
    }
  }

  private async insertOutboxRowsIdempotently(rows: OutboxInsertRow[]): Promise<OutboxRow[]> {
    if (rows.length === 0) return [];
    const body = rows.map((row) => ({ ...row, event_id: row.event_id ?? null }));
    const response = await this.client.request("POST", "/huai_outbox", {
      body,
      prefer: "return=representation"
    });
    if (response.status !== 409) return response.json<OutboxRow[]>();

    // 배치 안에 이미 있는 행이 하나라도 있으면 INSERT 전체가 409 로 돌아온다. 예전에는
    // 여기서 통째로 예외를 던졌는데, 그러면 같은 배치의 새 메시지도 함께 사라진다 —
    // 방장이 버튼을 눌러도 방에 아무 반응이 없는 상태가 그것이었다(이미 결정된 제안에
    // 다른 결정을 눌렀을 때 처리 전체가 죽었다).
    //
    // 그래서 행마다 가른다: 같은 내용이면 있는 것을 쓰고, 없으면 새로 넣고, 같은 키인데
    // 내용이 다르면 그 행만 버린다. 버릴 때는 왜 버렸는지 방에 알린다 — 조용히 사라지는
    // 것이 이 시스템에서 가장 나쁜 실패다.
    const existing = await this.fetchOutboxRowsByIdempotencyKeys(rows.map((row) => row.idempotency_key));
    const existingByKey = new Map(existing.map((row) => [row.idempotency_key, row]));
    const inserted: OutboxRow[] = [];
    const conflicted: OutboxInsertRow[] = [];

    for (const row of rows) {
      const found = existingByKey.get(row.idempotency_key);
      if (found && sameOutboxContent(row, found)) {
        inserted.push(found);
        continue;
      }
      if (found) {
        // 실행 요청은 조용히 버리면 안 된다 — 작업이 큐에 안 들어간 채 끝난다.
        // 방에 나가는 메시지만 건너뛰고 그 사실을 알린다.
        if (row.target_kind !== "telegram_bot") throw new Error("outbox-idempotency-conflict");
        conflicted.push(row);
        continue;
      }
      const single = await this.client.request("POST", "/huai_outbox", {
        body: { ...row, event_id: row.event_id ?? null },
        prefer: "return=representation"
      });
      // 그사이 다른 처리가 같은 키를 넣었으면 그걸 쓴다.
      if (single.status === 409) continue;
      await single.expectOk();
      inserted.push(...(await single.json<OutboxRow[]>()));
    }

    for (const row of conflicted) {
      console.error(`outbox-idempotency-conflict-skipped:${row.idempotency_key}`);
      await this.notifyAlreadyDecided(row);
    }

    return inserted;
  }

  // 같은 키로 다른 결정이 들어왔다 = 이미 결정된 건에 다시 결정을 눌렀다는 뜻이다.
  // 그 사실을 방에 알린다. 버튼이 먹통인 것과 "이미 결정됐다"는 것은 방장에게 전혀 다른 정보다.
  private async notifyAlreadyDecided(row: OutboxInsertRow): Promise<void> {
    const telegramChatId = outboxTargetChatId(row.target);
    if (!telegramChatId) return;
    const idempotencyKey = "telegram:already-decided:" + row.idempotency_key;
    const notice = {
      event_id: row.event_id ?? null,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot" as const,
      target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
      payload: {
        botRole: "leader",
        telegramChatId,
        messageThreadId: optionalPayloadString(row.payload.messageThreadId),
        text: ["이미 결정이 끝난 건이라 다시 처리하지 않았습니다.", "새로 지시해 주시면 새 작업으로 진행합니다."].join("\n"),
        binding: { kind: "event", eventId: row.event_id ?? idempotencyKey },
        idempotencyKey
      },
      room_id: row.room_id
    };
    const response = await this.client.request("POST", "/huai_outbox", { body: notice, prefer: "return=minimal" });
    if (response.status !== 409) await response.expectOk();
  }

  private async fetchOutboxRowsByIdempotencyKeys(keys: string[]): Promise<OutboxRow[]> {
    const quoted = keys.map((key) => '"' + escapePostgrestInValue(key) + '"').join(",");
    return this.client
      .request("GET", "/huai_outbox?idempotency_key=in.(" + encodeURIComponent(quoted) + ")&select=huai_outbox_id,event_id,idempotency_key,target_kind,target,payload,status,attempts,created_at,sent_at,last_error")
      .then((response) => response.json<OutboxRow[]>());
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

}

export function buildSupabaseBotServiceStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    miniAppDirectLinkBaseUrl: env.BOT_SERVICE_MINIAPP_DIRECT_LINK || undefined
  });
}

// ─────────────────────────────────────────────────────────────────────────
// God module 분리(2026-08) — 아래는 원래 이 파일에 있던 export 를 그대로 유지하기
// 위한 배럴 재수출이다. 실제 정의는 각 모듈로 옮겨졌다. 외부 import 경로는
// 하나도 바뀌지 않는다.
// ─────────────────────────────────────────────────────────────────────────
export {
  buildFinalApprovalResultText,
  buildApprovedTelegramTaskPromptForTest
} from "./command-prompt-helpers.js";
export {
  type ApprovalStage,
  type ApprovalDecision,
  approvalRecordForEvent,
  approvalEntityRefFromPayload,
  approvalDeciderFromPayload,
  approvalReasonFromPayload
} from "./event-row-mapping.js";
