import { maskTelegramSensitiveText as maskSensitiveText, safeTelegramTraceUri } from "../../telegram-ui/src/sanitize.js";
import {
  AI_ADAPTER_TYPES,
  type AiAdapterType,
  type ArtifactManifest,
  type ExecutionRequest,
  type GatewayEvent,
  type OutboxRecord,
  type OutboxTarget,
  type TelegramSendResult
} from "../../contracts/src/index.js";
import { buildProposalKeyboard } from "../../telegram-ui/src/index.js";
import { isLeaderPlanningAttempt, LEADER_PLANNING_ATTEMPT_PREFIX } from "../../orchestrator/src/index.js";
import { parseLeaderDecision, type LeaderPlan } from "../../orchestrator/src/leader-planning.js";
import {
  isForbiddenTransition,
  transitionTaskStatus,
  type TaskStatus,
  type WorkflowContext,
  type WorkflowEventType
} from "../../workflow/src/index.js";

export type SupabaseRuntimeConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  // "전문 보기" 버튼이 열 현황판 딥링크의 베이스. 없으면 버튼 없이 앞부분만 보낸다.
  miniAppDirectLinkBaseUrl?: string;
  // 이 게이트웨이 앞으로 온 일만 리스한다. 없으면 예전처럼 전부 대상 —
  // 텔레그램 발신 리스(bot-service)는 게이트웨이 개념이 없으므로 그대로 둔다.
  gatewayId?: string;
};

export class SupabaseOutboxStore {
  private readonly client: SupabaseRestClient;
  private readonly gatewayId?: string;
  private readonly miniAppDirectLinkBaseUrl?: string;

  constructor(config: SupabaseRuntimeConfig) {
    this.client = new SupabaseRestClient(config);
    this.gatewayId = config.gatewayId;
    this.miniAppDirectLinkBaseUrl = config.miniAppDirectLinkBaseUrl;
  }

  // 보고 전문을 남긴다. 이벤트·아웃박스는 30일 뒤 지우지만 이 행은 남는다 — 안 그러면
  // "전문 보기" 버튼이 30일 뒤 빈 화면이 된다.
  private async saveTaskReport(
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

  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "telegram_bot");
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    const leased = await this.leaseOutbox(limit, leaseUntil, "local_gateway");
    const runnable: OutboxRecord[] = [];
    for (const row of leased) {
      const request = executionRequestFromOutbox(row);
      if (!request || await this.isTaskRunnable(request.taskId)) {
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

  async recordGatewayExecutionResult(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }): Promise<void> {
    const telegramChatId = await this.fetchRoomTelegramChatId(input.request.roomId);
    const eventType = input.status === "completed" ? "meaningful_intermediate_ready" : "execution_delayed_or_failed";
    const eventKey = "gateway-result:" + input.request.attemptId + ":" + input.status;
    const event = await this.insertEventIdempotently({
      room_id: input.request.roomId,
      task_id: isUuid(input.request.taskId) ? input.request.taskId : null,
      event_type: eventType,
      idempotency_key: eventKey,
      payload: {
        taskId: input.request.taskId,
        attemptId: input.request.attemptId,
        actorId: input.request.actorId,
        adapterType: input.request.adapterType,
        status: input.status,
        errorKind: maskSensitiveText(input.errorKind ?? ""),
        occurredAt: input.occurredAt,
        events: summarizeGatewayEvents(input.events)
      }
    });

    // 소대장 판단은 작업 실행이 아니다. "작업 실행 완료" 보고를 내보내면 방에 잡음만 남는다.
    // 판단 결과는 아래 applyLeaderPlanningResult 가 제안 또는 답변으로 올린다.
    if (isLeaderPlanningAttempt(input.request.attemptId)) {
      await this.applyLeaderPlanningResult(input, telegramChatId, event.event_id);
      return;
    }

    const botRole = input.request.reportBotRole ?? (input.request.adapterType === "codex" ? "codex_leader" : "claude_leader");
    const resultSummary = summarizeGatewayOutput(input.events) ?? "";
    const fullText = renderGatewayReportText(input);
    const idempotencyKey = "telegram-report:" + input.request.attemptId + ":" + input.status;

    // 긴 보고는 앞부분만 방에 보내고 전문은 현황판에서 읽는다. 전문을 먼저 저장해야
    // 버튼이 가리킬 곳이 생긴다 — 저장 전에 버튼을 보내면 눌렀을 때 빈 화면이 된다.
    const report = await this.saveTaskReport(input.request, botRole, fullText);
    const preview = buildRoomMessageWithPreview(fullText, roomMessagePreviewLimit());
    const text = preview.text;
    const reportKeyboard = preview.truncated && report ? buildReportOpenKeyboard(report.report_id, this.miniAppDirectLinkBaseUrl) : undefined;

    await this.insertOutboxIdempotently({
      event_id: event.event_id,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole, telegramChatId }),
      payload: {
        botRole,
        // 실행 보고는 지시가 오간 주제로 돌아간다. 이 값이 없으면 General 로 떨어져
        // 방장은 자기가 시킨 자리에서 결과를 못 본다.
        messageThreadId: input.request.telegramMessageThreadId,
        telegramChatId,
        text,
        keyboard: reportKeyboard,
        binding: { kind: "event", eventId: event.event_id },
        idempotencyKey
      },
      room_id: input.request.roomId
    });

    // 한 엔진이 사용 한도에 걸리면 다른 엔진으로 한 번 다시 건다.
    //
    // 라이브에서 감사가 Codex 한도로 죽었고, 방장이 손으로 다시 시키기 전까지 작업이
    // 멈춰 있었다. 한도는 우리가 고칠 수 있는 게 아니지만, 다른 엔진은 멀쩡하다.
    //
    // 감사도 넘긴다. 원칙은 작업자와 다른 엔진에 맡기는 것이고 그게 최선이지만, 그
    // 엔진이 막혔을 때의 선택지는 "같은 모델의 다른 세션이 diff 를 보고 반증한다" 와
    // "아무도 안 본다" 둘뿐이다. 후자가 더 나쁘다. 대신 방에 그 사실을 밝힌다 —
    // 방장이 알고 승인하는 것과 시스템이 몰래 때우는 것은 다르다(아래 fallbackNotice).
    // 판정은 정제본이 아니라 원본 출력으로 한다.
    //
    // 라이브에서 Codex 한도 초과가 폴백되지 않고 그대로 실패로 끝났다. 방에 나간 문구는
    // "사용 한도 초과"였는데도 그랬다 — 보고문은 원본 출력을 보고, 폴백 판정만 정제본을
    // 봤기 때문이다. 정제본은 사람이 읽을 문장만 남기려고 Codex 의 JSON 줄을 내부 잡음으로
    // 걸러내는데, 한도 통보가 바로 그 JSON 줄에 들어 있다. 같은 실행을 두고 두 판정이
    // 서로 다른 입력을 보면 이렇게 갈린다.
    if (input.status === "failed" && shouldFallbackToOtherEngine(input.request, input.errorKind, gatewayFailureEvidence(input.events))) {
      await this.enqueueEngineFallback(input.request, telegramChatId, event.event_id);
      return;
    }

    // 실행 결과를 상태기계에 반영한다.
    //
    // 이게 없으면 실행이 끝나도 작업이 영원히 scheduled 로 남는다.
    // 방장이 /tasks 를 치면 이미 끝난 일이 "실행 대기"로 보인다.
    await this.advanceTaskThroughExecution(input.request.taskId, input.status);

    if (input.status === "completed") {
      await this.persistCollectedArtifacts(input.request, input.events);
    }

    if (input.status === "completed" && input.request.reportBotRole === "auditor") {
      // 감사가 아무 판정도 못 내고 끝나는 일이 있다. CLI 가 권한 문제로 도구를 하나도
      // 못 써서 "no output produced" 만 남기고 종료코드 0 으로 끝난 경우다(라이브에서
      // Antigravity 가 그랬다). 그걸 감사 결과로 받으면 근거 없는 "보완 필요"가 방에
      // 걸리고 작업자가 고칠 것도 없는 수정 요구를 받는다.
      if (auditProducedNoVerdict(resultSummary)) {
        await this.reportEmptyAudit(input.request, telegramChatId, event.event_id);
        return;
      }
      await this.recordAuditVerification(input, resultSummary, telegramChatId, event.event_id);
    }

    if (input.status === "completed") {
      await this.enqueueMultiAiAuditIfReady(input, telegramChatId, event.event_id);
    }

    if (input.status === "completed" && shouldRunAutomaticAudit(input.request, input.events)) {
      await this.enqueueSingleWorkerAudit(input, resultSummary, telegramChatId, event.event_id);
    } else if (input.status === "completed" && !isLeaderPlanningAttempt(input.request.attemptId) && input.request.reportBotRole !== "auditor") {
      await this.closeWithoutAudit(input.request, telegramChatId, event.event_id);
    }
  }

  // 감사가 붙지 않는 실행을 완료 승인 대기까지 보낸다.
  //
  // 실행이 끝나면 작업은 verification_pending 으로 간다. 원래는 감사가 그 뒤를 이어
  // 통과시켜 완료 승인 대기로 올렸다. 그런데 파일을 바꾸지 않은 실행("줄 수 알려줘")은
  // 감사를 붙이지 않기로 했으므로, 그 자리에서 깨울 사람이 없어 영영 멈춘다 —
  // 라이브에서 조회 작업 5건이 검증 대기에 묶여 현황판 "대기" 칸만 불렸다.
  //
  // 자동으로 완료 처리하지는 않는다. 마지막 한 번은 방장이 누른다(FR-015). 감사할
  // 대상이 없다는 것이 방장 확인까지 건너뛸 이유는 아니다.
  private async closeWithoutAudit(request: ExecutionRequest, telegramChatId: string, sourceEventId: string): Promise<void> {
    if (!isUuid(request.taskId)) return;
    await this.advanceTaskStatus(request.taskId, "verification_started", { isVerifier: true, actorRole: "auditor", verifierActorId: request.actorId, authorActorId: "system" });
    await this.advanceTaskStatus(request.taskId, "verification_passed", { isVerifier: true, actorRole: "auditor" });
    await this.advanceTaskStatus(request.taskId, "commander_completion_approved", { actorRole: "platoon_leader" });

    const idempotencyKey = "telegram-completion-review:" + request.attemptId;
    await this.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
      payload: {
        botRole: "platoon_leader",
        messageThreadId: request.telegramMessageThreadId,
        telegramChatId,
        text: "바꾼 파일이 없어 별도 검증 없이 마쳤습니다.\n완료 승인은 고정된 작업 현황판에서 결정해 주세요.",
        binding: { kind: "event", eventId: sourceEventId },
        idempotencyKey
      },
      room_id: request.roomId
    });
  }

  // 파일을 바꾼 작업은 방장이 버튼을 누르지 않아도 감사가 돈다.
  //
  // 예전에는 감사 "요청" 메시지만 방에 올리고 실제 실행은 방장이 검증 버튼을 눌러야
  // 걸렸다. 라이브에서 단일 작업자 자동감사로 실제 실행된 건수는 0이었다(게이트웨이
  // 실행요청 172건 중 감사 9건은 전부 다중 AI 경로였다) — 즉 자동 검증은 이름뿐이고
  // 아무것도 검증되지 않고 있었다. 수동 결정(완료·보완)은 작업 현황판이 맡는다.
  // 한도에 걸린 실행을 다른 엔진으로 다시 건다.
  private async enqueueEngineFallback(
    request: ExecutionRequest,
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    const gatewayId = await this.fetchActiveGatewayId(request.roomId);
    if (!gatewayId) return;

    const fallbackAdapter = nextEngineAfter(request.adapterType, request.workerAdapterType);
    const attemptId = request.attemptId + FALLBACK_ATTEMPT_SUFFIX;
    const isAudit = request.reportBotRole === "auditor";

    await this.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: "gateway:engine-fallback:" + attemptId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: {
        executionRequest: {
          ...request,
          attemptId,
          adapterType: fallbackAdapter,
          // 보고자도 같이 바꾼다. 엔진만 바꾸면 ClaudeBot 이 한 작업을 CodexBot 이름으로
          // 보고한다 — 라이브에서 방장이 "엉터리"라고 지적한 그 화면이다. 감사 보고는
          // 엔진과 무관하게 AuditorBot 이 내므로 그대로 둔다.
          reportBotRole: isAudit ? request.reportBotRole : reportBotRoleForAdapter(fallbackAdapter),
          idempotencyKey: "engine-fallback:" + attemptId
        },
        telegramChatId
      },
      room_id: request.roomId
    });

    const blockedActor = engineActorName(request.adapterType);
    const takingOver = engineActorName(fallbackAdapter);
    // 현황판의 "담당"도 실제로 일한 엔진으로 바꾼다. 방에 나가는 문구만 고치면 방장이
    // 나중에 현황판을 열었을 때 다시 CodexBot 이 한 것으로 보인다 — 같은 거짓말이 두 자리에
    // 있었던 셈이다(감사는 AuditorBot 이 맡으므로 담당을 건드리지 않는다).
    if (!isAudit) await this.reassignTaskToEngine(request, fallbackAdapter);
    await this.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: "telegram-engine-fallback:" + attemptId,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
      payload: {
        botRole: "platoon_leader",
        messageThreadId: request.telegramMessageThreadId,
        telegramChatId,
        text: isAudit
          // 감사가 넘어간 것은 반드시 밝힌다. 작업자와 같은 엔진이 감사하면 독립성이
          // 떨어지는데, 그걸 모르고 승인하면 검증받았다고 착각하게 된다.
          // 엔진이 셋이면 대개 작업자와 다른 엔진이 남으므로, 그 경고는 정말 겹칠 때만 붙인다.
          ? `${blockedActor} 사용 한도 초과로 ${takingOver}가 대신 검증합니다.` +
            (fallbackAdapter === request.workerAdapterType
              ? "\n작업자와 같은 엔진이라 독립성이 평소보다 낮습니다. 승인 시 참고해 주세요."
              : "")
          : `${blockedActor} 사용 한도 초과로 ${takingOver}가 이어서 작업합니다.`,
        binding: { kind: "event", eventId: sourceEventId },
        idempotencyKey: "telegram-engine-fallback:" + attemptId
      },
      room_id: request.roomId
    });
  }

  // 넘겨받은 엔진을 작업의 담당으로 기록한다.
  private async reassignTaskToEngine(request: ExecutionRequest, adapterType: AiAdapterType): Promise<void> {
    if (!isUuid(request.taskId)) return;
    const role = reportBotRoleForAdapter(adapterType);
    const actors = await this.client
      .request(
        "GET",
        "/huai_ai_actors?room_id=eq." + encodeURIComponent(request.roomId) +
          "&role=eq." + encodeURIComponent(role) +
          "&status=eq.active&select=actor_id&limit=1"
      )
      .then((response) => response.json<Array<{ actor_id: string }>>());
    const actorId = actors[0]?.actor_id;
    if (!actorId) return;

    await this.client
      .request("PATCH", "/huai_tasks?task_id=eq." + encodeURIComponent(request.taskId), {
        body: { assignee_actor_id: actorId },
        prefer: "return=minimal"
      })
      .then((response) => response.expectOk());
  }

  private async enqueueSingleWorkerAudit(
    input: { request: ExecutionRequest; events: GatewayEvent[] },
    resultSummary: string,
    telegramChatId: string,
    eventId: string
  ): Promise<void> {
    const gatewayId = await this.fetchActiveGatewayId(input.request.roomId);
    if (!gatewayId) return;

    const actor = engineActorName(input.request.adapterType);
    const auditRequest: ExecutionRequest = {
      ...input.request,
      attemptId: input.request.attemptId + "-audit",
      // 작업자와 다른 엔진에 맡긴다. 같은 엔진이 자기 결과를 보면 독립 감사가 아니다.
      adapterType: nextEngineAfter(input.request.adapterType),
      // 감사가 한도에 걸려 또 넘어갈 때 작업자 엔진으로 되돌아가지 않게 남겨 둔다.
      workerAdapterType: input.request.adapterType,
      prompt: buildSingleWorkerAuditPrompt(input.request.taskId, actor, resultSummary, realArtifactPaths(input.events)),
      idempotencyKey: "single-worker-audit:" + input.request.attemptId,
      reportBotRole: "auditor"
    };

    await this.insertOutboxIdempotently({
      event_id: eventId,
      idempotency_key: "gateway:single-worker-audit:" + input.request.attemptId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: { executionRequest: auditRequest, telegramChatId },
      room_id: input.request.roomId
    });
  }

  // 소대장이 대화를 읽고 내린 판단을 방에 올린다.
  // 판단 실패는 조용히 넘기지 않는다 — 사람이 불렀는데 아무 반응이 없으면 시스템이 죽은 것처럼 보인다.
  private async applyLeaderPlanningResult(
    input: { request: ExecutionRequest; status: "completed" | "failed" | "rejected"; events: GatewayEvent[] },
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    await this.rememberLeaderSession(input.request.actorId, input.events);

    const idempotencyKey = "telegram-leader-plan:" + input.request.attemptId;
    // Telegram 표시용 정리본(summarizeGatewayOutput)은 JSON 을 내부 로그로 보고 걷어낸다.
    // 소대장 판단은 JSON 이므로 반드시 원본 stdout 에서 읽어야 한다.
    const decision = input.status === "completed"
      ? parseLeaderDecision(rawStdoutFromGatewayEvents(input.events))
      : undefined;

    if (!decision) {
      await this.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
        payload: {
          botRole: "platoon_leader",
          messageThreadId: input.request.telegramMessageThreadId,
          telegramChatId,
          text: "요청을 작업으로 정리하지 못했습니다. 조금 더 구체적으로 다시 말씀해 주세요.",
          binding: { kind: "event", eventId: sourceEventId },
          idempotencyKey
        },
        room_id: input.request.roomId
      });
      return;
    }

    // 질문에는 작업 카드가 아니라 답으로 응한다.
    if (decision.kind === "answer") {
      await this.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
        payload: {
          botRole: "platoon_leader",
          messageThreadId: input.request.telegramMessageThreadId,
          telegramChatId,
          text: maskSensitiveText(decision.text).slice(0, 3000),
          binding: { kind: "event", eventId: sourceEventId },
          idempotencyKey
        },
        room_id: input.request.roomId
      });
      return;
    }

    if (decision.kind === "no_action") {
      await this.insertEventIdempotently({
        room_id: input.request.roomId,
        task_id: null,
        event_type: "proposal_rejected",
        idempotency_key: "leader-no-action:" + input.request.attemptId,
        payload: { stage: "leader_no_action", reason: decision.reason, attemptId: input.request.attemptId }
      });
      await this.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
        payload: {
          botRole: "platoon_leader",
          messageThreadId: input.request.telegramMessageThreadId,
          telegramChatId,
          text: maskSensitiveText(decision.reason || "알겠습니다.").slice(0, 500),
          binding: { kind: "event", eventId: sourceEventId },
          idempotencyKey
        },
        room_id: input.request.roomId
      });
      return;
    }

    const plan = decision.plan;
    // Telegram 콜백 데이터는 64바이트가 한계다.
    // "proposal:<id>:approve" 형태로 실려 나가므로 id 를 짧게 유지해야 한다.
    // 처음엔 attemptId 를 그대로 붙였다가 71바이트가 되어 BUTTON_DATA_INVALID 로 죽었다.
    const proposalId = shortProposalId(input.request.attemptId);
    await this.insertEventIdempotently({
      room_id: input.request.roomId,
      task_id: null,
      event_type: "proposal_created",
      idempotency_key: "leader-proposal:" + input.request.attemptId,
      payload: {
        proposalId,
        // 소대장 판단은 방장이 말을 건 주제에서 시작됐다. 그 주제를 여기서 놓치면
        // 승인 뒤 만들어지는 작업이 어느 주제 것인지 알 길이 없어진다.
        messageThreadId: input.request.telegramMessageThreadId,
        title: plan.title,
        purpose: plan.purpose,
        scope: plan.scope,
        completionCriteria: plan.completionCriteria,
        rawText: plan.scope,
        requestedActorRole: plan.assignee === "both" ? undefined : plan.assignee,
        intent: plan.assignee === "both" ? "multi_ai_review" : "new_task",
        assignee: plan.assignee,
        assigneeReason: plan.reason,
        stage: "leader_planned",
        createdAt: new Date().toISOString()
      }
    });

    await this.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
      payload: {
        botRole: "platoon_leader",
        messageThreadId: input.request.telegramMessageThreadId,
        telegramChatId,
        text: renderLeaderPlanMessage(plan),
        keyboard: buildProposalKeyboard(proposalId),
        binding: { kind: "event", eventId: sourceEventId },
        idempotencyKey
      },
      room_id: input.request.roomId
    });
  }

  // 다음 호출에서 --resume 으로 이어받도록 세션을 기억한다.
  private async rememberLeaderSession(actorId: string, events: readonly GatewayEvent[]): Promise<void> {
    if (!isUuid(actorId)) return;
    const sessionId = sessionIdFromGatewayEvents(events);
    if (!sessionId) return;
    await this.client
      .request("PATCH", "/huai_ai_actors?actor_id=eq." + encodeURIComponent(actorId), {
        body: { cli_session_id: sessionId, cli_session_updated_at: new Date().toISOString() },
        prefer: "return=minimal"
      })
      .then((response) => response.expectOk())
      .catch(() => undefined);
  }

  private async persistCollectedArtifacts(request: ExecutionRequest, events: readonly GatewayEvent[]): Promise<void> {
    if (!isUuid(request.taskId)) return;
    const collected = collectedArtifactsFromEvents(events);
    if (collected.length === 0) return;

    const saved: Array<{ uri: string; version: string; isFinal: boolean }> = [];
    for (const artifact of collected) {
      const uri = artifactUri(artifact, request);
      const existing = await this.client
        .request(
          "GET",
          "/huai_artifacts?task_id=eq." + encodeURIComponent(request.taskId) +
            "&uri=eq." + encodeURIComponent(uri) +
            "&version=eq." + encodeURIComponent(artifact.version) +
            "&select=artifact_id&limit=1"
        )
        .then((response) => response.json<Array<{ artifact_id: string }>>());
      if (existing.length > 0) continue;

      // 409 = huai_artifacts_task_uri_version_unique 위반.
      // 리스 만료로 같은 attempt 가 in-flight 중복 실행됐다는 뜻이므로 정상 스킵한다.
      const inserted = await this.client.request("POST", "/huai_artifacts", {
        body: {
          task_id: request.taskId,
          uri,
          // 폰에서 열 수 있는 주소. 게이트웨이가 웹 산출물을 올렸을 때만 붙는다.
          public_url: artifact.publicUrl ?? null,
          version: artifact.version,
          checksum: artifact.checksum,
          author_actor_id: isUuid(request.actorId) ? request.actorId : null,
          is_final: false
        },
        prefer: "return=minimal"
      });
      if (inserted.status === 409) continue;
      await inserted.expectOk();
      saved.push({ uri, version: artifact.version, isFinal: false });
    }

    if (saved.length === 0) return;

    const savedEvent = await this.insertEventIdempotently({
      room_id: request.roomId,
      task_id: request.taskId,
      event_type: "artifact_saved",
      idempotency_key: "artifact-saved:" + request.attemptId,
      payload: {
        taskId: request.taskId,
        attemptId: request.attemptId,
        actorId: request.actorId,
        artifactCount: saved.length,
        artifacts: saved
      }
    });

    await this.enqueueDocumentDeliveries(request, collected, savedEvent.event_id);
  }

  // 문서 산출물을 방에 파일로 올린다.
  //
  // 웹 산출물(.html)은 게이트웨이가 공개 주소로 올려 링크로 열 수 있다. 문서(hwp·xlsx·pdf)는
  // 브라우저에서 열리지 않으므로 링크를 줘봐야 소용이 없다 — 파일 자체를 방에 올려야
  // 방장이 폰에서 받아볼 수 있다.
  private async enqueueDocumentDeliveries(
    request: ExecutionRequest,
    artifacts: readonly ArtifactManifest[],
    sourceEventId: string
  ): Promise<void> {
    const telegramChatId = await this.fetchRoomTelegramChatId(request.roomId);
    if (!telegramChatId) return;

    for (const artifact of artifacts) {
      const localPath = localArtifactPath(artifact, request);
      if (!localPath || !isDeliverableDocument(localPath)) continue;
      // 크기 한계를 넘는 파일은 텔레그램이 받지 않는다. 시도해서 실패로 남기느니 안 보낸다.
      if (artifact.sizeBytes > TELEGRAM_DOCUMENT_MAX_BYTES) continue;

      const idempotencyKey = "telegram-artifact:" + request.attemptId + ":" + artifact.checksum;
      await this.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
        payload: {
          botRole: "platoon_leader",
          telegramChatId,
          messageThreadId: request.telegramMessageThreadId,
          documentPath: localPath,
          text: "결과물: " + artifact.path,
          binding: { kind: "task", taskId: request.taskId },
          idempotencyKey
        },
        room_id: request.roomId
      });
    }
  }

  // 판정 없이 끝난 감사를 방에 알린다. 조용히 넘기면 방장은 검증이 된 줄 안다.
  private async reportEmptyAudit(
    request: ExecutionRequest,
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    const idempotencyKey = "telegram-empty-audit:" + request.attemptId;
    await this.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "auditor", telegramChatId }),
      payload: {
        botRole: "auditor",
        messageThreadId: request.telegramMessageThreadId,
        telegramChatId,
        text: [
          `${engineActorName(request.adapterType)} 감사가 판정 없이 끝났습니다.`,
          "도구 실행이 막혀 변경 내용을 보지 못했습니다. 이 실행은 검증으로 치지 않습니다.",
          "작업 결과 자체는 남아 있습니다. 검증 없이 승인할지, 다시 검증할지 정해 주세요."
        ].join("\n"),
        binding: { kind: "event", eventId: sourceEventId },
        idempotencyKey
      },
      room_id: request.roomId
    });
  }

  private async recordAuditVerification(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }, resultSummary: string, telegramChatId: string, sourceEventId: string): Promise<void> {
    if (!isUuid(input.request.taskId)) return;
    const verdict = inferVerificationVerdict(resultSummary);
    const existing = await this.client
      .request("GET", "/huai_verifications?task_id=eq." + encodeURIComponent(input.request.taskId) + "&target_version=eq." + encodeURIComponent(input.request.attemptId) + "&select=verification_id&limit=1")
      .then((response) => response.json<Array<{ verification_id: string }>>());
    if (existing.length === 0) {
      await this.client.request("POST", "/huai_verifications", {
        body: {
          task_id: input.request.taskId,
          target_version: input.request.attemptId,
          verdict,
          evidence: resultSummary || "감사 결과가 기록되었습니다.",
          required_fixes: verdict === "fail" ? resultSummary || "보완이 필요합니다." : null,
          recommendations: verdict === "pass" ? null : resultSummary || null,
          reverify_scope: verdict === "pass" ? null : "보완 후 변경 범위 재검증",
          verifier_actor_id: isUuid(input.request.actorId) ? input.request.actorId : null
        },
        prefer: "return=minimal"
      }).then((response) => response.expectOk());
    }

    // 불합격이 막다른 길이 되면 독립 검증 기능 전체가 장식이 된다.
    // 기획서 H-07: "검증 의견 등록 -> 담당 작업팀에 수정 요구, 상태를 수정 중으로 전환".
    if (verdict !== "pass") {
      await this.requestRevisionAfterFailedVerification(input, resultSummary, telegramChatId, sourceEventId);
      return;
    }

    if (verdict === "pass") {
      // 검증 통과 -> 소대장 완료 결정 -> 방장 최종 승인 대기.
      // 앞의 두 단계는 시스템이 진행하고, 마지막 한 번만 방장이 누른다 (FR-015).
      await this.advanceTaskStatus(input.request.taskId, "verification_started", { isVerifier: true, actorRole: "auditor", verifierActorId: input.request.actorId, authorActorId: "system" });
      await this.advanceTaskStatus(input.request.taskId, "verification_passed", { isVerifier: true, actorRole: "auditor" });
      await this.advanceTaskStatus(input.request.taskId, "commander_completion_approved", { actorRole: "platoon_leader" });

      await this.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: "telegram-completion-review:" + input.request.attemptId,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
        payload: {
          botRole: "platoon_leader",
          messageThreadId: input.request.telegramMessageThreadId,
          telegramChatId,
          // 결정 버튼은 방에 붙이지 않는다 — 완료·보완 결정은 작업 현황판이 맡는다.
          // 이 상태(completion_approval_pending·commander_completion_pending)는
          // 작업 현황판에서 decidable 이라(supabase/functions/_shared/task-status.ts) 방장이
          // 갇히지 않는다. 방에는 알림만 남겨 대화 공간을 버튼으로 채우지 않는다.
          text: "검증이 통과되었습니다.\n완료 승인 또는 보완 요청은 고정된 작업 현황판에서 결정해 주세요.",
          binding: { kind: "verification", verificationId: sourceEventId },
          idempotencyKey: "telegram-completion-review:" + input.request.attemptId
        },
        room_id: input.request.roomId
      });
    }
  }

  // 검증 불합격 -> 보완 요청. FR-014 / H-07 / AC-07.
  // 담당팀에게 필수 수정을 전달하고 작업 상태를 revision_requested 로 전이시킨다.
  // 검증자는 직접 수정하지 않는다 — 의견서만 남기고 수정은 원 담당팀이 한다(AC-07).
  private async requestRevisionAfterFailedVerification(
    input: { request: ExecutionRequest; events: GatewayEvent[]; occurredAt: string },
    resultSummary: string,
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    const taskId = input.request.taskId;
    const requiredFixes = resultSummary || "검증에서 보완이 필요한 항목이 확인되었습니다.";
    const reverifyScope = "보완된 변경 범위";

    if (isUuid(taskId)) {
      const existing = await this.client
        .request("GET", "/huai_revision_requests?task_id=eq." + encodeURIComponent(taskId) + "&status=eq.open&select=revision_request_id&limit=1")
        .then((response) => response.json<Array<{ revision_request_id: string }>>());
      if (existing.length === 0) {
        await this.client.request("POST", "/huai_revision_requests", {
          body: {
            task_id: taskId,
            required_fixes: maskSensitiveText(requiredFixes).slice(0, 4000),
            reverify_scope: reverifyScope,
            status: "open"
          },
          prefer: "return=minimal"
        }).then((response) => (response.status === 409 ? undefined : response.expectOk()));
      }
    }

    // 상태기계에 실제로 반영한다. 이벤트만 쌓고 상태를 안 바꾸면 작업은 여전히 검증 중으로 남는다.
    const event = await this.insertEventIdempotently({
      room_id: input.request.roomId,
      task_id: isUuid(taskId) ? taskId : null,
      event_type: "verification_failed_or_changes_requested",
      idempotency_key: "verification-failed:" + input.request.attemptId,
      payload: {
        taskId,
        attemptId: input.request.attemptId,
        verifierActorId: input.request.actorId,
        actorRole: "auditor",
        requiredFixes: maskSensitiveText(requiredFixes).slice(0, 4000),
        reverifyScope,
        changedScope: "content",
        occurredAt: input.occurredAt
      }
    });
    await this.advanceTaskStatus(taskId, "verification_failed_or_changes_requested", { isVerifier: true, actorRole: "auditor" });

    // 담당팀 봇으로 보완 요청을 보낸다. 검증자 봇이 아니라 작업자 봇이 받아야 한다.
    const assigneeBotRole = input.request.adapterType === "claude_code" ? "claude_leader" : "codex_leader";
    const idempotencyKey = "telegram-revision-request:" + input.request.attemptId;
    await this.insertOutboxIdempotently({
      event_id: event.event_id,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: assigneeBotRole, telegramChatId }),
      payload: {
        botRole: assigneeBotRole,
        messageThreadId: input.request.telegramMessageThreadId,
        telegramChatId,
        text: renderRevisionRequestText(taskId, requiredFixes, reverifyScope),
        binding: { kind: "task", taskId },
        idempotencyKey
      },
      room_id: input.request.roomId
    });
  }

  // 승인된 작업이 실행을 거쳐 검증 대기까지 스스로 이동한다.
  // 사람이 눌러야 하는 지점은 시작 승인과 최종 완료 승인 둘뿐이다.
  private async advanceTaskThroughExecution(taskId: string, status: "completed" | "failed" | "rejected"): Promise<void> {
    if (!isUuid(taskId)) return;
    // scheduled -> queued_for_gateway -> in_progress
    await this.advanceTaskStatus(taskId, "dependencies_satisfied", {});
    await this.advanceTaskStatus(taskId, "task_started", {});
    if (status !== "completed") {
      await this.advanceTaskStatus(taskId, "execution_delayed_or_failed", {});
      return;
    }
    // in_progress -> verification_pending (검증 호출은 방장 결정 사항이 아니다)
    await this.advanceTaskStatus(taskId, "meaningful_intermediate_ready", {});
  }

  // 게이트웨이 결과 경로에서도 상태기계를 적용한다.
  // 이 경로는 원래 이벤트만 쓰고 작업 상태를 바꾸지 않아, 실행 결과가 상태기계에 닿지 않았다.
  private async advanceTaskStatus(
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

  private async enqueueMultiAiAuditIfReady(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }, telegramChatId: string, eventId: string): Promise<void> {
    const group = multiAiAttemptGroup(input.request.attemptId);
    if (!group) return;

    // room_id 필터 없이 전역 최근 100건을 긁으면, 여러 방이 동시에 도는 상황에서
    // 다른 방의 이벤트가 이 방의 claude/codex 짝을 큐에서 밀어낸다. 그러면
    // claude/codex 둘 다 이미 도착했는데도 :538 에서 조용히 return 되어 교차 감사가
    // 영영 큐잉되지 않는다 — 에러도 로그도 없는 무증상 고장이라 운영 중 알아채기 어렵다.
    // roomId 는 이미 이 함수 안에서 :540 이 fetchActiveGatewayId(roomId) 로 쓰고 있어
    // 같은 값을 여기 필터에도 붙인다.
    const rows = await this.client
      .request("GET", "/huai_events?event_type=eq.meaningful_intermediate_ready&room_id=eq." + encodeURIComponent(input.request.roomId) + "&select=event_id,payload,created_at&order=created_at.desc&limit=100")
      .then((response) => response.json<Array<{ event_id: string; payload: Record<string, unknown>; created_at?: string }>>());
    const related = rows.filter((row) => isCompletedMultiAiSibling(row.payload, input.request.taskId, group.baseAttemptId));
    const claude = related.find((row) => String(row.payload.attemptId) === group.baseAttemptId + "-claude");
    const codex = related.find((row) => String(row.payload.attemptId) === group.baseAttemptId + "-codex");
    if (!claude || !codex) return;

    const gatewayId = await this.fetchActiveGatewayId(input.request.roomId);
    if (!gatewayId) return;

    const auditAttemptId = group.baseAttemptId + "-audit";
    const auditRequest: ExecutionRequest = {
      ...input.request,
      attemptId: auditAttemptId,
      adapterType: "codex",
      actorId: input.request.actorId,
      prompt: buildMultiAiAuditPrompt(input.request.taskId, claude.payload, codex.payload),
      idempotencyKey: "multi-ai-audit:" + input.request.taskId + ":" + group.baseAttemptId,
      reportBotRole: "auditor"
    };

    await this.insertOutboxIdempotently({
      event_id: eventId,
      idempotency_key: "gateway:multi-ai-audit:" + input.request.taskId + ":" + group.baseAttemptId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: { executionRequest: auditRequest, telegramChatId },
      room_id: input.request.roomId
    });
  }

  private async fetchActiveGatewayId(roomId: string): Promise<string | undefined> {
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

  private async fetchRoomTelegramChatId(roomId: string): Promise<string> {
    const rows = await this.client
      .request("GET", `/huai_rooms?room_id=eq.${encodeURIComponent(roomId)}&select=telegram_chat_id`)
      .then((response) => response.json<Array<{ telegram_chat_id: string | number }>>());
    const value = rows[0]?.telegram_chat_id;
    if (value === undefined || value === null) throw new Error("room-telegram-chat-id-not-found");
    return String(value);
  }

  private async insertEventIdempotently(row: EventInsertRow): Promise<EventRow> {
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

  private async insertOutboxIdempotently(row: OutboxInsertRow): Promise<void> {
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


// 게이트웨이 결과 경로는 사람 행위자가 없다. 시스템 기본 맥락에서 출발하고
// 호출부가 실제 역할(검증자 등)을 덮어쓴다.
function gatewaySystemContext(): WorkflowContext {
  return {
    actorRole: "system",
    isOwner: false,
    isAssignee: false,
    isVerifier: false,
    hasOwnerTaskApproval: true,
    hasVerificationPass: false,
    hasCommanderCompletionDecision: false,
    hasOwnerFinalApproval: false,
    idempotencyKey: "gateway"
  };
}

// 소대장이 정리한 작업을 방장이 읽고 판단할 수 있는 형태로 보여준다.
// 내부 상태나 실행 로그는 넣지 않는다 (FR-005).
export function renderLeaderPlanMessage(plan: LeaderPlan): string {
  const assigneeLabel = plan.assignee === "both"
    ? "ClaudeBot + CodexBot"
    : plan.assignee === "claude_leader" ? "ClaudeBot" : "CodexBot";
  return [
    // 📥 접수 → 📋 제안 → ⚙️ 작업 중. 같은 자리에 같은 아이콘이 오면 방장이 흐름의
    // 어디쯤인지 문장을 읽지 않고도 안다.
    "📋 작업 제안입니다. 승인하시면 바로 시작합니다.",
    "",
    plan.title,
    "",
    "목적: " + plan.purpose,
    "범위: " + plan.scope,
    "완료 조건: " + plan.completionCriteria,
    "담당: " + assigneeLabel + (plan.reason ? " (" + plan.reason + ")" : "")
  ].join("\n");
}

// Telegram inline keyboard 의 callback_data 는 64바이트가 한계다.
// "proposal:<id>:approve" 로 실려 나가므로 id 는 40바이트 안쪽으로 유지한다.
export const MAX_TELEGRAM_CALLBACK_BYTES = 64;

export function shortProposalId(attemptId: string): string {
  const raw = attemptId.replace(LEADER_PLANNING_ATTEMPT_PREFIX, "").replace(/^planning_/, "");
  // uuid 의 앞 두 마디, 즉 64비트만 쓴다. 이 id 는 애초에 room 으로 스코프되지 않고
  // 시스템 전체에서 조회된다(entity_ref 조회에 room_id 필터가 없다). 20개 방을
  // 동시에 운영해도 생일 역설 기준 50% 충돌 확률에 도달하려면 대략 50억 건의
  // proposal 이 쌓여야 하므로, 방 개수가 늘어도 이 트렁케이션은 여전히 안전하다.
  const compact = raw.replace(/-/g, "").slice(0, 16);
  return "p_" + compact;
}

// 표시용 정리를 거치지 않은 원본 stdout. 소대장 판단 JSON 을 잃지 않으려면 필요하다.
export function rawStdoutFromGatewayEvents(events: readonly GatewayEvent[]): string {
  return events
    .filter((event): event is GatewayEvent & { type: "stdout"; text: string } => event.type === "stdout" && typeof event.text === "string")
    .map((event) => event.text)
    .join("\n");
}

// claude --output-format json 은 session_id 를 돌려준다. stdout 에서 건져낸다.
export function sessionIdFromGatewayEvents(events: readonly GatewayEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "stdout" || typeof event.text !== "string") continue;
    const match = event.text.match(/"session_id"\s*:\s*"([0-9a-fA-F-]{16,})"/);
    if (match) return match[1];
  }
  return undefined;
}

export function renderRevisionRequestText(taskId: string, requiredFixes: string, reverifyScope: string): string {
  return [
    "검증 결과 보완이 필요합니다.",
    "작업: " + taskId,
    "",
    "필수 수정:",
    maskSensitiveText(requiredFixes).slice(0, 1500),
    "",
    "재검증 범위: " + reverifyScope,
    "보완 후 다시 검증을 요청해 주세요."
  ].join("\n");
}

export function collectedArtifactsFromEvents(events: readonly GatewayEvent[]): ArtifactManifest[] {
  const byKey = new Map<string, ArtifactManifest>();
  for (const event of events) {
    if (event.type !== "artifact_collected") continue;
    const artifact = event.artifact;
    if (!artifact || typeof artifact.path !== "string" || typeof artifact.version !== "string") continue;
    byKey.set(`${artifact.uri ?? artifact.path}::${artifact.version}`, artifact);
  }
  return [...byKey.values()];
}

// 텔레그램 봇이 올릴 수 있는 최대 크기. 넘으면 API 가 거절한다.
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

// 방에 그대로 보낼 최대 길이. 이보다 길면 앞부분만 보내고 전문은 현황판에서 읽는다.
//
// 텔레그램은 3900자마다 잘라 여러 통으로 보내주지만, 그러면 감사 보고 하나가 화면 여러
// 장을 채우고 방의 다른 대화가 통째로 밀려난다. 방장이 폰에서 읽는다는 것을 전제로 잡은 값.
export const DEFAULT_ROOM_MESSAGE_PREVIEW_CHARS = 300;

// "전문 보기" 버튼. 현황판을 그 보고 화면으로 바로 연다.
//
// 딥링크 파라미터는 [A-Za-z0-9_-] 1-64자만 허용된다. report_id 는 표준 UUID(36자)라
// 그대로 실어도 한도 안이고, 방 id 를 같이 실을 필요가 없다 — 현황판이 그 id 로 방을
// 되찾아 멤버인지 확인한다.
export function buildReportOpenKeyboard(reportId: string, directLinkBaseUrl?: string): unknown {
  if (!directLinkBaseUrl) return undefined;
  const separator = directLinkBaseUrl.includes("?") ? "&" : "?";
  // r_ 접두어로 방 id 와 구분한다. 둘 다 UUID 라 값만 보고는 어느 쪽인지 알 수 없다.
  return {
    inline_keyboard: [[{ text: "전문 보기", url: `${directLinkBaseUrl}${separator}startapp=r_${encodeURIComponent(reportId)}` }]]
  };
}

export function roomMessagePreviewLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HUAI_ROOM_MESSAGE_PREVIEW_CHARS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_ROOM_MESSAGE_PREVIEW_CHARS;
}

// 문장·줄 단위로 자른다. 표나 코드블록 한가운데서 끊기면 방에 깨진 문서가 남는다.
export function previewRoomMessage(body: string, limit: number): { text: string; truncated: boolean } {
  const trimmed = body.trim();
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };

  const slice = trimmed.slice(0, limit);
  const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "), slice.lastIndexOf("다. "));
  const cut = boundary > limit * 0.5 ? boundary : limit;
  return { text: trimmed.slice(0, cut).trimEnd(), truncated: true };
}

// 방에 나갈 문장. 잘렸으면 전문이 얼마나 되는지 밝힌다 — 얼마를 못 보고 있는지 모르면
// 버튼을 누를 이유도 모른다.
export function buildRoomMessageWithPreview(body: string, limit: number): { text: string; truncated: boolean } {
  const preview = previewRoomMessage(body, limit);
  if (!preview.truncated) return preview;
  return { text: `${preview.text}

…(전문 ${body.trim().length.toLocaleString("ko-KR")}자)`, truncated: true };
}

// 방에 파일로 전달할 산출물인가.
//
// 웹 산출물은 배포해서 링크로 연다(게이트웨이가 이미 올린다). 소스 코드·설정은 결과물이
// 아니라 작업 그 자체라 방에 뿌리면 잡음이 된다 — 방장이 받아볼 문서만 고른다.
const DELIVERABLE_DOCUMENT_PATTERN = /\.(hwpx?|docx?|xlsx?|pptx?|pdf|csv|zip|png|jpe?g|mp4)$/i;

// 작업자가 스스로 테스트하며 남긴 부산물. 방장에게 보낼 결과물이 아니다.
//
// 라이브에서 달걀 게임 작업이 끝나자 방에 올라온 파일이 egg-game-broken.png 였다 —
// 헤드리스 브라우저로 확인하며 찍은 디버그 스크린샷이다. 결과물이라고 내밀 것이 아니다.
const WORKING_ARTIFACT_PATTERN = /(^|[\/])(\.[^\/]+|node_modules|dist|coverage)([\/]|$)|-(broken|debug|before|after|temp|tmp)\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i;

export function isDeliverableDocument(filePath: string): boolean {
  const path = filePath.split(/[?#]/)[0] ?? filePath;
  if (WORKING_ARTIFACT_PATTERN.test(path)) return false;
  return DELIVERABLE_DOCUMENT_PATTERN.test(path);
}

// 이 PC 안의 실제 경로. file:// URI 로 기록된 것을 되돌린다.
export function localArtifactPath(artifact: ArtifactManifest, request: ExecutionRequest): string | undefined {
  const uri = artifact.uri;
  if (!uri) return `${request.projectPath}/${artifact.path}`;
  if (!uri.startsWith("file:///")) return undefined;
  try {
    return decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
  } catch {
    return undefined;
  }
}

export function artifactUri(artifact: ArtifactManifest, request: ExecutionRequest): string {
  return safeTelegramTraceUri(artifact.uri ?? `${request.projectPath}/${artifact.path}`);
}

export function summarizeSupabaseSendResult(result: TelegramSendResult): Record<string, unknown> {
  return { telegramMessageId: result.telegramMessageId };
}

export function buildSupabaseOutboxStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseOutboxStore {
  return new SupabaseOutboxStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY")
  });
}

class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: SupabaseRuntimeConfig) {
    this.baseUrl = input.url.replace(/\/+$/, "");
    this.serviceRoleKey = input.serviceRoleKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async rpc<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rpc/${name}`, { body }).then((response) => response.json<T>());
  }

  async request(method: string, path: string, options: { body?: unknown; prefer?: string } = {}): Promise<SupabaseRestResponse> {
    // 게이트웨이 결과 기록도 루프 안에서 돈다. 끊기지 않으면 다음 결과가 못 들어온다.
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      signal: AbortSignal.timeout(20_000),
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
      throw new Error(`supabase-rest-error:${this.response.status}:${maskSensitiveText(await safeResponseText(this.response))}`);
    }
  }

  async json<T>(): Promise<T> {
    await this.expectOk();
    if (this.response.status === 204) return undefined as T;
    return (await this.response.json()) as T;
  }
}

type OutboxRow = {
  outbox_id?: string;
  huai_outbox_id?: string;
  idempotency_key: string;
  target: string | OutboxTarget;
  payload: Record<string, unknown>;
  status: OutboxRecord["status"];
  attempts: number;
};

type EventRow = {
  event_id: string;
  room_id: string;
  task_id?: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

type EventInsertRow = {
  room_id: string;
  task_id: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
};

type OutboxInsertRow = {
  event_id: string;
  idempotency_key: string;
  target_kind: "telegram_bot" | "local_gateway";
  target: string;
  payload: Record<string, unknown>;
  // huai_outbox.room_id 는 nullable FK 다(20260815140000 마이그레이션). lease_huai_outbox
  // 가 방별 공평 리스를 위해 이 값으로 그룹핑하므로, roomId 를 아는 호출부는 반드시
  // 채워야 한다 — 안 채우면 그 행이 "room 없음" 공유 버킷으로 떨어져 공평 리스 대상에서
  // 사실상 빠진다. 옵셔널로 남긴 이유는 이벤트 없이 발생하는 outbox 행처럼 roomId 를
  // 구조적으로 모르는 호출부가 생길 가능성을 막지 않기 위해서다(지금은 전부 채운다).
  room_id?: string | null;
};

function executionRequestFromOutbox(row: OutboxRecord): ExecutionRequest | undefined {
  const value = row.payload.executionRequest ?? row.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ExecutionRequest;
}

function isDependencySatisfiedStatus(status: string): boolean {
  return status === "completed" || status === "commander_completion_pending" || status === "completion_approval_pending";
}

function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  const outboxId = row.outbox_id ?? row.huai_outbox_id;
  if (!outboxId) throw new Error("missing-outbox-id");
  return {
    outboxId,
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

function stripUndefined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function safeResponseText(response: Response): Promise<string> {
  return response.text().catch(() => "unreadable-response");
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}




function summarizeGatewayEvents(events: GatewayEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    if (event.type === "stdout" || event.type === "stderr") {
      return { type: event.type, text: truncate(maskSensitiveText(event.text), 2000) };
    }
    if (event.type === "failed") {
      return { ...event, errorKind: maskSensitiveText(event.errorKind) };
    }
    return event;
  });
}

// \uC138\uC158 \uAE30\uB85D\uC6A9 \uD30C\uC77C. \uC791\uC5C5\uC790\uAC00 \uB9CC\uB4E0 \uC0B0\uCD9C\uBB3C\uC774 \uC544\uB2C8\uB77C Claude Code \uD6C5\uC774 \uC790\uAE30 \uC138\uC158\uC744
// \uB0A8\uAE30\uBA74\uC11C \uC0DD\uAE30\uB294 \uBD80\uC0B0\uBB3C\uC774\uB77C, \uC774\uAC78 \uC0B0\uCD9C\uBB3C\uB85C \uC138\uBA74 "\uBA87 \uC904\uC778\uC9C0 \uC870\uC0AC\uD574\uC918" \uAC19\uC740 \uC21C\uC218
// \uC9C8\uC758\uC751\uB2F5\uB3C4 \uD30C\uC77C\uC744 \uBC14\uAFBC \uAC83\uCC98\uB7FC \uBCF4\uC778\uB2E4(\uB77C\uC774\uBE0C\uC5D0\uC11C README \uC904 \uC218 \uC870\uC0AC\uC5D0 3\uAC74 \uC7A1\uD614\uB2E4).
const BOOKKEEPING_ARTIFACT_PATTERN = /(^|[\\/])sessions([\\/]|$)/i;

// 폴백은 한 번만 한다. 붙였던 실행이 또 한도에 걸리면 그대로 실패로 보고한다 —
// 두 엔진이 다 막힌 상태에서 계속 넘기면 방만 시끄럽고 아무것도 안 된다.
export const FALLBACK_ATTEMPT_SUFFIX = "-fallback";

// 막힌 엔진 다음으로 넘길 엔진을 고른다.
//
// 엔진이 셋(claude_code · codex · antigravity)이므로, 감사가 막혔을 때도 작업자와 다른
// 엔진이 하나 더 남는다. 둘뿐이던 때는 Codex 가 막히면 Claude 가 자기 일을 검사할 수밖에
// 없었다 — 그건 독립 검증이 아니다.
//
// workerAdapterType 은 그 작업을 실제로 한 엔진이다(감사일 때만 의미가 있다).
// 그 엔진은 뒤로 미뤄, 남는 게 그것뿐일 때만 쓴다.
export function nextEngineAfter(
  blocked: AiAdapterType,
  workerAdapterType?: AiAdapterType
): AiAdapterType {
  const candidates = AI_ADAPTER_TYPES.filter((engine) => engine !== blocked);
  const independent = candidates.filter((engine) => engine !== workerAdapterType);
  return independent[0] ?? candidates[0] ?? blocked;
}

// 방에 올리는 이름. 사람은 adapterType 을 읽지 않는다.
// 어느 봇 이름으로 방에 보고할지. 실제로 일한 엔진과 맞아야 한다.
export function reportBotRoleForAdapter(adapterType: AiAdapterType): "claude_leader" | "codex_leader" {
  // antigravity 는 아직 자기 봇이 없다. 방에 나가는 문구는 engineActorName 이 정확히
  // 밝히므로(AntigravityBot), 발신 봇만 claude_leader 를 빌려 쓴다.
  return adapterType === "codex" ? "codex_leader" : "claude_leader";
}

export function engineActorName(adapterType: AiAdapterType): string {
  if (adapterType === "codex") return "CodexBot";
  if (adapterType === "antigravity") return "AntigravityBot";
  return "ClaudeBot";
}

export function shouldFallbackToOtherEngine(
  request: ExecutionRequest,
  errorKind: string | undefined,
  resultSummary: string
): boolean {
  if (request.attemptId.endsWith(FALLBACK_ATTEMPT_SUFFIX)) return false;
  // 소대장 판단은 방장 지시를 해석하는 단계라 엔진을 바꾸면 결과가 달라진다.
  // 여기서 넘기지 않고 실패를 그대로 보고해, 방장이 다시 말하게 한다.
  if (isLeaderPlanningAttempt(request.attemptId)) return false;

  const combined = `${errorKind ?? ""}\n${resultSummary}`;
  return /agent-usage-limit|chatgpt\.com\/codex\/settings|hit your (?:session |usage |weekly )?limit|usage limit|session limit|weekly limit|quota exceeded|limit reached/i.test(combined);
}

export function producedRealArtifacts(events: readonly GatewayEvent[]): boolean {
  return realArtifactPaths(events).length > 0;
}

export function realArtifactPaths(events: readonly GatewayEvent[]): string[] {
  return collectedArtifactsFromEvents(events)
    .map((artifact) => String(artifact.path ?? artifact.uri ?? ""))
    .filter((location) => location.length > 0 && !BOOKKEEPING_ARTIFACT_PATTERN.test(location));
}

// \uBB34\uC5C7\uC744 \uC790\uB3D9 \uAC10\uC0AC\uD560\uC9C0 \uC815\uD55C\uB2E4.
//
// \uAC80\uC99D\uC740 "\uBC14\uB010 \uAC83"\uC744 \uBCF4\uB294 \uC77C\uC774\uB2E4. \uADF8\uB798\uC11C \uAE30\uC900\uC740 \uC774 \uC2E4\uD589\uC774 \uC2E4\uC81C\uB85C \uBB34\uC5B8\uAC00\uB97C \uB9CC\uB4E4\uAC70\uB098
// \uACE0\uCCE4\uB294\uAC00 \uD558\uB098\uB2E4. \uD30C\uC77C\uC744 \uAC74\uB4DC\uB9AC\uC9C0 \uC54A\uC740 \uC9C8\uC758\uC751\uB2F5("\uC904 \uC218 \uC54C\uB824\uC918")\uC740 \uB3C5\uB9BD \uAC10\uC0AC\uB97C
// \uBD99\uC77C \uB300\uC0C1\uC774 \uC5C6\uC73C\uBBC0\uB85C \uAC74\uB108\uB6F4\uB2E4 \u2014 \uAC10\uC0AC \uD55C \uBC88\uC774 AI \uC2E4\uD589 \uD55C \uBC88\uC774\uB77C \uADF8\uB0E5 \uBE44\uC6A9\uC774\uB2E4.
//
// \uC608\uC804\uC5D0\uB294 \uD504\uB86C\uD504\uD2B8\uC640 \uACB0\uACFC \uBB38\uC790\uC5F4\uC744 \uB2E8\uC5B4\uD45C(\uAC80\uC99D\u00B7\uAC10\uC0AC\u00B7\uBCF4\uC548\u00B7\uAD6C\uD604 \uC644\uB8CC\u00B7\uD14C\uC2A4\uD2B8 \uD1B5\uACFC\u00B7
// supabase\u00B7migration \u2026)\uC5D0 \uB123\uC5B4 \uD310\uC815\uD588\uB2E4. \uC694\uCCAD\uC790\uAC00 \uBB34\uC2A8 \uB2E8\uC5B4\uB97C \uACE8\uB790\uB294\uC9C0\uB85C \uAC10\uC0AC \uC5EC\uBD80\uAC00
// \uAC08\uB9AC\uB294 \uAC74 \uADFC\uAC70\uAC00 \uC5C6\uB2E4 \u2014 "supabase"\uB97C \uC5B8\uAE09\uD558\uBA74 \uAC10\uC0AC\uD558\uACE0 \uAC19\uC740 \uBCC0\uACBD\uC744 \uB2E4\uB978 \uB9D0\uB85C
// \uC124\uBA85\uD558\uBA74 \uC548 \uD558\uB294 \uC2DD\uC774\uC5C8\uB2E4. \uC624\uB298 \uAC19\uC740 \uAD6C\uC870\uC758 \uB2E8\uC5B4\uD45C\uAC00 \uC81C\uBAA9\uACFC \uBCF4\uACE0 \uBCF8\uBB38\uC5D0\uC11C \uAC01\uAC01
// \uB2F5\uC744 \uC9C0\uC6B4 \uAC83\uC744 \uC7A1\uC558\uACE0, \uC5EC\uAE30\uB3C4 \uAC19\uC740 \uAC83\uC774\uB2E4.
function shouldRunAutomaticAudit(request: ExecutionRequest, events: readonly GatewayEvent[]): boolean {
  if (process.env.HUAI_AUTO_AUDIT_ENABLED !== "true") return false;
  // \uAC10\uC0AC \uACB0\uACFC\uB97C \uB2E4\uC2DC \uAC10\uC0AC\uD558\uBA74 \uB05D\uB098\uC9C0 \uC54A\uB294\uB2E4.
  if (request.reportBotRole === "auditor") return false;
  // \uB2E4\uC911 AI \uC2E4\uD589\uC740 enqueueMultiAiAuditIfReady \uAC00 \uB450 \uACB0\uACFC\uB97C \uBAA8\uC544 \uD55C \uBC88\uC5D0 \uAC10\uC0AC\uD55C\uB2E4.
  if (multiAiAttemptGroup(request.attemptId)) return false;
  return producedRealArtifacts(events);
}

export function buildSingleWorkerAuditPrompt(taskId: string, actor: string, resultSummary: string, artifactPaths: readonly string[]): string {
  return [
    "HuAI Collab Chatroom System\uC758 \uC791\uC5C5 \uACB0\uACFC\uB97C \uB3C5\uB9BD \uAC10\uC0AC\uD558\uC138\uC694.",
    "\uB300\uC0C1 \uC791\uC5C5: " + taskId,
    "\uC791\uC5C5\uC790: " + actor,
    "\uD310\uC815 \uAE30\uC900: \uACB0\uACFC\uC758 \uC815\uD655\uC131, \uC644\uB8CC \uC870\uAC74 \uCDA9\uC871 \uC5EC\uBD80, \uB204\uB77D\uB41C \uC2E4\uD589 \uC870\uCE58, \uC0AC\uC6A9\uC790\uC5D0\uAC8C \uD544\uC694\uD55C \uB2E4\uC74C \uC120\uD0DD\uC9C0.",
    "\uBCF4\uACE0: \uC0AC\uB78C\uC774 \uC54C\uC544\uC57C \uD560 \uACB0\uB860\uACFC \uD544\uC694\uD55C \uC870\uCE58\uB9CC \uAC04\uACB0\uD558\uAC8C \uC791\uC131\uD558\uC138\uC694.",
    "\uAE08\uC9C0: \uB0B4\uBD80 JSON, hook log, stack trace, token, API key, \uC6D0\uBB38 \uC2DC\uD06C\uB9BF \uCD9C\uB825.",
    "",
    "\uC791\uC5C5\uC790 \uBCF4\uACE0:",
    resultSummary || "(\uBCF4\uACE0 \uC5C6\uC74C)",
    "",
    "\uBCC0\uACBD\uB41C \uC0B0\uCD9C\uBB3C:",
    ...(artifactPaths.length > 0 ? artifactPaths.map((path) => "- " + path) : ["(\uC5C6\uC74C)"])
  ].join("\n");
}

function multiAiAttemptGroup(attemptId: string): { baseAttemptId: string; role: "claude" | "codex" } | undefined {
  if (attemptId.endsWith("-claude")) return { baseAttemptId: attemptId.slice(0, -"-claude".length), role: "claude" };
  if (attemptId.endsWith("-codex")) return { baseAttemptId: attemptId.slice(0, -"-codex".length), role: "codex" };
  return undefined;
}

function isCompletedMultiAiSibling(payload: Record<string, unknown>, taskId: string, baseAttemptId: string): boolean {
  return payload.taskId === taskId && payload.status === "completed" && (payload.attemptId === baseAttemptId + "-claude" || payload.attemptId === baseAttemptId + "-codex");
}

function buildMultiAiAuditPrompt(taskId: string, claudePayload: Record<string, unknown>, codexPayload: Record<string, unknown>): string {
  return [
    "HuAI Collab Chatroom System의 다중 AI 협의 결과를 독립 감사하세요.",
    "대상 작업: " + taskId,
    "판정 기준: 두 작업자 결과의 정확성, 상호 일치성, 누락된 실행 조치, 사용자에게 필요한 다음 선택지.",
    "보고: 사람이 알아야 할 결론과 필요한 조치만 간결하게 작성하세요.",
    "금지: 내부 JSON, hook log, stack trace, token, API key, 원문 시크릿 출력.",
    "",
    "ClaudeBot 결과:",
    summarizePersistedGatewayPayload(claudePayload),
    "",
    "CodexBot 결과:",
    summarizePersistedGatewayPayload(codexPayload)
  ].join("\n");
}

function summarizePersistedGatewayPayload(payload: Record<string, unknown>): string {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const stdoutTexts = events
    .filter((event) => event && typeof event === "object" && (event as { type?: unknown }).type === "stdout")
    .map((event) => String((event as { text?: unknown }).text ?? ""));
  const otherTexts = events
    .filter((event) => event && typeof event === "object" && (event as { type?: unknown }).type !== "stderr")
    .map((event) => String((event as { text?: unknown }).text ?? ""));
  const texts = (stdoutTexts.length > 0 ? stdoutTexts : otherTexts)
    .map((text) => extractCodexAgentMessage(text) ?? text)
    .map((text) => cleanHumanVisibleOutput(text) ?? "")
    .filter(Boolean);
  return truncate(texts.at(-1) ?? String(payload.errorKind ?? payload.status ?? "결과 요약 없음"), 3200);
}
// 감사가 판정을 내놓지 못한 것을 알아본다.
//
// 종료코드는 0 이어도 실제로는 아무것도 안 본 실행이 있다. CLI 가 권한 때문에 도구를 하나도
// 못 쓴 경우가 그렇고, 그때 남는 것은 "출력 없음" 이라는 안내문뿐이다. 이걸 판정으로 받으면
// inferVerificationVerdict 가 기본값 conditional_pass 를 매겨 근거 없는 보완 요구가 나간다.
export function auditProducedNoVerdict(resultSummary: string): boolean {
  const text = resultSummary.trim();
  if (text.length === 0) return true;
  return /no output produced|auto-denied|cannot prompt for/i.test(text);
}

function inferVerificationVerdict(summary: string): "pass" | "conditional_pass" | "fail" {
  const lower = summary.toLowerCase();
  if (/실패|불합격|문제 있음|보완 필요|수정 필요|fail|failed|reject/.test(lower)) return "fail";
  if (/조건부|일부|주의|conditional/.test(lower)) return "conditional_pass";
  if (/통과|승인|문제 없음|완료|pass|passed|ok/.test(lower)) return "pass";
  return "conditional_pass";
}

// renderAutomaticAuditRequestText \uB294 \uC81C\uAC70\uD588\uB2E4. \uBC29\uC7A5\uC5D0\uAC8C "\uAC80\uC99D\uD574 \uB4DC\uB9B4\uAE4C\uC694"\uB97C \uBB3B\uACE0
// \uBC84\uD2BC\uC744 \uBD99\uC774\uB358 \uBA54\uC2DC\uC9C0\uC778\uB370, \uC774\uC81C \uD30C\uC77C\uC744 \uBC14\uAFBC \uC791\uC5C5\uC740 \uBB3B\uC9C0 \uC54A\uACE0 \uBC14\uB85C \uAC10\uC0AC\uAC00 \uB3C8\uB2E4.
// \uB0A8\uACA8\uB450\uBA74 \uB2E4\uC74C \uC0AC\uB78C\uC774 \uB2E4\uC2DC \uBD99\uC5EC \uACB0\uC815 \uCC3D\uAD6C\uAC00 \uBC29\uACFC \uC791\uC5C5\uD310\uC73C\uB85C \uAC08\uB77C\uC9C4\uB2E4.

export function renderGatewayReportText(input: {
  request: ExecutionRequest;
  status: "completed" | "failed" | "rejected";
  events: GatewayEvent[];
  errorKind?: string;
}): string {
  // \uAC10\uC0AC\uB294 \uC791\uC5C5\uC774 \uC544\uB2C8\uB2E4. \uB458\uC744 \uAC19\uC740 \uBB38\uAD6C\uB85C \uBCF4\uACE0\uD558\uBA74 \uAC10\uC0AC\uAC00 \uC2E4\uD328\uD588\uC744 \uB54C \uBC29\uC7A5\uC774 \uC791\uC5C5\uC774
  // \uC2E4\uD328\uD55C \uC904 \uC548\uB2E4 \u2014 \uB77C\uC774\uBE0C\uC5D0\uC11C \uC2E4\uC81C\uB85C \uADF8\uB807\uAC8C \uC77D\uD614\uB2E4(\uC791\uC5C5\uC740 \uC131\uACF5, \uAC10\uC0AC\uB9CC \uD55C\uB3C4\uB85C \uC8FD\uC74C).
  const isAudit = input.request.reportBotRole === "auditor";
  const subject = isAudit ? "\uAC10\uC0AC \uC2E4\uD589" : "\uC791\uC5C5 \uC2E4\uD589";

  if (input.status === "completed") {
    const summary = summarizeGatewayOutput(input.events);
    const lines = summary
      ? [subject + " \uC644\uB8CC", "\uACB0\uACFC:", summary]
      : [subject + " \uC644\uB8CC."];
    const collectionFailure = input.events.find(
      (event): event is Extract<GatewayEvent, { type: "artifact_collection_failed" }> =>
        event.type === "artifact_collection_failed"
    );
    if (collectionFailure) {
      lines.push("\uC8FC\uC758: \uC0B0\uCD9C\uBB3C \uC218\uC9D1\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC791\uC5C5 \uACB0\uACFC\uB294 \uC815\uC0C1\uC774\uC9C0\uB9CC \uC0B0\uCD9C\uBB3C \uC774\uB825\uC774 \uB0A8\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    }
    return lines.join("\n");
  }

  const outputSummary = summarizeGatewayOutput(input.events);
  const reason = humanReadableGatewayError(input.errorKind ?? outputSummary ?? "failed", gatewayFailureEvidence(input.events) || outputSummary, input.request.adapterType);
  return [
    subject + " \uC2E4\uD328",
    "\uC6D0\uC778: " + reason,
    isAudit
      // \uAC10\uC0AC\uAC00 \uC8FD\uC5C8\uC5B4\uB3C4 \uC791\uC5C5 \uACB0\uACFC\uB294 \uADF8\uB300\uB85C \uC788\uB2E4. \uBC29\uC7A5\uC774 \uBB34\uC5C7\uC744 \uC783\uC5C8\uB294\uC9C0 \uC54C\uC544\uC57C \uC2B9\uC778 \uC5EC\uBD80\uB97C
      // \uD310\uB2E8\uD560 \uC218 \uC788\uB2E4 \u2014 \uC783\uC740 \uAC83\uC740 \uC791\uC5C5\uC774 \uC544\uB2C8\uB77C \uB3C5\uB9BD \uAC80\uC99D\uC774\uB2E4.
      ? "\uC791\uC5C5 \uACB0\uACFC \uC790\uCCB4\uB294 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4. \uAC80\uC99D \uC5C6\uC774 \uC2B9\uC778\uD560\uC9C0, \uB2E4\uC2DC \uAC80\uC99D\uD560\uC9C0 \uC815\uD574 \uC8FC\uC138\uC694."
      : "\uD544\uC694\uD558\uBA74 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uC791\uC5C5\uC790 \uBCF4\uC644\uC744 \uC694\uCCAD\uD574 \uC8FC\uC138\uC694."
  ].join("\n");
}
// 실패를 판정할 때 쓰는 원본 출력. 사람이 읽을 문장으로 정제하기 전의 것이다.
//
// CLI 가 한도·인증 같은 사정을 알리는 자리는 사람이 읽을 문장이 아니라 JSON 줄인 경우가
// 많다. 정제본은 그 줄을 버리므로, 무엇이 왜 실패했는지 기계가 판정할 때는 여기를 본다.
export function gatewayFailureEvidence(events: readonly GatewayEvent[]): string {
  return events
    .map((event) => {
      if ((event.type === "stdout" || event.type === "stderr") && "text" in event) return event.text;
      if (event.type === "failed" && "errorKind" in event) return event.errorKind;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeGatewayOutput(events: GatewayEvent[]): string | undefined {
  const stdout = [...events].reverse().find((event): event is GatewayEvent & { type: "stdout"; text: string } =>
    event.type === "stdout" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const stderr = [...events].reverse().find((event): event is GatewayEvent & { type: "stderr"; text: string } =>
    event.type === "stderr" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const text = stdout?.text ?? stderr?.text;
  if (!text) return undefined;
  const agentMessage = extractCodexAgentMessage(text);
  const visible = cleanHumanVisibleOutput(agentMessage ?? text);
  return visible ? maskSensitiveText(visible) : undefined;
}

function cleanHumanVisibleOutput(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isInternalOutputLine(line))
    .filter((line) => !isLowValueHumanLine(line));
  const summarized = compactHumanVisibleLines(lines);
  return summarized || undefined;
}

// 사람이 볼 본문을 만든다. 내부 잡음(isInternalOutputLine·isLowValueHumanLine)은 이미
// 걸러진 뒤라, 여기 남은 줄은 전부 작업자가 사람에게 하려던 말이다.
//
// 예전에는 "결론·판정·조치·완료" 같은 단어표로 중요한 줄을 골라내고 나머지를 버렸다.
// 그게 정확히 답을 지웠다 — 라이브에서 ClaudeBot 이
//   README.md 줄 수: **86줄**
//   근거: `wc -l README.md` 실행 결과 `86 README.md`.
//   후속 조치: 불필요. 단순 조사 요청이라 완료.
// 를 냈는데, 방에는 마지막 줄만 갔다("조치"·"완료"가 표에 있어서다). 답에는 그런
// 관료적 단어가 안 들어가므로 단어표는 답을 골라내는 게 아니라 답을 떨어뜨린다.
//
// 그래서 고르지 않는다. 작업자가 쓴 순서 그대로 두고 길이로만 자른다 — 답은 보통
// 맨 앞에 오므로, 잘리더라도 사라지는 건 꼬리지 답이 아니다.
// 보고가 잘리는 지점.
//
// 예전 값 3200 은 "한 메시지에 담자"로 정한 것인데, 전송 쪽에는 이미 분할이 있다
// (apps/bot-service/src/outbox.ts splitTelegramText, 3900자마다 쪼개 여러 메시지로
// 보낸다). 그래서 3200 은 Telegram 의 한계가 아니라 우리가 스스로 버린 양이었다 —
// 방장이 긴 보고를 받으면 뒷부분이 사라졌다.
//
// 완전히 풀지는 않는다. 작업자가 로그를 통째로 뱉으면 방이 그걸로 덮인다. 세 메시지쯤
// 되는 12000자를 상한으로 두고, 넘으면 잘렸다는 사실을 문장으로 알린다 — "..." 만
// 붙으면 뒤에 뭐가 더 있었는지 방장이 알 수 없다.
const HUMAN_VISIBLE_MAX_LENGTH = 12000;

function compactHumanVisibleLines(lines: string[]): string {
  const joined = lines.join("\n").trim();
  if (joined.length <= HUMAN_VISIBLE_MAX_LENGTH) return joined;
  const kept = joined.slice(0, HUMAN_VISIBLE_MAX_LENGTH).trimEnd();
  return `${kept}\n\n(보고가 길어 여기까지만 표시했습니다. 전체는 /trace 로 확인해 주세요.)`;
}

// \uC0AC\uB78C\uC5D0\uAC8C \uBCF4\uC77C \uAC12\uC774 \uC5C6\uB294 \uC904\uB9CC \uAC78\uB7EC\uB0B8\uB2E4.
//
// \uC5EC\uAE30 \uC788\uB358 \uADDC\uCE59 \uB300\uBD80\uBD84\uC774 \uB2F5\uC744 \uC9C0\uC6B0\uACE0 \uC788\uC5C8\uB2E4. \uB3C5\uB9BD \uAC80\uC99D(Codex)\uC774 \uC9DA\uC740 \uADF8\uB300\uB85C\uB2E4:
//   /^\|/          \uD45C \uD55C \uC904\uC529 \u2014 \uBE44\uAD50 \uACB0\uACFC\uB294 \uD45C\uB85C \uC624\uB294 \uACBD\uC6B0\uAC00 \uB9CE\uB2E4. \uB2F5\uC774 \uD1B5\uC9F8\uB85C \uC0AC\uB77C\uC9C4\uB2E4
//   /^#{1,6}\s/    \uC81C\uBAA9 \u2014 "## \uACB0\uB860" \uAC19\uC740 \uC904\uC774 \uC5C6\uC5B4\uC838 \uBCF8\uBB38 \uAD6C\uC870\uAC00 \uBB34\uB108\uC9C4\uB2E4
//   /^[A-Z_]+:/    \uB300\uBB38\uC790 \uC811\uB450\uC5B4 \u2014 DEBUG/INFO \uB958\uB294 isInternalOutputLine \uC774 \uC774\uBBF8 \uC7A1\uB294\uB2E4.
//                  \uC5EC\uAE30 \uB0A8\uC73C\uBA74 "API:", "SQL:" \uAC19\uC740 \uC815\uC0C1 \uB2F5\uAE4C\uC9C0 \uC9C0\uC6B4\uB2E4
//   \uD83D\uDCC1 \uD83D\uDCC4          \uC774 \uD504\uB85C\uC81D\uD2B8\uAC00 \uD30C\uC77C \uACBD\uB85C\uB97C \uD45C\uAE30\uD558\uB77C\uACE0 \uC815\uD574\uB454 \uAE30\uD638\uB2E4. \uADF8 \uC904\uC774 \uACE7 \uB2F5\uC774\uB2E4
//   "\uC624\uCC28 \uBC94\uC704" \uB4F1  \uCE21\uC815 \uACB0\uACFC\uB97C \uB9D0\uD558\uB294 \uC815\uC0C1 \uBB38\uC7A5\uACFC \uAD6C\uBD84\uB418\uC9C0 \uC54A\uB294\uB2E4
//
// \uC624\uB298 \uAC19\uC740 \uC885\uB958\uC758 \uD544\uD130\uAC00 \uC138 \uBC88 \uB2F5\uC744 \uC9C0\uC6E0\uB2E4(\uC911\uC694 \uB2E8\uC5B4\uD45C, \uD655\uC7A5\uC790 \uBAA9\uB85D, \uADF8\uB9AC\uACE0 \uC774\uAC83).
// \uAD6C\uC870\uC801 \uC7A1\uC74C(JSON\u00B7\uB85C\uADF8\u00B7\uC2A4\uD0DD\uD504\uB808\uC784\u00B7\uD6C5)\uC740 isInternalOutputLine \uC774 \uC774\uBBF8 \uAC77\uC5B4\uB0B8\uB2E4.
// \uC5EC\uAE30 \uB0A8\uAE38 \uAC83\uC740 \uADF8\uAC83\uC73C\uB85C\uB3C4 \uC548 \uAC78\uB9AC\uB294, \uAC12\uC774 \uD655\uC2E4\uD788 \uC5C6\uB294 \uB450 \uAC00\uC9C0\uBFD0\uC774\uB2E4.
function isLowValueHumanLine(line: string): boolean {
  return (
    // \uB0B4\uC6A9 \uC5C6\uB294 \uBAA9\uB85D \uAE30\uD638 \uD55C \uAE00\uC790
    /^[-*]\s*$/.test(line) ||
    // \uC904 \uC804\uCCB4\uAC00 \uACBD\uB85C\uBFD0 \u2014 \uD30C\uC77C \uB098\uC5F4, \uBE4C\uB4DC \uC0B0\uCD9C\uBB3C \uB364\uD504
    isBarePathLine(line)
  );
}

// 줄 전체가 경로 하나인 것만 잡는다 — 파일 목록, 빌드 산출물 나열 같은 것들이다.
//
// 예전에는 /node_modules|dist\/|\.json|\.ts|\.js/ 로 "그 문자열이 어디든 들어 있으면"
// 버렸다. 그래서 답이 파일 이름을 언급하는 순간 통째로 사라졌다 — 라이브에서
// ClaudeBot 이 낸
//   조사 결과: `package.json` name 필드 값 = `"hu-ai-chatroom-system"`.
//   근거: `C:\Dev\HuAIChatroomSystem\package.json` 2번째 줄 직접 읽음.
// 두 줄이 `.json` 때문에 버려지고 방에는 "결과:" 만 갔다. 소프트웨어 작업에서
// 답이 파일 이름을 말하는 건 정상이고, 오히려 그게 답의 핵심인 경우가 많다.
//
// 문장 안에 파일 이름이 나오는 것과 줄이 경로 그 자체인 것을 가르는 기준은 공백이다.
// 스택프레임·JSON·로그 줄은 여기가 아니라 isInternalOutputLine 이 이미 걸러낸다.
function isBarePathLine(line: string): boolean {
  return /^[^\s]+$/.test(line) && /[\\/]/.test(line);
}
function isInternalOutputLine(line: string): boolean {
  return (
    /^```/.test(line) ||
    line.startsWith("{") ||
    line.startsWith("[") ||
    /^[}\]],?$/.test(line) ||
    /^"[^"\r\n]+"\s*:/.test(line) ||
    /^at\s+\S+\s+\(.+?:\d+:\d+\)$/i.test(line) ||
    /^(?:\d{4}-\d{2}-\d{2}[T\s]\S+\s+)?(?:DEBUG|INFO|WARN|ERROR|TRACE)\b/i.test(line) ||
    /^(?:stdout|stderr|stack|trace|payload|rawOutput)\s*[:=]/i.test(line) ||
    /^Session(Start|End) hook/i.test(line) ||
    /^Hook\s/i.test(line) ||
    /^\[DEBUG\]/i.test(line) ||
    /^\[INFO\]/i.test(line) ||
    /^Skill descriptions were shortened/i.test(line) ||
    /^clamping SessionEnd hook timeout/i.test(line) ||
    /^Assertion failed:/i.test(line) ||
    /^Node\.js v/i.test(line) ||
    /^EXECUTION\s+(COMPLETED|FAILED|REJECTED)\s*:?$/i.test(line) ||
    /^(OUTPUT|ERROR|STDOUT|STDERR)\s*:?$/i.test(line)
  );
}
function humanReadableGatewayError(error: string, outputSummary?: string, adapterType = "codex"): string {
  const masked = maskSensitiveText(error);
  const combined = masked + (outputSummary ? "\n" + outputSummary : "");
  if (adapterType === "claude_code" && /agent-usage-limit|hit your (?:session |usage |weekly )?limit|usage limit|session limit|weekly limit|rate limit|limit reached|resets?\s+(?:at\s+)?\d/i.test(combined)) {
    return "ClaudeBot 현재 상태: 사용 한도 초과. Claude Code 한도가 초기화된 뒤 다시 시도하거나 CodexBot으로 작업해야 합니다.";
  }
  // Codex 한도도 사람 말로 옮긴다.
  //
  // 한도 초과는 exit code 1 로 끝나므로 아래 exit-code 분기에 걸려 "실행 중 오류가
  // 발생했습니다" 로만 나갔다. 라이브에서 감사가 그렇게 실패했고, 방에서는 우리 코드가
  // 잘못된 것처럼 보였다. 한도는 기다리면 풀리고 오류는 고쳐야 하므로 조치가 완전히
  // 다르다 — 그 둘을 같은 문장으로 덮으면 안 된다.
  //
  // ClaudeBot 쪽은 이미 이렇게 옮기고 있었다. Codex 쪽만 빠져 있었다.
  if (adapterType === "codex" && /chatgpt\.com\/codex\/settings|agent-usage-limit|hit your (?:session |usage |weekly )?limit|usage limit|quota exceeded/i.test(combined)) {
    return "CodexBot 현재 상태: 사용 한도 초과. 한도가 초기화된 뒤 다시 시도하거나 ClaudeBot으로 작업해야 합니다.";
  }
  if (/BUTTON_DATA_INVALID/i.test(masked)) return "텔레그램 버튼 데이터가 너무 길어 전송이 실패했습니다.";
  if (/process-timeout/i.test(masked)) return "작업 시간이 초과되었습니다.";
  if (/spawn .*ENOENT/i.test(masked)) return "실행 프로그램을 찾지 못했습니다.";
  if (/agent-tool-error|codex_core::tools::router|An empty pipe element|timeout_ms must be at least 10000/i.test(combined)) {
    return "CodexBot 내부 명령 실행이 실패해 결과를 확정하지 못했습니다. 작업 범위를 좁혀 다시 시도해 주세요.";
  }
  if (/agent-write-blocked|read-only sandbox|workspace is read-only|writing is blocked|patch rejected/i.test(combined)) {
    return "작업자가 승인된 폴더에 쓰지 못했습니다. 로컬 게이트웨이 권한과 프로젝트 폴더 연결을 확인해 주세요.";
  }
  if (/exit-code-\d+/i.test(masked)) return "실행 중 오류가 발생했습니다.";
  return "실행 중 내부 오류가 발생했습니다. 상세 로그는 운영 기록에서 확인해 주세요.";
}
function extractCodexAgentMessage(text: string): string | undefined {
  let latest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: unknown }; text?: unknown };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        latest = parsed.item.text;
      } else if (parsed.type === "agent_message" && typeof parsed.text === "string") {
        latest = parsed.text;
      }
    } catch {
      continue;
    }
  }
  return latest;
}
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength) + "...";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireSingle<T>(rows: T[], error: string): T {
  if (rows.length !== 1) throw new Error(error);
  return rows[0] as T;
}







