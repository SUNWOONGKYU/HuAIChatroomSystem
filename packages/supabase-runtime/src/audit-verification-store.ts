// God file 분리(2026-08, 3차) — index.ts 의 SupabaseOutboxStore 에서 뽑아낸
// 감사(audit)·검증(verification) 처리. 단일 작업자 자동감사·다중 AI 교차감사 큐잉,
// 감사 판정 기록, 검증 불합격 시 보완 요청 루프, 감사 없이 완료로 넘어가는 경로를 담는다.
// SupabaseOutboxCore 를 주입받아 outbox/event idempotent 삽입·상태 전이 등 공통 원시
// 동작을 쓴다.
import { readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";
import {
  renderRevisionRequestText,
  AUDIT_MEMORY_DAYS,
  AUDIT_MEMORY_MAX_ITEMS,
  buildReportOpenKeyboard,
  roomMessagePreviewLimit,
  buildRoomMessageWithPreview
} from "./message-rendering.js";
import {
  nextEngineAfter,
  reportBotRoleForAdapter,
  engineActorName,
  realArtifactPaths
} from "./engine-fallback.js";
import {
  multiAiAttemptGroup,
  isCompletedMultiAiSibling,
  buildSingleWorkerAuditPrompt,
  buildMultiAiAuditPrompt,
  inferVerificationVerdict
} from "./audit-prompts.js";
import { isUuid } from "./small-utils.js";
import { SupabaseOutboxCore } from "./outbox-core.js";

export class SupabaseAuditVerificationStore {
  constructor(private readonly core: SupabaseOutboxCore) {}

  // 판정 없이 끝난 감사를 방에 알린다. 조용히 넘기면 방장은 검증이 된 줄 안다.
  async reportEmptyAudit(
    request: ExecutionRequest,
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    const idempotencyKey = "telegram-empty-audit:" + request.attemptId;
    await this.core.insertOutboxIdempotently({
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

  // 감사가 붙지 않는 실행을 완료 승인 대기까지 보낸다.
  //
  // 실행이 끝나면 작업은 verification_pending 으로 간다. 원래는 감사가 그 뒤를 이어
  // 통과시켜 완료 승인 대기로 올렸다. 그런데 파일을 바꾸지 않은 실행("줄 수 알려줘")은
  // 감사를 붙이지 않기로 했으므로, 그 자리에서 깨울 사람이 없어 영영 멈춘다 —
  // 라이브에서 조회 작업 5건이 검증 대기에 묶여 현황판 "대기" 칸만 불렸다.
  //
  // 자동으로 완료 처리하지는 않는다. 마지막 한 번은 방장이 누른다(FR-015). 감사할
  // 대상이 없다는 것이 방장 확인까지 건너뛸 이유는 아니다.
  async closeWithoutAudit(request: ExecutionRequest, telegramChatId: string, sourceEventId: string): Promise<void> {
    if (!isUuid(request.taskId)) return;
    await this.core.advanceTaskStatus(request.taskId, "verification_started", { isVerifier: true, actorRole: "auditor", verifierActorId: request.actorId, authorActorId: "system" });
    await this.core.advanceTaskStatus(request.taskId, "verification_passed", { isVerifier: true, actorRole: "auditor" });
    await this.core.advanceTaskStatus(request.taskId, "commander_completion_approved", { actorRole: "leader" });

    const idempotencyKey = "telegram-completion-review:" + request.attemptId;
    await this.core.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
      payload: {
        botRole: "leader",
        messageThreadId: request.telegramMessageThreadId,
        telegramChatId,
        text: "파일 수정 작업이 아니어서 검증 없이 마쳤습니다.\n완료 승인은 고정된 협업 운영센터에서 결정해 주세요.",
        binding: { kind: "event", eventId: sourceEventId },
        idempotencyKey
      },
      room_id: request.roomId
    });
  }

  // 이 방에서 되풀이된 지적을 모은다. 감사자가 같은 실수를 매번 처음처럼 찾지 않게 한다.
  //
  // 출처는 세션 폴더의 방 기억 파일이다(DB 아님) — 요약을 DB 에 쌓지 않기로 한 결정에 따른다.
  // 못 읽으면 빈 배열이다. 감사는 그대로 돌고, 힌트만 없어진다.
  private async readRecurringFindings(roomId: string): Promise<string[]> {
    try {
      const rooms = await this.core.client
        .request("GET", "/huai_rooms?room_id=eq." + encodeURIComponent(roomId) + "&select=purpose&limit=1")
        .then((response) => response.json<Array<{ purpose?: string }>>());
      const label = (rooms[0]?.purpose || roomId).replace(/[\/:*?"<>|]/g, "_").slice(0, 60);
      const dir = nodePath.join(this.core.archiveRootDir, label);
      const entries = (await readdir(dir).catch(() => [] as string[]))
        .filter((name) => name.endsWith("_위키.md"))
        .sort()
        .slice(-AUDIT_MEMORY_DAYS);

      const findings = new Set<string>();
      for (const entry of entries) {
        const text = await readFile(nodePath.join(dir, entry), "utf8").catch(() => "");
        const section = text.split(/^##\s*반복 지적\s*$/m)[1];
        if (!section) continue;
        for (const line of section.split(/\r?\n/)) {
          const item = line.replace(/^[-*]\s*/, "").trim();
          if (item && item !== "없음" && !item.startsWith("#")) findings.add(item);
        }
      }
      return [...findings].slice(0, AUDIT_MEMORY_MAX_ITEMS);
    } catch {
      return [];
    }
  }

  // 파일을 바꾼 작업은 방장이 버튼을 누르지 않아도 감사가 돈다.
  //
  // 예전에는 감사 "요청" 메시지만 방에 올리고 실제 실행은 방장이 검증 버튼을 눌러야
  // 걸렸다. 라이브에서 단일 작업자 자동감사로 실제 실행된 건수는 0이었다(게이트웨이
  // 실행요청 172건 중 감사 9건은 전부 다중 AI 경로였다) — 즉 자동 검증은 이름뿐이고
  // 아무것도 검증되지 않고 있었다. 수동 결정(완료·보완)은 협업 운영센터가 맡는다.
  async enqueueSingleWorkerAudit(
    input: { request: ExecutionRequest; events: GatewayEvent[] },
    resultSummary: string,
    telegramChatId: string,
    eventId: string
  ): Promise<void> {
    const gatewayId = await this.core.fetchActiveGatewayId(input.request.roomId);
    if (!gatewayId) return;

    const actor = engineActorName(input.request.adapterType);
    const auditRequest: ExecutionRequest = {
      ...input.request,
      attemptId: input.request.attemptId + "-audit",
      // 작업자와 다른 엔진에 맡긴다. 같은 엔진이 자기 결과를 보면 독립 감사가 아니다.
      adapterType: nextEngineAfter(input.request.adapterType),
      // 감사가 한도에 걸려 또 넘어갈 때 작업자 엔진으로 되돌아가지 않게 남겨 둔다.
      workerAdapterType: input.request.adapterType,
      prompt: buildSingleWorkerAuditPrompt(
        input.request.taskId,
        actor,
        resultSummary,
        realArtifactPaths(input.events),
        await this.readRecurringFindings(input.request.roomId)
      ),
      idempotencyKey: "single-worker-audit:" + input.request.attemptId,
      reportBotRole: "auditor"
    };
    // 보완 실행의 문맥은 작업자 제출까지만 유효하다. 이를 감사 요청에 남기면 감사 결과가
    // revision_submitted 로 다시 분류되어 재검증 판정이 영원히 기록되지 않는다.
    delete auditRequest.revisionContext;

    await this.core.insertOutboxIdempotently({
      event_id: eventId,
      idempotency_key: "gateway:single-worker-audit:" + input.request.attemptId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: { executionRequest: auditRequest, telegramChatId },
      room_id: input.request.roomId
    });
  }

  async enqueueMultiAiAuditIfReady(input: {
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
    const rows = await this.core.client
      .request("GET", "/huai_events?event_type=eq.meaningful_intermediate_ready&room_id=eq." + encodeURIComponent(input.request.roomId) + "&select=event_id,payload,created_at&order=created_at.desc&limit=100")
      .then((response) => response.json<Array<{ event_id: string; payload: Record<string, unknown>; created_at?: string }>>());
    const related = rows.filter((row) => isCompletedMultiAiSibling(row.payload, input.request.taskId, group.baseAttemptId));
    const claude = related.find((row) => String(row.payload.attemptId) === group.baseAttemptId + "-claude");
    const codex = related.find((row) => String(row.payload.attemptId) === group.baseAttemptId + "-codex");
    if (!claude || !codex) return;

    const gatewayId = await this.core.fetchActiveGatewayId(input.request.roomId);
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

    await this.core.insertOutboxIdempotently({
      event_id: eventId,
      idempotency_key: "gateway:multi-ai-audit:" + input.request.taskId + ":" + group.baseAttemptId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: { executionRequest: auditRequest, telegramChatId },
      room_id: input.request.roomId
    });
  }

  async recordAuditVerification(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }, resultSummary: string, telegramChatId: string, sourceEventId: string): Promise<void> {
    if (!isUuid(input.request.taskId)) return;
    const verdict = inferVerificationVerdict(resultSummary);
    const existing = await this.core.client
      .request("GET", "/huai_verifications?task_id=eq." + encodeURIComponent(input.request.taskId) + "&target_version=eq." + encodeURIComponent(input.request.attemptId) + "&select=verification_id&limit=1")
      .then((response) => response.json<Array<{ verification_id: string }>>());
    let verificationId = existing[0]?.verification_id;
    if (existing.length === 0) {
      const inserted = await this.core.client.request("POST", "/huai_verifications", {
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
        prefer: "return=representation"
      }).then(async (response) => {
        await response.expectOk();
        return response.json<Array<{ verification_id: string }>>();
      });
      verificationId = inserted[0]?.verification_id;
    }

    // 불합격이 막다른 길이 되면 독립 검증 기능 전체가 장식이 된다.
    // 기획서 H-07: "검증 의견 등록 -> 담당 작업팀에 수정 요구, 상태를 수정 중으로 전환".
    if (verdict !== "pass") {
      await this.requestRevisionAfterFailedVerification(input, resultSummary, telegramChatId, sourceEventId, verificationId);
      return;
    }

    if (verdict === "pass") {
      // 검증 통과 -> 리더 완료 결정 -> 방장 최종 승인 대기.
      // 앞의 두 단계는 시스템이 진행하고, 마지막 한 번만 방장이 누른다 (FR-015).
      await this.core.advanceTaskStatus(input.request.taskId, "verification_started", { isVerifier: true, actorRole: "auditor", verifierActorId: input.request.actorId, authorActorId: "system" });
      await this.core.advanceTaskStatus(input.request.taskId, "verification_passed", { isVerifier: true, actorRole: "auditor" });
      await this.core.advanceTaskStatus(input.request.taskId, "commander_completion_approved", { actorRole: "leader" });

      await this.core.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: "telegram-completion-review:" + input.request.attemptId,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
        payload: {
          botRole: "leader",
          messageThreadId: input.request.telegramMessageThreadId,
          telegramChatId,
          // 결정 버튼은 방에 붙이지 않는다 — 완료·보완 결정은 협업 운영센터가 맡는다.
          // 이 상태(completion_approval_pending·commander_completion_pending)는
          // 협업 운영센터에서 decidable 이라(supabase/functions/_shared/task-status.ts) 방장이
          // 갇히지 않는다. 방에는 알림만 남겨 대화 공간을 버튼으로 채우지 않는다.
          text: "검증이 통과되었습니다.\n완료 승인 또는 보완 요청은 고정된 협업 운영센터에서 결정해 주세요.",
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
    sourceEventId: string,
    verificationId?: string
  ): Promise<void> {
    const taskId = input.request.taskId;
    const requiredFixes = resultSummary || "검증에서 보완이 필요한 항목이 확인되었습니다.";
    const reverifyScope = "보완된 변경 범위";

    if (isUuid(taskId)) {
      const existing = await this.core.client
        .request("GET", "/huai_revision_requests?task_id=eq." + encodeURIComponent(taskId) + "&status=eq.open&select=revision_request_id&limit=1")
        .then((response) => response.json<Array<{ revision_request_id: string }>>());
      let revisionRequestId = existing[0]?.revision_request_id;
      if (existing.length === 0) {
        const inserted = await this.core.client.request("POST", "/huai_revision_requests", {
          body: {
            task_id: taskId,
            verification_id: verificationId ?? null,
            required_fixes: maskSensitiveText(requiredFixes).slice(0, 4000),
            reverify_scope: reverifyScope,
            status: "open"
          },
          prefer: "return=representation"
        }).then(async (response) => {
          if (response.status === 409) return [];
          await response.expectOk();
          return response.json<Array<{ revision_request_id: string }>>();
        });
        revisionRequestId = inserted[0]?.revision_request_id;
      }

      if (revisionRequestId) {
        await this.enqueueRevisionExecution(input, requiredFixes, reverifyScope, revisionRequestId, verificationId, sourceEventId);
      }
    }

    // 상태기계에 실제로 반영한다. 이벤트만 쌓고 상태를 안 바꾸면 작업은 여전히 검증 중으로 남는다.
    const event = await this.core.insertEventIdempotently({
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
    await this.core.advanceTaskStatus(taskId, "verification_failed_or_changes_requested", { isVerifier: true, actorRole: "auditor" });

    // 담당팀 봇으로 보완 요청을 보낸다. 검증자 봇이 아니라 작업자 봇이 받아야 한다.
    //
    // 어느 엔진이 그 작업을 했는지는 workerAdapterType 에 적혀 있다(감사 요청에 각인된다).
    // 그게 없을 때만 이 요청의 엔진으로 되돌아간다. 예전에는 "claude_code 가 아니면 코덱스"
    // 였는데, Antigravity 가 감사한 건을 CodexBot 이 보완 요청하는 화면이 나왔다 —
    // 방장이 "코덱스가 작업한 걸로 나온다"고 지적한 그 자리다.
    const assigneeBotRole = reportBotRoleForAdapter(input.request.workerAdapterType ?? input.request.adapterType);
    const idempotencyKey = "telegram-revision-request:" + input.request.attemptId;
    const revisionBody = renderRevisionRequestText(taskId, requiredFixes, reverifyScope);

    // 보완 요청도 길면 잘라 보낸다. 이 경로가 미리보기를 안 거쳐서, 감사 보고는 301자로
    // 나가는데 바로 다음 메시지가 1,435자로 나가는 화면이 됐다.
    //
    // 전문은 같은 attempt 의 감사 보고 행을 그대로 쓴다(같은 판정에서 나온 글이다).
    // saveTaskReport 가 중복을 409 로 받아 이미 있는 행을 돌려준다.
    const revisionReport = await this.core.saveTaskReport(
      { ...input.request, reportBotRole: "auditor" },
      assigneeBotRole,
      revisionBody
    );
    const revisionPreview = buildRoomMessageWithPreview(revisionBody, roomMessagePreviewLimit());

    await this.core.insertOutboxIdempotently({
      event_id: event.event_id,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: assigneeBotRole, telegramChatId }),
      payload: {
        botRole: assigneeBotRole,
        messageThreadId: input.request.telegramMessageThreadId,
        telegramChatId,
        text: revisionPreview.text,
        keyboard: revisionPreview.truncated && revisionReport
          ? buildReportOpenKeyboard(revisionReport.report_id, this.core.miniAppDirectLinkBaseUrl)
          : undefined,
        binding: { kind: "task", taskId },
        idempotencyKey
      },
      room_id: input.request.roomId
    });
  }

  private async enqueueRevisionExecution(
    input: { request: ExecutionRequest; occurredAt: string },
    requiredFixes: string,
    reverifyScope: string,
    revisionRequestId: string,
    priorVerificationId: string | undefined,
    sourceEventId: string
  ): Promise<void> {
    const gatewayId = await this.core.fetchActiveGatewayId(input.request.roomId);
    if (!gatewayId) return;
    const adapterType = input.request.workerAdapterType ?? input.request.adapterType;
    const attemptId = input.request.attemptId + "-revision";
    const changedScope: "content" = "content";
    const executionRequest: ExecutionRequest = {
      ...input.request,
      attemptId,
      adapterType,
      reportBotRole: reportBotRoleForAdapter(adapterType),
      prompt: [
        "원 담당 작업자로서 검증 의견을 반영해 보완하세요.",
        "필수 수정: " + requiredFixes,
        "재검증 범위: " + reverifyScope,
        "검증 의견을 바꾸거나 무시하지 말고 실제 산출물을 수정한 뒤 결과를 제출하세요."
      ].join("\n"),
      idempotencyKey: "revision-execution:" + revisionRequestId,
      createdAt: input.occurredAt,
      revisionContext: {
        revisionRequestId,
        priorVerificationId,
        changedScope,
        reverifyScope
      }
    };

    await this.core.insertOutboxIdempotently({
      event_id: sourceEventId,
      idempotency_key: "gateway:revision:" + revisionRequestId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: { executionRequest },
      room_id: input.request.roomId
    });
  }
}
