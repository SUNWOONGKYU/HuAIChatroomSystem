// God file 분리(2026-08, 3차) — index.ts 의 SupabaseOutboxStore 에서 뽑아낸
// 리더 판단(!리더봇 지시) 결과 처리. 리더가 대화를 읽고 내린 판단(답변/무행동/제안)을
// 방에 올리고, mutatesFiles === false 인 제안은 자동 시작 승인까지 기록한다.
// SupabaseOutboxCore 를 주입받아 outbox/event idempotent 삽입 등 공통 원시 동작을 쓴다.
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";
import { buildMiniAppOpenKeyboard } from "../../telegram-ui/src/index.js";
import { parseLeaderDecision, type LeaderPlan } from "../../orchestrator/src/leader-planning.js";
import {
  renderLeaderPlanMessage,
  shortProposalId,
  rawStdoutFromGatewayEvents,
  sessionIdFromGatewayEvents
} from "./message-rendering.js";
import { extractAgentResultText } from "./gateway-report-rendering.js";
import { isUuid } from "./small-utils.js";
import { SupabaseOutboxCore } from "./outbox-core.js";

export class SupabaseLeaderPlanningStore {
  constructor(private readonly core: SupabaseOutboxCore) {}

  // 리더가 대화를 읽고 내린 판단을 방에 올린다.
  // 판단 실패는 조용히 넘기지 않는다 — 사람이 불렀는데 아무 반응이 없으면 시스템이 죽은 것처럼 보인다.
  async applyLeaderPlanningResult(
    input: { request: ExecutionRequest; status: "completed" | "failed" | "rejected"; events: GatewayEvent[] },
    telegramChatId: string,
    sourceEventId: string
  ): Promise<void> {
    await this.rememberLeaderSession(input.request.actorId, input.events);

    const idempotencyKey = "telegram-leader-plan:" + input.request.attemptId;
    // claude 는 --output-format json 으로 부른다(session_id 를 잡으려고, Task D 참고) —
    // 그러면 DECISION/TITLE/... 줄들이 stdout 최상위 줄바꿈이 아니라 JSON "result"
    // 문자열 안에 \n 으로 이스케이프된 채 갇힌다. extractAgentResultText 로 그 겉포장을
    // 먼저 벗겨야 parseLeaderDecision 의 줄 단위 파서가 DECISION: 을 찾을 수 있다.
    // 실전에서 이걸 빼먹어 "요청을 작업으로 정리하지 못했습니다"만 계속 나갔다(라이브 확인).
    const decision = input.status === "completed"
      ? parseLeaderDecision(extractAgentResultText(rawStdoutFromGatewayEvents(input.events)))
      : undefined;

    if (!decision) {
      await this.core.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
        payload: {
          botRole: "leader",
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
      await this.core.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
        payload: {
          botRole: "leader",
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
      await this.core.insertEventIdempotently({
        room_id: input.request.roomId,
        task_id: null,
        event_type: "proposal_rejected",
        idempotency_key: "leader-no-action:" + input.request.attemptId,
        payload: { stage: "leader_no_action", reason: decision.reason, attemptId: input.request.attemptId }
      });
      await this.core.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId }),
        payload: {
          botRole: "leader",
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
    // 변형이 없으면(기본, variantCount<=1) 지금까지와 똑같이 제안 1개. 변형이 있으면
    // "판단 1번 → 제안 N개" — 제안마다 독립된 승인·작업이다(기존 1제안=1작업 불변식을
    // 그대로 지킨다, 승인 증거 체인 AC-08도 안 건드린다). 유일한 새 정보는
    // useIsolatedWorktree 표식뿐 — 방장이 승인하면 그 작업은 공유 폴더가 아니라
    // 자기만의 git worktree 에서 돈다(huai_tasks.use_isolated_worktree, 아래 store 계층 참고).
    const variantCount = Math.max(1, plan.variantCount || 1);
    for (let variantIndex = 1; variantIndex <= variantCount; variantIndex += 1) {
      await this.emitLeaderProposal({
        request: input.request,
        telegramChatId,
        sourceEventId,
        idempotencyKey: variantCount > 1 ? `${idempotencyKey}:v${variantIndex}` : idempotencyKey,
        plan,
        variantIndex: variantCount > 1 ? variantIndex : undefined,
        variantCount: variantCount > 1 ? variantCount : undefined
      });
    }
  }

  private async emitLeaderProposal(input: {
    request: ExecutionRequest;
    telegramChatId: string;
    sourceEventId: string;
    idempotencyKey: string;
    plan: LeaderPlan;
    variantIndex?: number;
    variantCount?: number;
  }): Promise<void> {
    const plan = input.plan;
    const isVariant = Boolean(input.variantIndex && input.variantCount);
    const title = isVariant ? `${plan.title} (변형 ${input.variantIndex}/${input.variantCount})` : plan.title;
    // Telegram 콜백 데이터는 64바이트가 한계다.
    // "proposal:<id>:approve" 형태로 실려 나가므로 id 를 짧게 유지해야 한다.
    // 처음엔 attemptId 를 그대로 붙였다가 71바이트가 되어 BUTTON_DATA_INVALID 로 죽었다.
    const baseProposalId = shortProposalId(input.request.attemptId);
    const proposalId = isVariant ? `${baseProposalId}v${input.variantIndex}` : baseProposalId;
    await this.core.insertEventIdempotently({
      room_id: input.request.roomId,
      task_id: null,
      event_type: "proposal_created",
      idempotency_key: "leader-proposal:" + input.request.attemptId + (isVariant ? `:v${input.variantIndex}` : ""),
      payload: {
        proposalId,
        // 리더 판단은 방장이 말을 건 주제에서 시작됐다. 그 주제를 여기서 놓치면
        // 승인 뒤 만들어지는 작업이 어느 주제 것인지 알 길이 없어진다.
        messageThreadId: input.request.telegramMessageThreadId,
        title,
        purpose: plan.purpose,
        scope: plan.scope,
        completionCriteria: plan.completionCriteria,
        rawText: plan.scope,
        requestedActorRole: plan.assignee === "both" ? undefined : plan.assignee,
        intent: plan.assignee === "both" ? "multi_ai_review" : "new_task",
        assignee: plan.assignee,
        assigneeReason: plan.reason,
        stage: "leader_planned",
        useIsolatedWorktree: isVariant,
        createdAt: new Date().toISOString()
      }
    });

    await this.core.insertOutboxIdempotently({
      event_id: input.sourceEventId,
      idempotency_key: input.idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId: input.telegramChatId }),
      payload: {
        botRole: "leader",
        messageThreadId: input.request.telegramMessageThreadId,
        telegramChatId: input.telegramChatId,
        text: renderLeaderPlanMessage({ ...plan, title }) + (this.core.miniAppDirectLinkBaseUrl
          ? ""
          : "\n협업 운영센터 링크가 설정되지 않아 승인 UI가 비활성화되었습니다. 운영 담당자에게 BOT_SERVICE_MINIAPP_DIRECT_LINK 설정을 요청하세요."),
        keyboard: this.core.miniAppDirectLinkBaseUrl
           ? buildMiniAppOpenKeyboard({ directLinkBaseUrl: this.core.miniAppDirectLinkBaseUrl, roomId: input.request.roomId, messageThreadId: input.request.telegramMessageThreadId })
           : undefined,
        binding: { kind: "event", eventId: input.sourceEventId },
        idempotencyKey: input.idempotencyKey
      },
      room_id: input.request.roomId
    });

    // === false 엄격 비교 — 위 렌더 문구와 같은 이유(undefined 를 자동허용으로 착각 금지).
    if (plan.mutatesFiles === false) await this.autoAllowProposal(proposalId, input.request);
  }

  // Grok Bot 벤치마크 "승인 카테고리 분리(필수승인/자동허용)" 반영 — 2026-08-23.
  //
  // 방장의 실행 버튼 클릭 없이 시작을 승인한 것으로 기록만 남긴다. 실제 실행 큐잉은
  // 새로 만들지 않는다 — miniapp-decision-poller.ts 가 huai_approvals 를 이미 채널
  // 구분 없이(텔레그램 버튼이든 미니앱이든) 감시하다가 정확히 이 모양의 행을 만나면
  // applyMiniAppDecision 을 그대로 재생해 기존 승인 경로와 100% 같은 실행을 큐에 올린다.
  // 그 재생이 권한 검사(requiresOwner)도 그대로 통과해야 하므로, 요청자가 실제로
  // 시작 승인 권한이 없으면 이 행은 조용히 무시된다(skipped_unauthorized) — 승인 카테고리
  // 분리가 새 권한 상승 경로가 되지 않는다. 승인 버튼은 그대로 살려 둔다: 판단이
  // 틀렸거나(실제로는 파일을 바꿈) 권한이 없어 재생이 스킵된 경우의 유일한 대체 경로다.
  private async autoAllowProposal(proposalId: string, request: ExecutionRequest): Promise<void> {
    if (!request.requestedBy || request.requestedBy === "unknown") return;
    try {
      const response = await this.core.client.request("POST", "/huai_approvals", {
        body: {
          room_id: request.roomId,
          task_id: null,
          entity_ref: proposalId,
          stage: "task_approval",
          decision: "approved",
          decider_telegram_user_id: request.requestedBy,
          reason: "auto-allowed: 조회·분석·설명 등 파일을 바꾸지 않는 작업으로 판단됨",
          idempotency_key: "auto-allow:task_approval:" + proposalId
        },
        prefer: "return=minimal"
      });
      if (response.status !== 409) await response.expectOk();
    } catch (error) {
      // 자동허용은 부가 기능이다 — 실패해도 방금 올라간 제안 카드와 승인 버튼은 그대로
      // 살아있으니 방장이 평소처럼 눌러 시작할 수 있다. (saveTaskQuiz 와 같은 원칙.)
      console.error(JSON.stringify({
        type: "auto_allow_proposal_failed",
        proposalId,
        reason: maskSensitiveText(error instanceof Error ? error.message : String(error))
      }));
    }
  }

  // 다음 호출에서 --resume 으로 이어받도록 세션을 기억한다.
  private async rememberLeaderSession(actorId: string, events: readonly GatewayEvent[]): Promise<void> {
    if (!isUuid(actorId)) return;
    const sessionId = sessionIdFromGatewayEvents(events);
    if (!sessionId) return;
    await this.core.client
      .request("PATCH", "/huai_ai_actors?actor_id=eq." + encodeURIComponent(actorId), {
        body: { cli_session_id: sessionId, cli_session_updated_at: new Date().toISOString() },
        prefer: "return=minimal"
      })
      .then((response) => response.expectOk())
      .catch(() => undefined);
  }
}
