import { maskTelegramSensitiveText as maskSensitiveText, safeTelegramTraceUri } from "../../telegram-ui/src/sanitize.js";
import {
  type ArtifactManifest,
  type ExecutionRequest,
  type GatewayEvent,
  type OutboxRecord,
  type OutboxTarget,
  type TelegramSendResult
} from "../../contracts/src/index.js";
import { buildCompletionKeyboard, buildProposalKeyboard } from "../../telegram-ui/src/index.js";
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
};

export class SupabaseOutboxStore {
  private readonly client: SupabaseRestClient;

  constructor(config: SupabaseRuntimeConfig) {
    this.client = new SupabaseRestClient(config);
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
    const text = renderGatewayReportText(input);
    const idempotencyKey = "telegram-report:" + input.request.attemptId + ":" + input.status;

    await this.insertOutboxIdempotently({
      event_id: event.event_id,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole, telegramChatId }),
      payload: {
        botRole,
        telegramChatId,
        text,
        binding: { kind: "event", eventId: event.event_id },
        idempotencyKey
      },
      room_id: input.request.roomId
    });

    // 실행 결과를 상태기계에 반영한다.
    //
    // 이게 없으면 실행이 끝나도 작업이 영원히 scheduled 로 남는다.
    // 방장이 /tasks 를 치면 이미 끝난 일이 "실행 대기"로 보인다.
    await this.advanceTaskThroughExecution(input.request.taskId, input.status);

    if (input.status === "completed") {
      await this.persistCollectedArtifacts(input.request, input.events);
    }

    if (input.status === "completed" && input.request.reportBotRole === "auditor") {
      await this.recordAuditVerification(input, resultSummary, telegramChatId, event.event_id);
    }

    if (input.status === "completed") {
      await this.enqueueMultiAiAuditIfReady(input, telegramChatId, event.event_id);
    }

    if (input.status === "completed" && shouldRequestAutomaticAudit(input.request, resultSummary)) {
      const auditIdempotencyKey = "telegram-audit:" + input.request.attemptId + ":completed";
      await this.insertOutboxIdempotently({
        event_id: event.event_id,
        idempotency_key: auditIdempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "auditor", telegramChatId }),
        payload: {
          botRole: "auditor",
          telegramChatId,
          text: renderAutomaticAuditRequestText(input.request),
          keyboard: buildCompletionKeyboard(input.request.taskId),
          binding: { kind: "verification", verificationId: event.event_id },
          idempotencyKey: auditIdempotencyKey
        },
        room_id: input.request.roomId
      });
    }
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

    await this.insertEventIdempotently({
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
          telegramChatId,
          text: "검증이 통과되었습니다. 완료 승인 또는 보완 여부를 선택해 주세요.",
          keyboard: buildCompletionKeyboard(input.request.taskId),
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
      p_target_kind: targetKind
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
    "작업 제안: " + plan.title,
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

function shouldRequestAutomaticAudit(request: ExecutionRequest, resultSummary: string): boolean {
  if (process.env.HUAI_AUTO_AUDIT_ENABLED !== "true") return false;
  if (request.reportBotRole === "auditor") return false;

  const prompt = request.prompt.toLowerCase();
  const summary = resultSummary.toLowerCase();
  const combined = `${prompt}\n${summary}`;

  const explicitAuditWords = [
    "\uAC80\uC99D", "\uAC10\uC0AC", "\uBCF4\uC548", "\uCDE8\uC57D", "security", "audit", "verify", "review"
  ];
  if (explicitAuditWords.some((keyword) => combined.includes(keyword.toLowerCase()))) return true;

  const meaningfulOutcomeWords = [
    "\uAD6C\uD604 \uC644\uB8CC", "\uC218\uC815 \uC644\uB8CC", "\uD14C\uC2A4\uD2B8 \uD1B5\uACFC", "\uD30C\uC77C \uC0DD\uC131", "\uBB38\uC11C \uC791\uC131",
    "\uBC30\uD3EC", "\uB9C8\uC774\uADF8\uB808\uC774\uC158", "migration", "schema", "supabase", "typecheck", "build passed", "tests passed"
  ];
  return meaningfulOutcomeWords.some((keyword) => combined.includes(keyword.toLowerCase()));
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
function inferVerificationVerdict(summary: string): "pass" | "conditional_pass" | "fail" {
  const lower = summary.toLowerCase();
  if (/실패|불합격|문제 있음|보완 필요|수정 필요|fail|failed|reject/.test(lower)) return "fail";
  if (/조건부|일부|주의|conditional/.test(lower)) return "conditional_pass";
  if (/통과|승인|문제 없음|완료|pass|passed|ok/.test(lower)) return "pass";
  return "conditional_pass";
}

function renderAutomaticAuditRequestText(request: ExecutionRequest): string {
  const actor = request.adapterType === "codex" ? "CodexBot" : "ClaudeBot";
  return [
    "\uAC80\uC99D \uC694\uCCAD: " + request.taskId,
    "\uC791\uC5C5\uC790: " + actor,
    "\uC2E4\uD589 \uACB0\uACFC\uB97C \uB3C5\uB9BD \uAC80\uC99D\uD574 \uC8FC\uC138\uC694.",
    "\uBC84\uD2BC: \u21BB \uC7AC\uAC80 / \u270E \uBCF4\uC644 / \u2713 \uC644\uB8CC"
  ].join("\n");
}

export function renderGatewayReportText(input: {
  request: ExecutionRequest;
  status: "completed" | "failed" | "rejected";
  events: GatewayEvent[];
  errorKind?: string;
}): string {
  if (input.status === "completed") {
    const summary = summarizeGatewayOutput(input.events);
    const lines = summary
      ? ["\uC791\uC5C5 \uC2E4\uD589 \uC644\uB8CC", "\uACB0\uACFC:", summary]
      : ["\uC791\uC5C5 \uC2E4\uD589 \uC644\uB8CC."];
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
  const failureEvidence = input.events
    .map((event) => {
      if ((event.type === "stdout" || event.type === "stderr") && "text" in event) return event.text;
      if (event.type === "failed" && "errorKind" in event) return event.errorKind;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  const reason = humanReadableGatewayError(input.errorKind ?? outputSummary ?? "failed", failureEvidence || outputSummary, input.request.adapterType);
  return ["\uC791\uC5C5 \uC2E4\uD589 \uC2E4\uD328", "\uC6D0\uC778: " + reason, "\uD544\uC694\uD558\uBA74 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uC791\uC5C5\uC790 \uBCF4\uC644\uC744 \uC694\uCCAD\uD574 \uC8FC\uC138\uC694."].join("\n");
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

function compactHumanVisibleLines(lines: string[]): string {
  const important = lines.filter(isImportantHumanLine);
  const selected = (important.length > 0 ? important : lines).slice(0, 6);
  return truncate(selected.join("\n").trim(), 3200);
}

function isImportantHumanLine(line: string): boolean {
  const importantWords = [
    "\uACB0\uB860", "\uC810\uC218", "\uC644\uC131\uB3C4", "\uD310\uC815", "\uC6D0\uC778", "\uD544\uC694", "\uC870\uCE58",
    "\uC218\uC815", "\uBCF4\uC644", "\uC2E4\uD328", "\uC644\uB8CC", "\uD1B5\uACFC", "\uC2B9\uC778", "\uBD88\uAC00",
    "\uC704\uD5D8", "\uC8FC\uC758", "\uB2E4\uC74C", "secret", "token", "error", "failed", "passed"
  ];
  const lower = line.toLowerCase();
  return importantWords.some((word) => lower.includes(word.toLowerCase()));
}

function isLowValueHumanLine(line: string): boolean {
  const lowValuePrefixes = [
    "\uD83D\uDCC1", "\uD83D\uDCC4", "\uAC80\uC99D \uC81C\uD55C", "\uC774\uBC88 \uD658\uACBD\uC5D0\uC11C",
    "\uB610\uD55C Dynamic Workflow", "\uC624\uCC28 \uBC94\uC704", "C:\\"
  ];
  return (
    /^\|/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^[-*]\s*$/.test(line) ||
    /^[A-Z_]+:/.test(line) ||
    lowValuePrefixes.some((prefix) => line.startsWith(prefix)) ||
    /node_modules|dist\/|\.json|\.ts|\.js|OPERATION_STATUS\.md/.test(line)
  );
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







