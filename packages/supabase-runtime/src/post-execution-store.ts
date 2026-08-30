// God file 분리(2026-08, 3차) — index.ts 의 SupabaseOutboxStore 에서 뽑아낸 실행
// 결과 후처리. 중간승인 기록, 보완 실행 제출, 인지부채 방지 퀴즈 저장, 산출물·문서 전달,
// 한도 초과 시 다른 엔진으로 넘기는 폴백을 담는다. SupabaseOutboxCore(공통 원시 동작)와
// SupabaseAuditVerificationStore(보완 제출 후 단일 작업자 감사 큐잉)를 주입받는다.
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import { type AiAdapterType, type ArtifactManifest, type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";
import {
  type MidApprovalRequest,
  collectedArtifactsFromEvents,
  TELEGRAM_DOCUMENT_MAX_BYTES,
  isDeliverableDocument,
  localArtifactPath,
  artifactUri
} from "./message-rendering.js";
import {
  FALLBACK_ATTEMPT_SUFFIX,
  nextEngineAfterTried,
  reportBotRoleForAdapter,
  engineActorName
} from "./engine-fallback.js";
import { type TaskQuiz } from "./task-quiz.js";
import { isUuid } from "./small-utils.js";
import { SupabaseOutboxCore } from "./outbox-core.js";
import { SupabaseAuditVerificationStore } from "./audit-verification-store.js";

export class SupabasePostExecutionStore {
  constructor(
    private readonly core: SupabaseOutboxCore,
    private readonly auditVerificationStore: SupabaseAuditVerificationStore
  ) {}

  async persistMidApproval(request: ExecutionRequest, checkpoint: MidApprovalRequest): Promise<void> {
    if (!isUuid(request.taskId)) return;
    await this.core.client.request("POST", "/huai_reports", {
      body: {
        report_id: checkpoint.reportId,
        task_id: request.taskId,
        is_meaningful: true,
        summary: maskSensitiveText(checkpoint.summary).slice(0, 4000),
        approval_required: true,
        impact_scope: {
          significanceReason: checkpoint.significanceReason,
          affectedTaskIds: checkpoint.affectedTaskIds
        }
      },
      prefer: "return=minimal"
    }).then((response) => (response.status === 409 ? undefined : response.expectOk()));

    for (const affectedTaskId of checkpoint.affectedTaskIds) {
      if (!isUuid(affectedTaskId) || affectedTaskId === request.taskId) continue;
      await this.core.client.request("POST", "/huai_task_dependencies", {
        body: {
          room_id: request.roomId,
          predecessor_task_id: request.taskId,
          successor_task_id: affectedTaskId,
          dependency_type: "blocks",
          is_blocking: true
        },
        prefer: "return=minimal"
      }).then((response) => (response.status === 409 ? undefined : response.expectOk()));
    }
  }

  async submitRevisionAfterExecution(
    input: { request: ExecutionRequest; events: GatewayEvent[]; occurredAt: string },
    resultSummary: string,
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    const revision = input.request.revisionContext;
    if (!revision || !isUuid(input.request.taskId)) return;

    await this.core.client.request(
      "PATCH",
      "/huai_revision_requests?revision_request_id=eq." + encodeURIComponent(revision.revisionRequestId) + "&status=eq.open",
      {
        body: {
          status: "submitted",
          fix_submission_id: input.request.attemptId,
          changed_scope: revision.changedScope,
          submitted_at: input.occurredAt
        },
        prefer: "return=minimal"
      }
    ).then((response) => response.expectOk());

    await this.core.advanceTaskStatus(input.request.taskId, "revision_submitted", {
      isAssignee: true,
      actorRole: input.request.reportBotRole ?? "codex_leader",
      changedScope: revision.changedScope
    });

    if (revision.changedScope === "content") {
      await this.auditVerificationStore.enqueueSingleWorkerAudit(input, resultSummary, telegramChatId, sourceEventId);
      return;
    }

    if (revision.changedScope === "format_only") {
      const idempotencyKey = "telegram-format-revision-review:" + input.request.attemptId;
      await this.core.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
        payload: {
          botRole: "leader",
          messageThreadId: input.request.telegramMessageThreadId,
          telegramChatId,
          text: "형식 보완이 제출되었습니다. 내용 범위는 바뀌지 않아 전체 재검증 대신 소대장 확인으로 이동합니다.",
          binding: { kind: "task", taskId: input.request.taskId },
          idempotencyKey
        },
        room_id: input.request.roomId
      });
    }
  }

  // 인지부채 방지 퀴즈를 저장한다. 실패해도 완료 처리 자체를 막지 않는다 — 퀴즈는
  // 방장 이해도 확인용 부가 기능이지, 없다고 결과물이 사라지는 건 아니다(miniapp-approve
  // 는 퀴즈 행이 아예 없으면 통과시킨다 — 정상 동작으로 폴백한다).
  // on_conflict=task_id 로 업서트한다 — 엔진 폴백(engine-fallback)으로 같은 task 가
  // 다시 실행되면 새 퀴즈로 덮어써야 하므로 passed/attempts 도 매번 초기화한다.
  async saveTaskQuiz(request: ExecutionRequest, quiz: TaskQuiz): Promise<void> {
    if (!isUuid(request.taskId) || !isUuid(request.roomId)) return;
    await this.core.client
      .request("POST", "/huai_task_quizzes?on_conflict=task_id", {
        body: {
          task_id: request.taskId,
          room_id: request.roomId,
          summary: quiz.summary,
          questions: quiz.questions,
          passed: false,
          attempts: 0,
          updated_at: new Date().toISOString()
        },
        prefer: "resolution=merge-duplicates,return=minimal"
      })
      .then((response) => response.expectOk())
      .catch(() => undefined);
  }

  async persistCollectedArtifacts(request: ExecutionRequest, events: readonly GatewayEvent[]): Promise<void> {
    if (!isUuid(request.taskId)) return;
    const collected = collectedArtifactsFromEvents(events);
    if (collected.length === 0) return;

    const saved: Array<{ uri: string; version: string; isFinal: boolean }> = [];
    for (const artifact of collected) {
      const uri = artifactUri(artifact, request);
      const existing = await this.core.client
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
      const inserted = await this.core.client.request("POST", "/huai_artifacts", {
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

    const savedEvent = await this.core.insertEventIdempotently({
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

    // Keep an immutable recovery pointer for each persisted artifact.  Recovery
    // metadata is best-effort: a metadata outage must never hide a result that
    // was already saved and queued for delivery.
    for (const artifact of saved) {
      await this.core.client.request("POST", "/huai_recovery_snapshots", {
        body: {
          room_id: request.roomId,
          task_id: request.taskId,
          snapshot_type: "artifact",
          storage_uri: artifact.uri,
          checksum: artifact.version,
          created_by: request.actorId || "gateway"
        },
        prefer: "return=minimal"
      }).then((response) => (response.status === 409 ? undefined : response.expectOk())).catch(() => undefined);
    }

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
    const telegramChatId = await this.core.fetchRoomTelegramChatId(request.roomId);
    if (!telegramChatId) return;

    for (const artifact of artifacts) {
      const localPath = localArtifactPath(artifact, request);
      if (!localPath || !isDeliverableDocument(localPath)) continue;
      // 크기 한계를 넘는 파일은 텔레그램이 받지 않는다. 시도해서 실패로 남기느니 안 보낸다.
      if (artifact.sizeBytes > TELEGRAM_DOCUMENT_MAX_BYTES) continue;

      const idempotencyKey = "telegram-artifact:" + request.attemptId + ":" + artifact.checksum;
      await this.core.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
        payload: {
          botRole: "leader",
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

  // 한 엔진이 사용 한도에 걸리면 다른 엔진으로 한 번 다시 건다.
  //
  // 라이브에서 감사가 Codex 한도로 죽었고, 방장이 손으로 다시 시키기 전까지 작업이
  // 멈춰 있었다. 한도는 우리가 고칠 수 있는 게 아니지만, 다른 엔진은 멀쩡하다.
  //
  // 감사도 넘긴다. 원칙은 작업자와 다른 엔진에 맡기는 것이고 그게 최선이지만, 그
  // 엔진이 막혔을 때의 선택지는 "같은 모델의 다른 세션이 diff 를 보고 반증한다" 와
  // "아무도 안 본다" 둘뿐이다. 후자가 더 나쁘다. 대신 방에 그 사실을 밝힌다 —
  // 방장이 알고 승인하는 것과 시스템이 몰래 때우는 것은 다르다.
  async enqueueEngineFallback(
    request: ExecutionRequest,
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    const gatewayId = await this.core.fetchActiveGatewayId(request.roomId);
    if (!gatewayId) return;

    // 이미 시도한 엔진을 빼고 고른다. 두 번째로 넘길 때 첫 번째로 막힌 엔진을 다시 고르면
    // 같은 실패를 반복한다.
    const tried = [...(request.triedAdapterTypes ?? []), request.adapterType];
    const fallbackAdapter = nextEngineAfterTried(tried, request.workerAdapterType);
    if (!fallbackAdapter) return;
    const attemptId = request.attemptId + FALLBACK_ATTEMPT_SUFFIX;
    const isAudit = request.reportBotRole === "auditor";

    await this.core.insertOutboxIdempotently({
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
          triedAdapterTypes: tried,
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
    await this.core.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: "telegram-engine-fallback:" + attemptId,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
      payload: {
        botRole: "leader",
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
    const actors = await this.core.client
      .request(
        "GET",
        "/huai_ai_actors?room_id=eq." + encodeURIComponent(request.roomId) +
          "&role=eq." + encodeURIComponent(role) +
          "&status=eq.active&select=actor_id&limit=1"
      )
      .then((response) => response.json<Array<{ actor_id: string }>>());
    const actorId = actors[0]?.actor_id;
    if (!actorId) return;

    await this.core.client
      .request("PATCH", "/huai_tasks?task_id=eq." + encodeURIComponent(request.taskId), {
        body: { assignee_actor_id: actorId },
        prefer: "return=minimal"
      })
      .then((response) => response.expectOk());
  }
}
