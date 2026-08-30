import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import {
  classifyTaskRisk,
  type ExecutionRequest,
  type GatewayEvent,
  type OutboxRecord,
  type TelegramSendResult
} from "../../contracts/src/index.js";
import { buildMiniAppOpenKeyboard } from "../../telegram-ui/src/index.js";
import { isLeaderPlanningAttempt } from "../../orchestrator/src/index.js";
import {
  renderGatewayReportText,
  gatewayFailureEvidence,
  summarizeGatewayOutput
} from "./gateway-report-rendering.js";
import {
  parseMidApprovalRequestFromEvents,
  buildReportOpenKeyboard,
  roomMessagePreviewLimit,
  buildRoomMessageWithPreview
} from "./message-rendering.js";
import {
  shouldFallbackToOtherEngine,
  producedRealArtifacts
} from "./engine-fallback.js";
import {
  shouldRunAutomaticAudit,
  auditProducedNoVerdict
} from "./audit-prompts.js";
import { extractTaskQuizFromEvents } from "./task-quiz.js";
import { isUuid } from "./small-utils.js";
import { requiredEnv, summarizeGatewayEvents } from "./outbox-row-mapping.js";
// God file 분리(2026-08, 3차) — 실행 결과 처리(recordGatewayExecutionResult)를 이루는
// 책임 넷을 각각 별도 클래스로 뽑았다. 이 파일은 그 넷을 구성(compose)해서 원래
// 하나였던 흐름을 그대로 오케스트레이션만 한다. 외부에 노출되는 클래스 이름
// (SupabaseOutboxStore)·생성자 시그니처·모든 public 메서드는 그대로다.
import { SupabaseOutboxCore } from "./outbox-core.js";
import { SupabaseLeaderPlanningStore } from "./leader-planning-store.js";
import { SupabaseAuditVerificationStore } from "./audit-verification-store.js";
import { SupabasePostExecutionStore } from "./post-execution-store.js";

export type SupabaseRuntimeConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  // "전문 보기" 버튼이 열 현황판 딥링크의 베이스. 없으면 버튼 없이 앞부분만 보낸다.
  miniAppDirectLinkBaseUrl?: string;
  // 방 기억(위키)을 읽어올 폴더. 게이트웨이와 같은 PC 에 있다는 전제다.
  archiveRootDir?: string;
  // 이 게이트웨이 앞으로 온 일만 리스한다. 없으면 예전처럼 전부 대상 —
  // 텔레그램 발신 리스(bot-service)는 게이트웨이 개념이 없으므로 그대로 둔다.
  gatewayId?: string;
};

export class SupabaseOutboxStore {
  // God class 분리(2026-08, 3차) — 아래 넷은 원래 이 클래스 하나에 있던 책임을
  // 나눠 뽑은 것이다. 전부 같은 SupabaseOutboxCore(=같은 SupabaseRestClient 인스턴스)를
  // 공유해 동작은 바꾸지 않는다. 의존 방향: core ← auditVerificationStore ←
  // postExecutionStore(감사 큐잉을 호출), leaderPlanningStore ← core.
  private readonly core: SupabaseOutboxCore;
  private readonly leaderPlanningStore: SupabaseLeaderPlanningStore;
  private readonly auditVerificationStore: SupabaseAuditVerificationStore;
  private readonly postExecutionStore: SupabasePostExecutionStore;

  constructor(config: SupabaseRuntimeConfig) {
    this.core = new SupabaseOutboxCore(config);
    this.leaderPlanningStore = new SupabaseLeaderPlanningStore(this.core);
    this.auditVerificationStore = new SupabaseAuditVerificationStore(this.core);
    this.postExecutionStore = new SupabasePostExecutionStore(this.core, this.auditVerificationStore);
  }

  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.core.leasePending(limit, leaseUntil);
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.core.leasePendingLocalGateway(limit, leaseUntil);
  }

  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    return this.core.markSent(outboxId, result);
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string, attemptsOverride?: number): Promise<void> {
    return this.core.markRetry(outboxId, error, nextAttemptAt, attemptsOverride);
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    return this.core.markDead(outboxId, error);
  }

  async recordGatewayExecutionResult(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }): Promise<void> {
    const telegramChatId = await this.core.fetchRoomTelegramChatId(input.request.roomId);
    const resultSummary = summarizeGatewayOutput(input.events) ?? "";
    const midApproval = input.status === "completed" && input.request.reportBotRole !== "auditor"
      ? parseMidApprovalRequestFromEvents(input.events)
      : undefined;
    const isAudit = input.request.reportBotRole === "auditor";
    const eventType = input.status !== "completed"
      ? "execution_delayed_or_failed"
      : isAudit
        ? "meaningful_intermediate_ready"
        : input.request.revisionContext
        ? "revision_submitted"
        : midApproval
          ? "mid_approval_required"
          : "meaningful_intermediate_ready";
    const eventKey = "gateway-result:" + input.request.attemptId + ":" + input.status;
    const event = await this.core.insertEventIdempotently({
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
        events: summarizeGatewayEvents(input.events),
        ...(midApproval ? {
          reportId: midApproval.reportId,
          approvalRequestId: midApproval.approvalRequestId,
          significanceReason: midApproval.significanceReason,
          affectedTaskIds: midApproval.affectedTaskIds
        } : {}),
        ...(input.request.revisionContext ? {
          revisionRequestId: input.request.revisionContext.revisionRequestId,
          priorVerificationId: input.request.revisionContext.priorVerificationId,
          changedScope: input.request.revisionContext.changedScope,
          reverifyScope: input.request.revisionContext.reverifyScope
        } : {})
      }
    });

    // 리더 판단은 작업 실행이 아니다. "작업 실행 완료" 보고를 내보내면 방에 잡음만 남는다.
    // 판단 결과는 아래 applyLeaderPlanningResult 가 제안 또는 답변으로 올린다.
    if (isLeaderPlanningAttempt(input.request.attemptId)) {
      await this.leaderPlanningStore.applyLeaderPlanningResult(input, telegramChatId, event.event_id);
      return;
    }

    await this.core.recordHookAttempt(event.event_id, input.status === "failed" ? "failed" : "succeeded", input.errorKind);
    await this.core.recordExecutionAttempt(input);

    const botRole = input.request.reportBotRole ?? (input.request.adapterType === "codex" ? "codex_leader" : "claude_leader");
    const fullText = midApproval
      ? `${midApproval.summary}\n\n이 결과는 영향이 커 방장 중간 승인이 필요합니다.`
      : renderGatewayReportText(input);
    const idempotencyKey = "telegram-report:" + input.request.attemptId + ":" + input.status;

    // 긴 보고는 앞부분만 방에 보내고 전문은 현황판에서 읽는다. 전문을 먼저 저장해야
    // 버튼이 가리킬 곳이 생긴다 — 저장 전에 버튼을 보내면 눌렀을 때 빈 화면이 된다.
    const report = await this.core.saveTaskReport(input.request, botRole, fullText);
    const preview = buildRoomMessageWithPreview(fullText, roomMessagePreviewLimit());
    const text = preview.text + (midApproval && !this.core.miniAppDirectLinkBaseUrl
      ? "\n협업 운영센터 링크가 설정되지 않아 승인 UI가 비활성화되었습니다. 운영 담당자에게 BOT_SERVICE_MINIAPP_DIRECT_LINK 설정을 요청하세요."
      : "");
    const reportKeyboard = midApproval
      ? this.core.miniAppDirectLinkBaseUrl
        ? buildMiniAppOpenKeyboard({ directLinkBaseUrl: this.core.miniAppDirectLinkBaseUrl, roomId: input.request.roomId, messageThreadId: input.request.telegramMessageThreadId })
        : undefined
      : preview.truncated && report ? buildReportOpenKeyboard(report.report_id, this.core.miniAppDirectLinkBaseUrl) : undefined;

    await this.core.insertOutboxIdempotently({
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
      await this.postExecutionStore.enqueueEngineFallback(input.request, telegramChatId, event.event_id);
      return;
    }

    // 실행 결과를 상태기계에 반영한다.
    //
    // 이게 없으면 실행이 끝나도 작업이 영원히 scheduled 로 남는다.
    // 방장이 /tasks 를 치면 이미 끝난 일이 "실행 대기"로 보인다.
    if (!isAudit && input.request.revisionContext && input.status === "completed") {
      await this.postExecutionStore.submitRevisionAfterExecution(input, resultSummary, telegramChatId, event.event_id);
    } else {
      await this.core.advanceTaskThroughExecution(input.request.taskId, input.status, midApproval ? "mid_approval_required" : undefined);
    }

    if (input.status === "completed") {
      await this.postExecutionStore.persistCollectedArtifacts(input.request, input.events);
    }

    if (midApproval) {
      await this.postExecutionStore.persistMidApproval(input.request, midApproval);
      return;
    }

    if (!isAudit && input.request.revisionContext && input.status === "completed") return;

    // 인지부채 방지 퀴즈 — 고위험 작업의 작업자(감사·리더 판단 아님)가 실제로 파일을
    // 바꾼 실행에서만
    // 저장한다. 감사는 검증이지 방장이 이해해야 할 변경이 아니고, 리더 판단은 애초에
    // 이 지점에 도달하지 않는다(위 isLeaderPlanningAttempt 체크에서 이미 return 함).
    if (
      input.status === "completed" &&
      input.request.reportBotRole !== "auditor" &&
      classifyTaskRisk(input.request.prompt) === "high" &&
      producedRealArtifacts(input.events)
    ) {
      const quiz = extractTaskQuizFromEvents(input.events);
      if (quiz) await this.postExecutionStore.saveTaskQuiz(input.request, quiz);
    }

    if (input.status === "completed" && input.request.reportBotRole === "auditor") {
      // 감사가 아무 판정도 못 내고 끝나는 일이 있다. CLI 가 권한 문제로 도구를 하나도
      // 못 써서 "no output produced" 만 남기고 종료코드 0 으로 끝난 경우다(라이브에서
      // Antigravity 가 그랬다). 그걸 감사 결과로 받으면 근거 없는 "보완 필요"가 방에
      // 걸리고 작업자가 고칠 것도 없는 수정 요구를 받는다.
      if (auditProducedNoVerdict(resultSummary)) {
        await this.auditVerificationStore.reportEmptyAudit(input.request, telegramChatId, event.event_id);
        return;
      }
      await this.auditVerificationStore.recordAuditVerification(input, resultSummary, telegramChatId, event.event_id);
    }

    if (input.status === "completed") {
      await this.auditVerificationStore.enqueueMultiAiAuditIfReady(input, telegramChatId, event.event_id);
    }

    if (input.status === "completed" && shouldRunAutomaticAudit(input.request, input.events)) {
      await this.auditVerificationStore.enqueueSingleWorkerAudit(input, resultSummary, telegramChatId, event.event_id);
    } else if (input.status === "completed" && !isLeaderPlanningAttempt(input.request.attemptId) && input.request.reportBotRole !== "auditor") {
      await this.auditVerificationStore.closeWithoutAudit(input.request, telegramChatId, event.event_id);
    }
  }
}

export function buildSupabaseOutboxStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseOutboxStore {
  return new SupabaseOutboxStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY")
  });
}

// ─────────────────────────────────────────────────────────────────────────
// God module 분리(2026-08) — 아래는 원래 이 파일에 있던 export 를 그대로 유지하기
// 위한 배럴 재수출이다. 실제 정의는 각 모듈로 옮겨졌다. 외부 import 경로
// ("../../supabase-runtime/src/index.js" 등)는 하나도 바뀌지 않는다.
// ─────────────────────────────────────────────────────────────────────────
export {
  renderLeaderPlanMessage,
  MAX_TELEGRAM_CALLBACK_BYTES,
  shortProposalId,
  rawStdoutFromGatewayEvents,
  sessionIdFromGatewayEvents,
  renderRevisionRequestText,
  type MidApprovalRequest,
  parseMidApprovalRequestFromEvents,
  classifyRevisionChangedScope,
  collectedArtifactsFromEvents,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  DEFAULT_ROOM_MESSAGE_PREVIEW_CHARS,
  buildReportOpenKeyboard,
  roomMessagePreviewLimit,
  previewRoomMessage,
  buildRoomMessageWithPreview,
  isDeliverableDocument,
  localArtifactPath,
  artifactUri,
  summarizeSupabaseSendResult
} from "./message-rendering.js";
export {
  FALLBACK_ATTEMPT_SUFFIX,
  MAX_FALLBACK_HOPS,
  fallbackHopCount,
  nextEngineAfterTried,
  nextEngineAfter,
  reportBotRoleForAdapter,
  engineActorName,
  shouldFallbackToOtherEngine,
  producedRealArtifacts,
  realArtifactPaths
} from "./engine-fallback.js";
export {
  buildSingleWorkerAuditPrompt,
  buildMultiAiAuditPrompt,
  auditProducedNoVerdict
} from "./audit-prompts.js";
export {
  renderGatewayReportText,
  gatewayFailureEvidence,
  extractAgentResultText
} from "./gateway-report-rendering.js";
export {
  type TaskQuizQuestion,
  type TaskQuiz,
  extractTaskQuizFromEvents,
  parseTaskQuizBlock
} from "./task-quiz.js";
