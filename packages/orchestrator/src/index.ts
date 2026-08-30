import {
  type AiAdapterType,
  type ExecutionRequest,
  type NormalizedTelegramInput,
  type OutboxTarget,
  type WorkflowEventName
} from "../../contracts/src/index.js";
// telegram-ui 의존은 의도적으로 유지한다: telegram-ui 는 fetch/네트워크/Telegram SDK 호출이
// 전혀 없는 순수 텍스트 템플릿 패키지(index.ts/sanitize.ts 두 파일뿐, I/O 없음)라 여기서 쓰는
// buildCommandHelp/buildWorkProposalMessage 도 문자열만 조립해 돌려준다. 표현 계층 오염이
// 아니라 supabase-runtime(message-rendering.ts 등)도 이미 같은 방식으로 쓰는 공용 메시지
// 렌더링 유틸 호출이며, eslint.config.js 의 패키지 경계 룰에서도 허용 대상으로 명시했다.
import { buildCommandHelp, buildWorkProposalMessage } from "../../telegram-ui/src/index.js";
import { classifyFreeformIntent } from "./intent-router.js";
// God module 분리(2026-08, 2차) — 결정(승인/검증/보완) → outbox 빌더는 decision-outbox.ts 로,
// 방장 전용 관리 명령(/newagent 등) 핸들러는 agent-commands.ts 로 옮겼다. applyMiniAppDecision
// 만 authorizeTelegramInput 의존 때문에 이 파일에 남긴다(아래 정의부 주석 참고).
import {
  buildCallbackAckOutbox,
  buildMiniAppDecisionOutbox,
  buildExecutionNotConfiguredOutbox,
  callbackActionToOwnerEvent,
  enqueueAuditExecutionIfConfigured,
  makeRoleMessageOutbox
} from "./decision-outbox.js";
import {
  createAgentPersonaFromTelegram,
  listAgentPersonasFromTelegram,
  inviteAiActorFromTelegram,
  checkAiActorHealthFromTelegram,
  registerRoomFromTelegram,
  requestPostCompletionChangeFromTelegram,
  manageRoomMemberFromTelegram
} from "./agent-commands.js";
import {
  deriveProposalStructure,
  routeProposalText,
  normalizeFreeformMessageText,
  extractReplyTargetId,
  hasAttachmentContext,
  isContinuationOnlyText,
  isContextDependentFixRequest,
  detectVagueActorDelegation,
  extractWorkItemId,
  renderAcknowledgementAnswer,
  renderInformationalAnswer,
  renderContinuationClarification,
  renderContextDependentFixClarification,
  renderActorDelegationClarification,
  hasRequiredPermission,
  requiresOwner,
  makeOutboxTargetForRole,
  summarizeTitle
} from "./input-classification.js";

export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "unauthorized_chat"
        | "unauthorized_user"
        | "owner_required"
        | "permission_required"
        | "bot_message_ignored";
    };

export type RoomAuthorizationContext = {
  memberships: readonly RoomMembership[];
};

export type RoomMembership = {
  telegramChatId: string;
  telegramUserId: string;
  role: "owner" | "human_member" | "leader" | "claude_leader" | "codex_leader" | "auditor" | "operator";
  permissions: readonly RoomPermission[];
  status: "active" | "invited" | "left" | "removed" | "suspended";
};

export type RoomPermission =
  | "task:create"
  | "task:read"
  | "task:approve"
  | "task:reject"
  | "task:verify"
  | "task:final_approve"
  | "task:cancel"
  | "bots:manage";

export type OrchestratorEvent = {
  eventType: WorkflowEventName;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

export type OrchestratorOutboxItem = {
  target: OutboxTarget;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

export type TelegramInputHandlingResult =
  | { accepted: false; authorization: AuthorizationDecision }
  | {
      accepted: true;
      authorization: AuthorizationDecision;
      events: OrchestratorEvent[];
      outbox: OrchestratorOutboxItem[];
    };

export type ExecutionRequestDefaults = {
  roomId: string;
  actorId: string;
  adapterType: AiAdapterType;
  projectPath: string;
  timeoutMs: number;
  gatewayId: string;
  promptForTask?: (taskId: string, input: NormalizedTelegramInput) => string;
};

export type TelegramInputHandlingPorts = {
  makeId(prefix: string): string;
  now(): string;
  executionDefaults?: ExecutionRequestDefaults;
  // Mini App 결정 폴러처럼 huai_approvals 원본 행을 "재생"하는 호출자를 위한 훅.
  // applyMiniAppDecision 이 만드는 승인 이벤트의 idempotencyKey 를 이 값으로 강제한다.
  // 원본 huai_approvals 행의 idempotency_key 를 그대로 넘기면, 재생이 만드는 이벤트가
  // recordApprovals 에서 원본과 같은 키로 INSERT 를 시도해 409 로 흡수되고(이미 그
  // 경로가 409 를 삼킨다 — supabase-store.ts:218-225 참고, 이 파일에서 손 안 댐)
  // huai_approvals 원장에는 결정당 1행만 남는다. 생략하면(undefined) 기존과 완전히
  // 동일하게 자동 생성된 키를 쓴다 — Telegram 경로는 이 필드를 전혀 쓰지 않으므로
  // 기존 동작이 한 글자도 안 바뀐다.
  approvalEventIdempotencyKey?: string;
};

export function authorizeTelegramInput(
  input: NormalizedTelegramInput,
  context: RoomAuthorizationContext
): AuthorizationDecision {
  const membership = context.memberships.find(
    (member) =>
      member.telegramChatId === input.envelope.telegramChatId &&
      member.telegramUserId === input.envelope.telegramUserId &&
      member.status === "active"
  );

  if (!membership) {
    return { allowed: false, reason: "unauthorized_chat" };
  }

  if (requiresOwner(input) && membership.role !== "owner") {
    return { allowed: false, reason: "owner_required" };
  }

  if (!hasRequiredPermission(input, membership)) {
    return { allowed: false, reason: "permission_required" };
  }

  return { allowed: true };
}

export function handleTelegramInput(
  input: NormalizedTelegramInput,
  context: RoomAuthorizationContext,
  ports: TelegramInputHandlingPorts
): TelegramInputHandlingResult {
  // 답은 물어본 자리로 돌아가야 한다.
  //
  // 포럼 그룹에서는 주제(topic)마다 대화가 따로 흐른다. 주제 번호를 안 실으면 답이 전부
  // General 로 떨어져, 방장이 지시한 주제에는 아무 반응이 없는 것처럼 보인다.
  //
  // 여기서 한 번에 얹는 이유: 아웃박스를 만드는 자리가 서른 곳 가까이 되고, 새 메시지를
  // 추가할 때마다 사람이 기억해서 붙여야 한다면 언젠가는 빠뜨린다. 그리고 빠뜨린 티가
  // 안 난다 — 메시지는 나가는데 엉뚱한 주제에 뜰 뿐이다.
  return attachMessageThread(routeTelegramInput(input, context, ports), input.envelope.messageThreadId);
}

function attachMessageThread(
  result: TelegramInputHandlingResult,
  messageThreadId: string | undefined
): TelegramInputHandlingResult {
  if (!messageThreadId || !result.accepted) return result;
  return {
    ...result,
    outbox: result.outbox.map((item) => {
      if (item.target.kind === "telegram_bot") {
        // 이미 실어둔 값이 있으면 그것을 쓰고, 없을 때만 채운다.
        // 순서를 반대로 쓰면 payload 에 있는 messageThreadId: undefined 가 이 값을 덮는다 —
        // 라이브에서 "작업을 시작했습니다" 한 줄만 General 로 떨어진 게 그 때문이었다.
        return { ...item, payload: { ...item.payload, messageThreadId: item.payload.messageThreadId ?? messageThreadId } };
      }
      // 게이트웨이로 가는 실행 요청에도 실어 둔다. 실행 보고·감사 결과는 몇 분 뒤에
      // 나가는데, 그때는 이 대화가 어느 주제에서 시작됐는지 알 길이 요청밖에 없다.
      const executionRequest = item.payload.executionRequest as ExecutionRequest | undefined;
      if (!executionRequest) return item;
      return {
        ...item,
        payload: {
          ...item.payload,
          executionRequest: {
            ...executionRequest,
            telegramMessageThreadId: executionRequest.telegramMessageThreadId ?? messageThreadId
          }
        }
      };
    })
  };
}

function routeTelegramInput(
  input: NormalizedTelegramInput,
  context: RoomAuthorizationContext,
  ports: TelegramInputHandlingPorts
): TelegramInputHandlingResult {
  const authorization = authorizeTelegramInput(input, context);
  if (!authorization.allowed) {
    return { accepted: false, authorization };
  }

  // 사람끼리의 대화는 맥락으로만 보관한다. 이벤트도 아웃박스도 만들지 않는다.
  // 리더가 나중에 호출됐을 때 이 대화들을 읽고 작업으로 재구성한다.
  if (input.kind === "observation") {
    return { accepted: true, authorization: { allowed: true }, events: [], outbox: [] };
  }

  if (input.kind === "message") {
    return routeFreeformMessage(input, ports);
  }

  if (input.kind === "command") {
    switch (input.command.name) {
      case "/newtask":
        return createProposalFromTelegram(input, ports);
      case "/tasks":
      case "/task":
      case "/search":
      case "/trace":
      case "/center":
      case "/help":
        return renderTelegramQuery(input);
      case "/approve":
      case "/reject":
      case "/done":
      case "/cancel":
      case "/verify":
        return renderOwnerActionRedirect(input);
      case "/newagent":
        return createAgentPersonaFromTelegram(input);
      case "/agents":
        return listAgentPersonasFromTelegram(input);
      case "/inviteai":
        return inviteAiActorFromTelegram(input);
      case "/aihealth":
        return checkAiActorHealthFromTelegram(input);
      case "/registerroom":
        return registerRoomFromTelegram(input);
      case "/change":
        return requestPostCompletionChangeFromTelegram(input);
      case "/member":
        return manageRoomMemberFromTelegram(input);
    }
  }

  return renderOwnerActionRedirect(input);
}

// 승인·통제는 협업 운영센터 단일 창구다. Telegram 명령/콜백은 업데이트와
// 감사 추적은 유지하되, 상태 전이·실행·취소 이벤트를 만들지 않고 안내만 보낸다.
// 실제 링크/키보드는 roomId를 알고 있는 Supabase store가 최종 hydration 단계에서 붙인다.
export function renderOwnerActionRedirect(
  input: Extract<NormalizedTelegramInput, { kind: "command" | "callback" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const targetId = input.kind === "command"
    ? input.command.args[0]
    : input.callback.entityId;
  const actionLabel = input.kind === "command" ? input.command.name : input.callback.action;
  const callbackQueryId = input.kind === "callback" ? input.envelope.callbackQueryId : undefined;
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [{
      target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
      idempotencyKey: `telegram:owner-action-redirect:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
      payload: {
        botRole: "leader",
        telegramChatId: input.envelope.telegramChatId,
        text: `방장 액션(${actionLabel}${targetId ? ` · ${targetId}` : ""})은 협업 운영센터에서만 처리합니다.`,
        ...(callbackQueryId ? { callbackQueryId } : {}),
        ownerActionRedirect: true,
        binding: { kind: "event", eventId: `owner-action-redirect:${input.envelope.updateId}` }
      }
    }]
  };
}

export function createProposalFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "message" | "command" }>,
  ports: TelegramInputHandlingPorts,
  overrideText?: string
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const proposalId = ports.makeId("proposal");
  const text = overrideText ?? (input.kind === "message" ? input.envelope.messageText ?? "" : input.command.args.join(" "));
  const routed = routeProposalText(input, text, overrideText !== undefined);
  const title = summarizeTitle(routed.text);
  const structure = deriveProposalStructure(routed.text, title);
  const event: OrchestratorEvent = {
    eventType: "proposal_created",
    idempotencyKey: `proposal:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
    payload: {
      proposalId,
      telegramChatId: input.envelope.telegramChatId,
      // 이 작업이 어느 주제에서 시작됐는지. 현황판을 주제별로 가르는 근거가 된다.
      messageThreadId: input.envelope.messageThreadId,
      telegramUserId: input.envelope.telegramUserId,
      sourceMessageId: input.envelope.telegramMessageId,
      title,
      purpose: structure.purpose,
      scope: structure.scope,
      completionCriteria: structure.completionCriteria,
      rawText: routed.text,
      intent: routed.intent,
      targetId: routed.targetId,
      requestedActorRole: routed.requestedActorRole,
      createdAt: ports.now()
    }
  };

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [event],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:proposal:${proposalId}`,
        payload: {
          text: buildWorkProposalMessage({ kind: routed.intent, title }),
          ownerActionRedirect: true,
          binding: { kind: "event", eventId: event.idempotencyKey }
        }
      }
    ]
  };
}

export function routeFreeformMessage(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>,
  ports: TelegramInputHandlingPorts
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const text = normalizeFreeformMessageText(input);
  const replyTargetId = extractReplyTargetId(input);
  if (isContinuationOnlyText(text)) {
    return replyTargetId
      ? createProposalFromTelegram(input, ports, `${replyTargetId} ${text}`)
      : renderContinuationClarification(input);
  }
  if (isContextDependentFixRequest(text)) {
    return replyTargetId
      ? createProposalFromTelegram(input, ports, `${replyTargetId} ${text}`)
      : hasAttachmentContext(input)
        ? createProposalFromTelegram(input, ports, `${text} 첨부: ${input.envelope.attachmentKinds.join(", ")}`)
        : renderContextDependentFixClarification(input);
  }
  // 알맹이 없는 위임("코덱스한테 시켜줘")은 판단을 돌릴 값이 없다. 먼저 되묻는다.
  const vagueDelegationRole = detectVagueActorDelegation(text, input);
  if (vagueDelegationRole) return renderActorDelegationClarification(input, vagueDelegationRole);
  if (input.envelope.telegramBotRole === "auditor") return createDirectAuditRequest(input, ports, text);

  // 인사·감사는 판단을 돌릴 값이 없다. 여기서만 끊는다.
  const freeformIntent = classifyFreeformIntent(text);
  if (freeformIntent === "acknowledgement") return renderAcknowledgementAnswer(input);

  // 질문인지 작업인지는 키워드 표가 아니라 리더가 가른다.
  // 예전에는 "정리해줘" 같은 단어 하나로 질문으로 분류돼 작업 지시가 리더에게 닿지 못했다.
  // 리더가 부름을 받으면 정규식으로 제목을 고르는 대신 실제로 판단하게 한다.
  // 방의 직전 논의를 읽고 목적·범위·완료조건·담당을 재구성한다.
  // 게이트웨이 경유라 기존 Claude/Codex 구독을 그대로 쓴다.
  if (input.envelope.telegramBotRole === "leader" && ports.executionDefaults) {
    return requestLeaderPlanning(input, ports, text);
  }

  // 리더 판단 경로가 없으면(게이트웨이 미설정 등) 기존 규칙 기반으로 떨어진다.
  if (freeformIntent === "informational_answer") return renderInformationalAnswer(input, text);
  return createProposalFromTelegram(input, ports);
}

// 리더 판단 요청. 실제 프롬프트는 저장소 계층에서 방의 대화를 읽어 채운다
// (오케스트레이터는 순수 함수라 DB 를 읽지 않는다).
export function requestLeaderPlanning(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>,
  ports: TelegramInputHandlingPorts,
  text: string
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const defaults = ports.executionDefaults;
  if (!defaults) return createProposalFromTelegram(input, ports);

  const planningId = ports.makeId("planning");
  const attemptId = `${LEADER_PLANNING_ATTEMPT_PREFIX}${planningId}`;
  // 기존 작업을 가리키는 후속 요청이면 그 연결을 잃지 않는다.
  const targetId = extractWorkItemId(text);
  const event: OrchestratorEvent = {
    eventType: "proposal_created",
    idempotencyKey: `leader-planning:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
    payload: {
      planningId,
      stage: "leader_planning_requested",
      telegramChatId: input.envelope.telegramChatId,
      telegramUserId: input.envelope.telegramUserId,
      triggeringText: text,
      targetId,
      intent: targetId ? "task_followup" : "new_task",
      createdAt: ports.now()
    }
  };

  const executionRequest: ExecutionRequest = {
    roomId: defaults.roomId,
    taskId: planningId,
    attemptId,
    actorId: defaults.actorId,
    requestedBy: input.envelope.telegramUserId ?? "unknown",
    adapterType: "claude_code",
    projectPath: defaults.projectPath,
    // 저장소 계층이 방의 직전 논의를 읽어 실제 판단 프롬프트로 교체한다.
    prompt: LEADER_PLANNING_PROMPT_PLACEHOLDER,
    timeoutMs: Math.min(defaults.timeoutMs, 300000),
    idempotencyKey: `leader-planning:${planningId}`,
    createdAt: ports.now(),
    reportBotRole: "leader"
  };

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [event],
    outbox: [
      {
        target: { kind: "local_gateway", gatewayId: defaults.gatewayId },
        idempotencyKey: `gateway:leader-planning:${planningId}`,
        payload: { executionRequest, telegramChatId: input.envelope.telegramChatId, triggeringText: text }
      },
      // 방장이 말을 걸면 바로 대답한다.
      //
      // 리더 판단은 CLI 를 한 번 돌리는 일이라 제안이 뜨기까지 수십 초가 걸린다. 그동안
      // 방에는 아무 말도 나가지 않았고, 방장은 봇이 죽은 줄 알고 다시 보내거나 기다렸다.
      // "입력 중" 표시는 화면 맨 위 작은 글씨라 그 자리를 대신하지 못한다.
      {
        target: { kind: "telegram_bot", botRole: "leader", telegramChatId: input.envelope.telegramChatId },
        idempotencyKey: `telegram:leader-planning-ack:${planningId}`,
        payload: {
          botRole: "leader",
          telegramChatId: input.envelope.telegramChatId,
          text: "📥 접수했습니다. 할 일을 정리하고 있습니다.",
          binding: { kind: "task", taskId: planningId },
          idempotencyKey: `telegram:leader-planning-ack:${planningId}`
        }
      }
    ]
  };
}

export const LEADER_PLANNING_ATTEMPT_PREFIX = "leader-planning-";
export const LEADER_PLANNING_PROMPT_PLACEHOLDER = "__LEADER_PLANNING__";

export function isLeaderPlanningAttempt(attemptId: string): boolean {
  return attemptId.startsWith(LEADER_PLANNING_ATTEMPT_PREFIX);
}

export function createDirectAuditRequest(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>,
  ports: TelegramInputHandlingPorts,
  requestText = normalizeFreeformMessageText(input)
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const auditRequestId = extractWorkItemId(requestText) ?? ports.makeId("audit");
  const title = summarizeTitle(requestText);
  const event: OrchestratorEvent = {
    eventType: "owner_verification_requested",
    idempotencyKey: `audit-request:${input.envelope.telegramBotId}:${input.envelope.updateId}:${auditRequestId}`,
    payload: {
      targetId: auditRequestId,
      telegramChatId: input.envelope.telegramChatId,
      telegramUserId: input.envelope.telegramUserId,
      sourceMessageId: input.envelope.telegramMessageId,
      rawText: requestText,
      requestedAt: ports.now()
    }
  };

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [event],
    outbox: ports.executionDefaults
      ? [
          makeRoleMessageOutbox({
            botRole: "auditor",
            telegramChatId: input.envelope.telegramChatId,
            idempotencyKey: `telegram:audit-request:${auditRequestId}:${input.envelope.updateId}`,
            text: `감사 요청을 접수했습니다: ${title}`,
            bindingId: `audit-request:${auditRequestId}:${input.envelope.updateId}`
          }),
          ...enqueueAuditExecutionIfConfigured(auditRequestId, "owner_verification_requested", input, ports, requestText)
        ]
      // 실행 기본값이 없는 방(A-5)에서는 "접수했습니다"를 보내봐야 실제로 아무 감사도
      // 돌지 않는다 — 거짓 안심이다. 접수 여부와 실제 실행 여부를 분리하지 않는다.
      : [buildExecutionNotConfiguredOutbox({ botRole: "auditor", entityId: auditRequestId, input })]
  };
}

// Telegram 경로에서는 사용하지 않는다. Mini App 승인 원장 폴러가 이미 기록된
// 결정을 실행 흐름으로 재생할 때만 호출하는 내부 호환 경로다.
export function applyMiniAppDecision(
  input: Extract<NormalizedTelegramInput, { kind: "callback" }>,
  context: RoomAuthorizationContext,
  ports: TelegramInputHandlingPorts
): TelegramInputHandlingResult {
  const authorization = authorizeTelegramInput(input, context);
  if (!authorization.allowed) return { accepted: false, authorization };
  const action = callbackActionToOwnerEvent(input.callback.action);
  const event: OrchestratorEvent = {
    eventType: action,
    idempotencyKey: ports.approvalEventIdempotencyKey ?? `${action}:${input.envelope.telegramBotId}:${input.envelope.updateId}:${input.callback.entityId}`,
    payload: {
      entity: input.callback.entity,
      entityId: input.callback.entityId,
      telegramChatId: input.envelope.telegramChatId,
      telegramUserId: input.envelope.telegramUserId,
      decidedAt: ports.now()
    }
  };

  const outbox = [
    ...buildCallbackAckOutbox(input),
    ...buildMiniAppDecisionOutbox(action, input.callback.entityId, input, ports, input.callback.reason)
  ];

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [event],
    outbox
  };
}

export function renderTelegramQuery(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const query = input.command.name === "/tasks"
    ? { kind: "tasks" as const, limit: 30 }
    : input.command.name === "/task"
      ? { kind: "task" as const, taskId: input.command.args[0] ?? "" }
      : input.command.name === "/search"
        ? { kind: "search" as const, term: input.command.args.join(" ") }
          : input.command.name === "/trace"
            ? { kind: "trace" as const, taskId: input.command.args[0] ?? "" }
            : input.command.name === "/center"
              ? { kind: "center" as const }
              : undefined;
  const text =
    input.command.name === "/help"
      ? buildCommandHelp()
      : input.command.name === "/tasks"
        ? "작업 목록 조회 요청을 접수했습니다."
        : input.command.name === "/search"
          ? `작업 검색 요청을 접수했습니다: ${input.command.args.join(" ")}`
          : input.command.name === "/trace"
            ? `작업 이력 조회 요청을 접수했습니다: ${input.command.args[0] ?? ""}`
            : input.command.name === "/center"
              ? "협업 운영센터를 여는 링크를 준비했습니다."
              : `작업 상세 조회 요청을 접수했습니다: ${input.command.args[0] ?? ""}`;
  const payload: Record<string, unknown> = {
    text,
    binding: { kind: "event", eventId: `query:${input.envelope.updateId}` }
  };
  if (query) payload.query = query;

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:query:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload
      }
    ]
  };
}

// ─────────────────────────────────────────────────────────────────────────
// God module 분리(2026-08) — 아래는 원래 이 파일에 있던 export 를 그대로 유지하기
// 위한 배럴 재수출이다. 실제 정의는 input-classification.ts 로 옮겨졌다. 외부
// import 경로는 하나도 바뀌지 않는다.
// ─────────────────────────────────────────────────────────────────────────
export {
  type ProposalStructure,
  deriveProposalStructure,
  chooseOutboundBotForEvent,
  makeOutboxTargetForRole
} from "./input-classification.js";

// God module 분리(2026-08, 2차) — enqueueExecutionAfterApproval 은 decision-outbox.ts 로
// 옮겼지만 이 파일의 다른 코드가 값으로 쓰지 않으므로(오직 buildMiniAppDecisionOutbox 내부
// 호출만 있었고 그 함수도 함께 옮겨졌다) re-export 로만 외부 경로를 유지한다. 나머지
// 관리 명령 핸들러(createAgentPersonaFromTelegram 등)는 routeTelegramInput 이 값으로
// 계속 호출하므로 위에서 이미 import 했고, 여기서 동일하게 재수출해 외부 import 경로
// (orchestrator/src/index.js)를 그대로 유지한다.
export { enqueueExecutionAfterApproval } from "./decision-outbox.js";
export {
  createAgentPersonaFromTelegram,
  listAgentPersonasFromTelegram,
  inviteAiActorFromTelegram,
  checkAiActorHealthFromTelegram,
  registerRoomFromTelegram,
  requestPostCompletionChangeFromTelegram,
  manageRoomMemberFromTelegram
} from "./agent-commands.js";
