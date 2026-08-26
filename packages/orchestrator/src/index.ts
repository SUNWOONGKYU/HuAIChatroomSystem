import {
  type AiAdapterType,
  type ExecutionRequest,
  type NormalizedTelegramInput,
  type OutboxTarget,
  type TelegramCallbackAction,
  type TelegramBotRole,
  type WorkflowEventName
} from "../../contracts/src/index.js";
import { buildCommandHelp, buildCompletionKeyboard, buildProposalKeyboard, buildWorkProposalMessage } from "../../telegram-ui/src/index.js";
import { buildAcknowledgementAnswerText, buildInformationalAnswerText, classifyFreeformIntent } from "./intent-router.js";

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
  // applyOwnerCallback 이 만드는 승인 이벤트의 idempotencyKey 를 이 값으로 강제한다.
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
      case "/help":
        return renderTelegramQuery(input);
      case "/approve":
      case "/reject":
      case "/done":
      case "/cancel":
      case "/verify":
        return applyOwnerTaskCommand(input, ports);
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

  return applyOwnerCallback(input, ports);
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
          keyboard: buildProposalKeyboard(proposalId),
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

export function applyOwnerTaskCommand(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>,
  ports: TelegramInputHandlingPorts
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const targetId = input.command.args[0] ?? "";
  if (!isOwnerCommandName(input.command.name)) {
    throw new Error("not-owner-command");
  }
  const action = commandNameToOwnerAction(input.command.name);
  const event: OrchestratorEvent = {
    eventType: action,
    idempotencyKey: `${action}:${input.envelope.telegramBotId}:${input.envelope.updateId}:${targetId}`,
    payload: {
      targetId,
      telegramChatId: input.envelope.telegramChatId,
      telegramUserId: input.envelope.telegramUserId,
      decidedAt: ports.now()
    }
  };

  const outbox = buildOwnerActionOutbox(action, targetId, input, ports);

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [event],
    outbox
  };
}

export function applyOwnerCallback(
  input: Extract<NormalizedTelegramInput, { kind: "callback" }>,
  ports: TelegramInputHandlingPorts
): Extract<TelegramInputHandlingResult, { accepted: true }> {
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
    ...buildOwnerActionOutbox(action, input.callback.entityId, input, ports, input.callback.reason)
  ];

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [event],
    outbox
  };
}

function buildCallbackAckOutbox(
  input: Extract<NormalizedTelegramInput, { kind: "callback" }>
): OrchestratorOutboxItem[] {
  if (!input.envelope.callbackQueryId) return [];
  return [
    {
      target: makeOutboxTargetForRole(input.envelope.telegramBotRole, input.envelope.telegramChatId),
      idempotencyKey: `telegram:callback-ack:${input.envelope.callbackQueryId}`,
      payload: {
        callbackQueryId: input.envelope.callbackQueryId,
        text: "접수했습니다."
      }
    }
  ];
}
export function buildOwnerActionOutbox(
  action: WorkflowEventName,
  taskOrProposalId: string,
  input: NormalizedTelegramInput,
  ports: TelegramInputHandlingPorts,
  // Mini App [보완 요청] 사유. 이 함수는 콜백 경로(applyOwnerCallback)와 커맨드 경로
  // (applyOwnerTaskCommand) 양쪽에서 호출되는데, NormalizedTelegramInput 은 kind==="command"
  // 일 땐 callback 필드 자체가 없어 input 에서 꺼낼 수 없다 — 그래서 호출자가 명시적으로
  // 넘긴다. 커맨드 경로는 항상 undefined 를 넘긴다(사유를 실을 수 없는 창구).
  reason?: string
): OrchestratorOutboxItem[] {
  if (action === "owner_task_approved") {
    // 실행 기본값이 없는 방(A-5)에서 승인이 오면 enqueueExecutionAfterApproval 이
    // missing-execution-defaults 를 던져 이 함수 전체가 예외로 끊겼다 — "작업 실행을
    // 시작했습니다"조차 못 나가고 방에는 아무 반응도 없었다. 여기서 먼저 걸러
    // 사용자에게 보이는 안내로 바꾼다(검증 경로와 동일한 방식 — 아래 참고).
    if (!ports.executionDefaults) {
      return [buildExecutionNotConfiguredOutbox({ botRole: "leader", entityId: taskOrProposalId, input })];
    }
    return [
      ...makeCallbackAcknowledgedEdit({
        botRole: "leader",
        text: "⚙️ 작업 중입니다. 작업자를 배정했습니다.",
        entityId: taskOrProposalId,
        envelope: input.envelope,
        kind: "execution-started"
      }),
      makeRoleMessageOutbox({
        botRole: "leader",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:execution-started:${taskOrProposalId}:${input.envelope.updateId}`,
        text: `작업 실행을 시작했습니다: ${taskOrProposalId}\n필요한 AI 작업자를 배정했습니다. 결과가 나오면 보고하겠습니다.`,
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `execution-started:${taskOrProposalId}:${input.envelope.updateId}`
      }),
      enqueueExecutionAfterApproval(taskOrProposalId, input, ports)
    ];
  }
  if (action === "owner_mid_approved" || action === "owner_mid_rejected") {
    const messages = [makeRoleMessageOutbox({
      botRole: "leader",
      telegramChatId: input.envelope.telegramChatId,
      idempotencyKey: `telegram:mid-decision:${taskOrProposalId}:${input.envelope.updateId}`,
      text: action === "owner_mid_approved"
        ? `중간 승인을 확인했습니다: ${taskOrProposalId}\n해당 작업 흐름을 계속할 수 있습니다.`
        : `중간 결과를 반려했습니다: ${taskOrProposalId}\n해당 작업 흐름은 중단 상태로 유지됩니다.`,
      callbackQueryId: input.envelope.callbackQueryId,
      bindingId: `mid-decision:${taskOrProposalId}:${input.envelope.updateId}`
    })];
    if (action === "owner_mid_approved") {
      if (!ports.executionDefaults) {
        messages.push(buildExecutionNotConfiguredOutbox({ botRole: "leader", entityId: taskOrProposalId, input }));
      } else {
        messages.push(enqueueMidApprovalContinuation(taskOrProposalId, input, ports));
      }
    }
    return messages;
  }
  if (action === "owner_verification_requested" || action === "owner_reverification_requested") {
    // 실행 기본값이 없으면 enqueueAuditExecutionIfConfigured 는 조용히 []를 반환한다.
    // 그런데 위 코드는 "검증 요청: ..."을 무조건 먼저 보냈다 — 사용자는 검증이 접수된
    // 줄 알지만 실제로는 아무 감사도 돌지 않는다(거짓 안심, 승인 경로의 무응답보다 나쁘다).
    // 두 경로가 같은 방식으로 동작하도록 여기서도 먼저 걸러낸다.
    if (!ports.executionDefaults) {
      return [buildExecutionNotConfiguredOutbox({ botRole: "auditor", entityId: taskOrProposalId, input })];
    }
    return [
      makeRoleMessageOutbox({
        botRole: "auditor",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:verification:${taskOrProposalId}:${input.envelope.updateId}`,
        text: action === "owner_reverification_requested"
          ? `재검증 요청: ${taskOrProposalId}`
          : `검증 요청: ${taskOrProposalId}`,
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `verification:${taskOrProposalId}:${input.envelope.updateId}`
      }),
      ...enqueueAuditExecutionIfConfigured(taskOrProposalId, action, input, ports)
    ];
  }  if (action === "owner_final_approved") {
    return [
      makeRoleMessageOutbox({
        botRole: "leader",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:final-approved:${taskOrProposalId}:${input.envelope.updateId}`,
        text: `승인 완료: ${taskOrProposalId}`,
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `final-approved:${taskOrProposalId}:${input.envelope.updateId}`,
        binding: { kind: "task", taskId: taskOrProposalId }
      })
    ];
  }
  if (action === "owner_supplement_requested") {
    return [
      makeRoleMessageOutbox({
        botRole: "leader",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:supplement-requested:${taskOrProposalId}:${input.envelope.updateId}`,
        // 완료·보완 결정은 작업 현황판에서 한다. 방에 버튼을 다시 붙이면 결정 창구가
        // 둘로 갈라지고, 대화 공간도 버튼 줄로 계속 잠식된다. 사유는 이제 방 메시지에도
        // 실린다(Mini App 사유 입력란 → huai_approvals.reason → 여기) — 버튼만 눌러서는
        // 아무것도 전달되지 않던 예전 상태를 고친 것이다.
        text: buildSupplementRequestedText(taskOrProposalId, reason),
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `supplement-requested:${taskOrProposalId}:${input.envelope.updateId}`
      })
    ];
  }
  return [];
}

// 방 메시지 한 줄 안에 사유를 다 욱여넣지 않는다 — 텔레그램 메시지 자체 상한(4096자)엔
// 여유가 있지만(reason 은 miniapp-approve 핸들러에서 이미 2000자로 잘려 들어온다), 방은
// 여러 작업이 오가는 공용 대화창이라 너무 긴 사유 하나가 화면을 다 채우면 다른 알림을
// 밀어낸다. 여기서 한 번 더, 훑어볼 수 있는 길이로 자르고 잘렸다는 사실을 명시한다.
const SUPPLEMENT_REASON_DISPLAY_MAX = 500;

function buildSupplementRequestedText(taskOrProposalId: string, reason: string | undefined): string {
  const base = `보완 요청: ${taskOrProposalId}`;
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    // 사유 없이 들어온 결정(구버전 Mini App, 또는 사유 없이도 보낼 수 있었던 과거 호출부와의
    // 하위호환)은 예전 문구를 그대로 유지한다.
    return `${base}\n이후 결정은 고정된 작업 현황판에서 진행해 주세요.`;
  }
  const truncated = trimmedReason.length > SUPPLEMENT_REASON_DISPLAY_MAX;
  const shown = truncated ? `${trimmedReason.slice(0, SUPPLEMENT_REASON_DISPLAY_MAX)}…` : trimmedReason;
  return `${base}\n사유: ${shown}${truncated ? " (길어서 잘렸습니다 — 전체는 작업 현황판에서 확인하세요)" : ""}\n이후 결정은 고정된 작업 현황판에서 진행해 주세요.`;
}

export function enqueueExecutionAfterApproval(
  taskOrProposalId: string,
  input: NormalizedTelegramInput,
  ports: TelegramInputHandlingPorts
): OrchestratorOutboxItem {
  const defaults = ports.executionDefaults;
  if (!defaults) {
    throw new Error("missing-execution-defaults");
  }
  const attemptId = ports.makeId("attempt");
  const executionRequest: ExecutionRequest = {
    roomId: defaults.roomId,
    taskId: taskOrProposalId,
    attemptId,
    actorId: defaults.actorId,
    requestedBy: input.envelope.telegramUserId ?? "unknown",
    adapterType: defaults.adapterType,
    projectPath: defaults.projectPath,
    prompt: defaults.promptForTask?.(taskOrProposalId, input) ?? `Execute approved task ${taskOrProposalId}`,
    timeoutMs: defaults.timeoutMs,
    idempotencyKey: `execution:${taskOrProposalId}:${attemptId}`,
    createdAt: ports.now()
  };

  return {
    target: { kind: "local_gateway", gatewayId: defaults.gatewayId },
    // 결정(entityId) 단위로 멱등 — updateId(클릭마다 새로 발급됨)를 넣으면 같은 승인을
    // 두 번 눌러도 서로 다른 키가 나와 CLI가 두 번 실행된다. 승인은 이 시스템 설계상
    // 같은 entityId 에 대해 한 번만 일어난다: 수정(revise) 요청이 오면 항상 새
    // proposalId 를 새로 발급하지, 같은 id 를 재승인하도록 돌려보내지 않는다
    // (createProposalFromTelegram/routeFreeformMessage 의 후속 제안 경로 참고).
    // updateId 를 빼면 채널(Telegram 버튼 vs Mini App 탭)과도 무관해져 두 창구에서
    // 들어온 같은 결정도 huai_outbox 의 idempotency_key unique 제약으로 하나로 합쳐진다.
    idempotencyKey: `gateway:execution:${taskOrProposalId}`,
    payload: { executionRequest }
  };
}

function enqueueMidApprovalContinuation(
  taskId: string,
  input: NormalizedTelegramInput,
  ports: TelegramInputHandlingPorts
): OrchestratorOutboxItem {
  const defaults = ports.executionDefaults;
  if (!defaults) throw new Error("missing-execution-defaults");
  const attemptId = ports.makeId("mid-continuation");
  const executionRequest: ExecutionRequest = {
    roomId: defaults.roomId,
    taskId,
    attemptId,
    actorId: defaults.actorId,
    requestedBy: input.envelope.telegramUserId ?? "unknown",
    adapterType: defaults.adapterType,
    projectPath: defaults.projectPath,
    prompt: `방장이 중간 결과를 승인했습니다. 작업 ${taskId}의 승인된 체크포인트 다음 단계부터 계속 실행하세요.`,
    timeoutMs: defaults.timeoutMs,
    idempotencyKey: `mid-continuation:${taskId}:${attemptId}`,
    createdAt: ports.now(),
    telegramMessageThreadId: input.envelope.messageThreadId
  };
  return {
    target: { kind: "local_gateway", gatewayId: defaults.gatewayId },
    idempotencyKey: `gateway:mid-continuation:${taskId}:${decisionRoundKey(input)}`,
    payload: { executionRequest }
  };
}

// 실행 기본값(actor/gateway/project path)이 없는 방은 승인·검증을 실제로 실행할 수
// 없다. 예외를 던지거나(승인) 성공 메시지를 먼저 보내고 조용히 아무 것도 안 하는 것
// (검증) 둘 다 사용자에게 진짜 상태를 숨긴다 — 이 함수 하나로 통일해 "지금은 실행할
// 수 없다"는 사실과 그게 설정 문제라는 것을 명시적으로 알린다. 내부 에러 코드
// (missing-execution-defaults 등)는 노출하지 않는다.
function buildExecutionNotConfiguredOutbox(input: {
  botRole: TelegramBotRole;
  entityId: string;
  input: NormalizedTelegramInput;
}): OrchestratorOutboxItem {
  return makeRoleMessageOutbox({
    botRole: input.botRole,
    telegramChatId: input.input.envelope.telegramChatId,
    idempotencyKey: `telegram:execution-not-configured:${input.entityId}:${input.input.envelope.updateId}`,
    text: `${input.entityId}에 대한 요청을 받았지만 이 방은 아직 실행 준비가 되지 않았습니다.\n담당 AI 실행 설정(프로젝트 경로·게이트웨이 등)이 끝나야 승인·검증을 실제로 실행할 수 있습니다. 방 관리자에게 실행 설정을 요청해 주세요.`,
    callbackQueryId: input.input.envelope.callbackQueryId,
    bindingId: `execution-not-configured:${input.entityId}:${input.input.envelope.updateId}`
  });
}

function makeRoleMessageOutbox(input: {
  botRole: TelegramBotRole;
  telegramChatId: string;
  // 포럼 주제 번호. 안 실으면 답이 General 로 떨어져 지시한 주제는 조용해 보인다.
  messageThreadId?: string;
  idempotencyKey: string;
  text: string;
  bindingId: string;
  binding?: { kind: "task"; taskId: string } | { kind: "event"; eventId: string };
  callbackQueryId?: string;
  keyboard?: unknown;
  editMessageId?: string;
}): OrchestratorOutboxItem {
  return {
    target: makeOutboxTargetForRole(input.botRole, input.telegramChatId),
    idempotencyKey: input.idempotencyKey,
    payload: {
      text: input.text,
      keyboard: input.keyboard,
      callbackQueryId: input.callbackQueryId,
      editMessageId: input.editMessageId,
      messageThreadId: input.messageThreadId,
      binding: input.binding ?? { kind: "event", eventId: input.bindingId }
    }
  };
}

// 버튼을 누른 그 메시지를 "실행 중"으로 바꾸고 버튼을 걷는다.
//
// 왜 필요한가: 누른 직후 방장에게 보이는 변화가 없었다. 접수 안내는
// answerCallbackQuery 토스트로 나가는데 안드로이드에서 잠깐 떴다 사라져 놓치기 쉽고,
// 뒤이어 오는 "작업 실행을 시작했습니다"는 새 메시지라 화면 아래에 조용히 쌓인다.
// 그래서 방장은 눌렀는데 먹통인지 도는지 알 수 없었다(라이브에서 반복 제기됨).
//
// 방금 만진 메시지가 눈앞에서 바뀌는 건 놓칠 수 없다. 버튼이 같이 사라지므로
// 두 번 누르는 것도 자연스럽게 막힌다.
//
// keyboard 를 생략하지 않고 빈 키보드를 명시한다 — 생략하면 편집 요청에서
// reply_markup 키 자체가 빠져 기존 버튼이 남을 수 있다.
function makeCallbackAcknowledgedEdit(input: {
  botRole: TelegramBotRole;
  text: string;
  entityId: string;
  envelope: NormalizedTelegramInput["envelope"];
  kind: string;
}): OrchestratorOutboxItem[] {
  const editMessageId = input.envelope.telegramMessageId;
  // 콜백이 아닌 경로(/approve 같은 명령)로 들어오면 고칠 메시지가 없다.
  if (!editMessageId || !input.envelope.callbackData) return [];
  return [
    makeRoleMessageOutbox({
      botRole: input.botRole,
      telegramChatId: input.envelope.telegramChatId,
      messageThreadId: input.envelope.messageThreadId,
      idempotencyKey: `telegram:${input.kind}-ack:${input.entityId}:${input.envelope.updateId}`,
      text: input.text,
      editMessageId,
      keyboard: { inline_keyboard: [] },
      bindingId: `${input.kind}-ack:${input.entityId}:${input.envelope.updateId}`
    })
  ];
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

const AGENT_PERSONA_NAME_PATTERN = /^[A-Za-z0-9가-힣_-]{1,32}$/;
const AGENT_PERSONA_BASE_ROLES = ["claude_leader", "codex_leader"] as const;

// 텔레그램은 봇 API로 새 봇 계정을 못 만든다 — 그래서 "새 에이전트"는 기존 실행 담당
// 봇(claude_leader/codex_leader) 위에 얹는 이름 붙은 페르소나로 구현한다. 실제 DB 기록은
// store 계층(hydrateAgentPersonaRows)이 담당한다 — 여기서는 명령을 outbox payload 에
// 표식(agentPersonaCommand)으로만 실어 보낸다(오케스트레이터는 DB 를 안 읽는다).
export function createAgentPersonaFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const [personaName, baseRole, ...rest] = input.command.args;
  const instructions = rest.join(" ").trim();
  const usage = "사용법: /newagent <이름> <claude_leader 또는 codex_leader> <이 페르소나가 할 일>";

  const idempotencyKey = `telegram:newagent:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  const target = makeOutboxTargetForRole("leader", input.envelope.telegramChatId);

  const validName = Boolean(personaName) && AGENT_PERSONA_NAME_PATTERN.test(personaName);
  const validRole = (AGENT_PERSONA_BASE_ROLES as readonly string[]).includes(baseRole ?? "");

  if (!validName || !validRole || !instructions) {
    return {
      accepted: true,
      authorization: { allowed: true },
      events: [],
      outbox: [
        {
          target,
          idempotencyKey,
          payload: { text: usage, binding: { kind: "event", eventId: idempotencyKey } }
        }
      ]
    };
  }

  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target,
        idempotencyKey,
        payload: {
          text: "페르소나 등록 처리 중…",
          binding: { kind: "event", eventId: idempotencyKey },
          agentPersonaCommand: {
            action: "create",
            personaName,
            baseRole,
            instructions,
            createdByTelegramUserId: input.envelope.telegramUserId
          }
        }
      }
    ]
  };
}

export function listAgentPersonasFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const idempotencyKey = `telegram:agents:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey,
        payload: {
          text: "등록된 페르소나 조회 중…",
          binding: { kind: "event", eventId: idempotencyKey },
          agentPersonaCommand: { action: "list" }
        }
      }
    ]
  };
}

export function inviteAiActorFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const [role, adapterType] = input.command.args;
  const validRoles = ["leader", "claude_leader", "codex_leader", "auditor"];
  const adapters: Record<string, string> = {
    leader: "orchestrator",
    claude_leader: "claude_code",
    codex_leader: "codex",
    auditor: "auditor"
  };
  const normalizedRole = role ?? "";
  const normalizedAdapter = adapterType || adapters[normalizedRole];
  const key = `telegram:invite-ai:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  if (!validRoles.includes(normalizedRole) || !normalizedAdapter) {
    return { accepted: true, authorization: { allowed: true }, events: [], outbox: [{
      target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
      idempotencyKey: key,
      payload: { text: "사용법: /inviteai <leader|claude_leader|codex_leader|auditor> [adapter_type]", binding: { kind: "event", eventId: key } }
    }] };
  }
  return { accepted: true, authorization: { allowed: true }, events: [], outbox: [{
    target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
    idempotencyKey: key,
    payload: {
      text: "전문 AI 초대를 처리 중…",
      binding: { kind: "event", eventId: key },
      aiActorCommand: { action: "invite", role: normalizedRole, adapterType: normalizedAdapter }
    }
  }] };
}

export function checkAiActorHealthFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const key = `telegram:ai-health:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  return { accepted: true, authorization: { allowed: true }, events: [], outbox: [{
    target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
    idempotencyKey: key,
    payload: {
      text: "전문 AI 사용 상태를 확인 중…",
      binding: { kind: "event", eventId: key },
      aiActorCommand: { action: "check" }
    }
  }] };
}

export function registerRoomFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const key = `telegram:register-room:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  return { accepted: true, authorization: { allowed: true }, events: [], outbox: [{
    target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
    idempotencyKey: key,
    payload: {
      text: "프로젝트 채팅룸 등록을 처리 중…",
      binding: { kind: "event", eventId: key },
      roomCommand: { action: "register", telegramChatId: input.envelope.telegramChatId, ownerTelegramUserId: input.envelope.telegramUserId }
    }
  }] };
}

export function requestPostCompletionChangeFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const [taskId, ...scopeParts] = input.command.args;
  const scope = scopeParts.join(" ").trim();
  const key = `telegram:post-completion-change:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  const valid = Boolean(taskId && scope);
  return {
    accepted: true,
    authorization: { allowed: true },
    events: valid ? [{
      eventType: scope.includes("범위") || scope.toLowerCase().includes("scope") ? "post_completion_scope_change_requested" : "post_completion_minor_change_requested",
      idempotencyKey: key + ":event",
      payload: { taskId, scope, telegramChatId: input.envelope.telegramChatId }
    }] : [],
    outbox: [{
      target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
      idempotencyKey: key,
      payload: { text: valid ? "완료 후 변경 요청을 기록했습니다. 새 작업 카드 승인 대기로 분기합니다." : "사용법: /change <task_id> <변경 내용>", binding: { kind: "event", eventId: key } }
    }]
  };
}

export function manageRoomMemberFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const [telegramUserId, action = "add"] = input.command.args;
  const validAction = action === "add" || action === "leave";
  const valid = Boolean(telegramUserId && /^-?\d+$/.test(telegramUserId) && validAction);
  const key = `telegram:member:${input.envelope.telegramBotId}:${input.envelope.updateId}`;
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [{
      target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
      idempotencyKey: key,
      payload: {
        text: valid ? "참여자 변경을 처리 중…" : "사용법: /member <telegram_user_id> <add|leave>",
        binding: { kind: "event", eventId: key },
        ...(valid ? { roomMemberCommand: { action, telegramUserId } } : {})
      }
    }]
  };
}


type RoutedProposalText = {
  text: string;
  intent: "new_task" | "task_followup" | "multi_ai_review";
  targetId?: string;
  requestedActorRole?: "claude_leader" | "codex_leader";
};

export type ProposalStructure = {
  purpose: string;
  scope: string;
  completionCriteria: string;
};

// 기획서 FR-007 은 제안이 "목적·범위·완료 조건"으로 구조화될 것을 요구한다.
// 완료 조건은 특히 중요하다 — 검증자가 무엇을 기준으로 합격/불합격을 판정할지가 여기서 정해진다.
// 완료 조건 없이 재검증 루프를 얹으면 검증이 형식이 된다.
//
// 이 계층에는 LLM 이 없으므로 결정론적 규칙으로 뽑는다.
// 요청자가 완료 조건을 직접 말했으면 그대로 쓰고, 아니면 요청 종류에서 도출한다.
export function deriveProposalStructure(text: string, title: string): ProposalStructure {
  const normalized = text.trim();
  return {
    purpose: derivePurpose(normalized, title),
    scope: normalized || title,
    completionCriteria: deriveCompletionCriteria(normalized)
  };
}

function derivePurpose(text: string, title: string): string {
  // "~하기 위해", "~하려고", "~할 수 있도록" 처럼 목적을 직접 말한 경우 그 절을 쓴다.
  const stated = text.match(/([^.!?\n]{4,80}?)(?:하기\s*위해|하기\s*위하여|하려고|할\s*수\s*있도록|하도록)/);
  if (stated?.[1]) return `${stated[1].trim()}하기 위해`;
  const firstSentence = text.split(/[.!?\n]/).map((part) => part.trim()).find((part) => part.length >= 4);
  return firstSentence && firstSentence !== title ? firstSentence : title;
}

function deriveCompletionCriteria(text: string): string {
  // 1) 요청자가 완료 조건을 직접 말한 경우 — 표현을 바꾸지 않고 그대로 살린다.
  const stated = text.match(/([^.!?\n]{4,120}?(?:하면|되면|지면|까지)\s*(?:완료|끝|done))/i);
  if (stated?.[1]) return `${stated[1].trim()}로 본다.`;
  if (/테스트\s*(?:가\s*)?통과|빌드\s*(?:가\s*)?통과|검증\s*통과/.test(text)) {
    return "관련 테스트와 빌드가 통과하고 결과가 보고된다.";
  }

  // 2) 요청 종류에서 도출
  if (/오류|버그|안\s*되|안됨|장애|실패|고쳐|수정해/.test(text)) {
    return "보고된 증상이 재현되지 않고, 원인과 조치 내용이 근거와 함께 보고된다.";
  }
  if (/조사|분석|원인|파악|알아봐|확인해/.test(text)) {
    return "조사 결과와 근거가 보고되고, 후속 조치 필요 여부가 명시된다.";
  }
  if (/문서|정리|작성|기록/.test(text)) {
    return "요청한 문서가 생성·갱신되고 위치와 변경 요지가 보고된다.";
  }
  if (/검토|리뷰|의견|평가|개선할\s*사항|보완점/.test(text)) {
    return "검토 결과가 항목별 근거와 함께 정리되어 보고된다.";
  }
  if (/구현|추가|만들|기능/.test(text)) {
    return "요청한 동작이 실제로 실행되어 확인되고, 사용 방법이 보고된다.";
  }
  return "요청 내용이 실제로 수행되어 결과가 확인 가능한 형태로 보고된다.";
}

function routeProposalText(
  input: Extract<NormalizedTelegramInput, { kind: "message" | "command" }>,
  originalText: string,
  useOriginalText = false
): RoutedProposalText {
  const text = useOriginalText ? originalText.trim() : input.kind === "message" ? normalizeFreeformMessageText(input) : originalText.trim();
  const targetId = extractWorkItemId(text);
  const intent = isMultiAiReviewRequest(text)
    ? "multi_ai_review"
    : targetId ? "task_followup" : "new_task";
  const requestedActorRole = detectRequestedExecutionActorRole(originalText, input);
  return { text, intent, targetId, requestedActorRole };
}

function isMultiAiReviewRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsClaude = /@claude_chatroom1_bot\b/i.test(text) || /@claude_chatroom_bot\b/i.test(text) || /\bclaude\b/.test(normalized) || normalized.includes("claudebot") || normalized.includes("클로드");
  const mentionsCodex = /@codex_chatroom_bot\b/i.test(text) || /\bcodex\b/.test(normalized) || normalized.includes("codexbot") || normalized.includes("코덱스");
  const mentionsAudit = /@audit_chatroom_bot\b/i.test(text) || normalized.includes("auditbot") || normalized.includes("오딧") || normalized.includes("감사") || normalized.includes("검증");
  const asksForComparison = ["각각", "비교", "토론", "의견", "결론", "평가", "논의", "협의", "같이"].some((word) => normalized.includes(word));
  const asksForSystemImprovementReview = ["추가로 개선할 사항", "개선할 사항", "개선 사항", "완성도", "보완점"].some((word) => normalized.includes(word));
  return (mentionsClaude && mentionsCodex) || ((mentionsClaude || mentionsCodex || mentionsAudit) && asksForComparison) || asksForSystemImprovementReview;
}
function detectRequestedExecutionActorRole(
  text: string,
  input: Extract<NormalizedTelegramInput, { kind: "message" | "command" }>
): "claude_leader" | "codex_leader" | undefined {
  if (input.envelope.telegramBotRole === "claude_leader") return "claude_leader";
  if (input.envelope.telegramBotRole === "codex_leader") return "codex_leader";

  const normalized = text.toLowerCase();
  if (/@claude_chatroom1_bot\b/i.test(text) || /@claude_chatroom_bot\b/i.test(text)) return "claude_leader";
  if (/@codex_chatroom_bot\b/i.test(text)) return "codex_leader";
  if (/\bclaude\b/.test(normalized) || normalized.includes("claudebot") || normalized.includes("클로드")) return "claude_leader";
  if (/\bcodex\b/.test(normalized) || normalized.includes("codexbot") || normalized.includes("코덱스")) return "codex_leader";
  return undefined;
}
function normalizeFreeformMessageText(input: Extract<NormalizedTelegramInput, { kind: "message" }>): string {
  const username = input.envelope.telegramBotUsername.replace(/^@/, "");
  const mentionPattern = new RegExp("@" + username + "\\b", "gi");
  return (input.envelope.messageText ?? "").replace(mentionPattern, " ").replace(/\s+/g, " ").trim();
}

function extractReplyTargetId(input: Extract<NormalizedTelegramInput, { kind: "message" }>): string | undefined {
  return extractWorkItemId(input.envelope.replyToMessageText ?? "");
}

function hasAttachmentContext(input: Extract<NormalizedTelegramInput, { kind: "message" }>): boolean {
  return input.envelope.attachmentKinds.length > 0;
}

function isContinuationOnlyText(text: string): boolean {
  return isContinuationLikeText(text) && !extractWorkItemId(text);
}

function isContextDependentFixRequest(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (extractWorkItemId(normalized)) return false;
  return /^(이거|저거|그거|위\s*(오류|문제|작업)?|방금\s*(오류|문제|작업)?|아까\s*(오류|문제|작업)?|저\s*(오류|문제)|이\s*(오류|문제)|그\s*(오류|문제))\s*(오류|문제|장애)?\s*(해결|수정|고쳐|처리)(해|해줘|해라|줘|요|\.|!|\?)?$/.test(normalized);
}

function detectVagueActorDelegation(
  text: string,
  input: Extract<NormalizedTelegramInput, { kind: "message" | "command" }>
): "claude_leader" | "codex_leader" | undefined {
  if (extractWorkItemId(text)) return undefined;
  const requestedActorRole = detectRequestedExecutionActorRole(text, input);
  if (!requestedActorRole) return undefined;

  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const withoutActor = normalized
    .replace(/@claude_chatroom1_bot\b/gi, " ")
    .replace(/@claude_chatroom_bot\b/gi, " ")
    .replace(/@codex_chatroom_bot\b/gi, " ")
    .replace(/\bclaudebot\b/g, " ")
    .replace(/\bcodexbot\b/g, " ")
    .replace(/\bclaude\b/g, " ")
    .replace(/\bcodex\b/g, " ")
    .replace(/클로드/g, " ")
    .replace(/코덱스/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(그러면|그럼|그거|이거|저거|그 작업|그 일|그걸|이걸)?\s*(에게|한테|로|으로)?\s*(작업|일)?\s*(시켜|맡겨|넘겨|시키자|해봐|해|처리해)(줘|라|요|\.|!|\?)?$/.test(withoutActor)) {
    return requestedActorRole;
  }
  return undefined;
}

function isContinuationLikeText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /^(계속|계속해|계속 진행|이어서|이어가|진행해|다음|다음 단계|continue|go on|next)(요|줘|해|\.)?$/.test(normalized)
    || normalized.includes("계속")
    || normalized.includes("이어서")
    || /\b(continue|next)\b/i.test(normalized);
}

function extractWorkItemId(text: string): string | undefined {
  return /\b(?:task|proposal)_[0-9A-Za-z-]+\b/.exec(text)?.[0];
}

function renderAcknowledgementAnswer(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:mention-router:ack:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload: {
          text: buildAcknowledgementAnswerText(),
          binding: { kind: "event", eventId: `mention-router:ack:${input.envelope.updateId}` }
        }
      }
    ]
  };
}

function renderInformationalAnswer(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>,
  text: string
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:mention-router:answer:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload: {
          text: buildInformationalAnswerText(text),
          binding: { kind: "event", eventId: `mention-router:answer:${input.envelope.updateId}` }
        }
      }
    ]
  };
}

function renderContinuationClarification(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:mention-router:clarify:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload: {
          text: "어느 작업을 이어갈지 확인이 필요합니다. task_id 또는 proposal_id를 붙여 다시 말하거나, 해당 작업 메시지에 답장해 주세요.",
          binding: { kind: "event", eventId: `mention-router:clarify:${input.envelope.updateId}` }
        }
      }
    ]
  };
}

function renderContextDependentFixClarification(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:mention-router:context-fix-clarify:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload: {
          text: "어떤 오류인지 확인할 수 없습니다. 오류 메시지, 화면 캡처, 또는 proposal_id/task_id를 함께 보내주세요.",
          binding: { kind: "event", eventId: `mention-router:context-fix-clarify:${input.envelope.updateId}` }
        }
      }
    ]
  };
}

function renderActorDelegationClarification(
  input: Extract<NormalizedTelegramInput, { kind: "message" }>,
  actorRole: "claude_leader" | "codex_leader"
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const actorLabel = actorRole === "claude_leader" ? "ClaudeBot" : "CodexBot";
  return {
    accepted: true,
    authorization: { allowed: true },
    events: [],
    outbox: [
      {
        target: makeOutboxTargetForRole("leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:mention-router:delegate-clarify:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload: {
          text: `${actorLabel}에게 넘길 작업 내용을 함께 적어주세요.\n예: @leader_chatroom_bot ${actorLabel}에게 현재 오류 원인을 찾아 수정해줘`,
          binding: { kind: "event", eventId: `mention-router:delegate-clarify:${input.envelope.updateId}` }
        }
      }
    ]
  };
}


function hasRequiredPermission(input: NormalizedTelegramInput, membership: RoomMembership): boolean {
  if (membership.role === "owner") return true;

  const required = requiredPermissionForInput(input);
  if (!required) return true;
  return membership.permissions.includes(required);
}

function requiresOwner(input: NormalizedTelegramInput): boolean {
  if (input.kind === "callback") return true;
  if (input.kind !== "command") return false;
  return ["/approve", "/reject", "/done", "/cancel", "/verify"].includes(input.command.name);
}

function requiredPermissionForInput(input: NormalizedTelegramInput): RoomPermission | undefined {
  if (input.kind === "observation") return undefined;
  if (input.kind === "message") return "task:create";

  if (input.kind === "command") {
    switch (input.command.name) {
      case "/newtask":
        return "task:create";
      case "/tasks":
      case "/task":
      case "/search":
      case "/trace":
      case "/help":
      case "/agents":
        return "task:read";
      case "/inviteai":
        return "task:create";
      case "/aihealth":
        return "task:read";
      case "/registerroom":
        return "task:create";
      case "/change":
        return "task:create";
      case "/member":
        return "task:create";
      case "/newagent":
        return "task:create";
      case "/approve":
        return "task:approve";
      case "/reject":
        return "task:reject";
      case "/verify":
        return "task:verify";
      case "/done":
        return "task:final_approve";
      case "/cancel":
        return "task:cancel";
    }
  }

  switch (input.callback.action) {
    case "approve":
      return "task:approve";
    case "mid_approve":
    case "mid_reject":
      return "task:approve";
    case "reject":
      return "task:reject";
    case "revise":
    case "request_revision":
      return "task:create";
    case "reverify":
      return "task:verify";
    case "final_approve":
      return "task:final_approve";
    case "cancel":
      return "task:cancel";
  }
}

export function chooseOutboundBotForEvent(eventType: string): TelegramBotRole {
  if (eventType.startsWith("verification")) return "auditor";
  if (eventType.includes("claude")) return "claude_leader";
  if (eventType.includes("codex")) return "codex_leader";
  return "leader";
}

export function makeOutboxTargetForRole(
  botRole: TelegramBotRole,
  telegramChatId: string
): OutboxTarget {
  return { kind: "telegram_bot", botRole, telegramChatId };
}

function stripRequestFiller(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:해줘|해주세요|해봐|해 보라|해 보세요|찾아봐|보고해봐|보고해 줘|진행해|수정해|만들어줘|검토해봐)[.!?\s]*$/i, "")
    .trim();
}
// 제목 한 줄로 "이게 무슨 요청인지" 알아볼 수 있어야 한다.
//
// 예전에는 한글 키워드 사다리로 요청을 13개 고정 라벨 중 하나에 떨어뜨렸다. 그 결과가
// 라이브에서 드러났다 — 한 방의 제안 150건이 제목 66개로 뭉쳤고, "요청 처리" 25건,
// "Telegram 사용자 경험 개선" 6건처럼 서로 구분이 안 되는 덩어리가 생겼다. 작업 현황판이
// 생겨서 제안이 목록으로 쌓이기 전까지는 안 보이던 문제다(Telegram 은 한 건씩 흘러가서
// 같은 제목이 25개 있다는 걸 알 수 없었다).
//
// 라벨은 분류지 식별자가 아니다. 어느 라벨을 붙일지 규칙으로 맞히려는 시도 자체가
// 틀렸다 — 요청자가 이미 자기 말로 무슨 일인지 말했으므로 그 말을 그대로 쓴다.
// (라벨은 표시 전용이었다. 라우팅 intent 는 routeProposalText 가 따로 판정하고,
//  deriveProposalStructure 는 본문이 비었을 때의 대체값으로만 title 을 쓴다.)
const TITLE_MAX_LENGTH = 60;

function summarizeTitle(text: string): string {
  const normalized = stripRequestFiller(text);
  if (!normalized) return "새 작업";
  return truncateTitle(normalized);
}

function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX_LENGTH) return text;

  // 자를 자리를 찾을 땐 문장·어절 경계를 우선한다. 단어 한가운데서 끊으면 남은 앞부분
  // 만으로는 무슨 요청인지 못 읽는 경우가 생긴다. 다만 경계가 너무 앞이면(제목이
  // 지나치게 짧아지면) 식별력이 떨어지므로 그땐 그냥 길이로 자른다.
  const head = text.slice(0, TITLE_MAX_LENGTH);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf(" "), head.lastIndexOf(", "));
  const cut = boundary >= Math.floor(TITLE_MAX_LENGTH * 0.6) ? head.slice(0, boundary) : head;
  return `${cut.trimEnd()}…`;
}

function commandNameToOwnerAction(commandName: "/approve" | "/reject" | "/done" | "/cancel" | "/verify"): WorkflowEventName {
  switch (commandName) {
    case "/approve":
      return "owner_task_approved";
    case "/reject":
      return "owner_task_rejected";
    case "/done":
      return "owner_final_approved";
    case "/cancel":
      return "owner_cancel_requested";
    case "/verify":
      return "owner_verification_requested";
  }
}

function isOwnerCommandName(commandName: string): commandName is "/approve" | "/reject" | "/done" | "/cancel" | "/verify" {
  return ["/approve", "/reject", "/done", "/cancel", "/verify"].includes(commandName);
}

function callbackActionToOwnerEvent(action: TelegramCallbackAction): WorkflowEventName {
  switch (action) {
    case "approve":
      return "owner_task_approved";
    case "mid_approve":
      return "owner_mid_approved";
    case "mid_reject":
      return "owner_mid_rejected";
    case "reject":
      return "proposal_rejected";
    case "revise":
      return "proposal_revision_requested";
    case "reverify":
      return "owner_reverification_requested";
    case "request_revision":
      return "owner_supplement_requested";
    case "final_approve":
      return "owner_final_approved";
    case "cancel":
      return "owner_cancel_requested";
  }
}




function enqueueAuditExecutionIfConfigured(taskOrProposalId: string, action: WorkflowEventName, input: NormalizedTelegramInput, ports: TelegramInputHandlingPorts, requestText?: string): OrchestratorOutboxItem[] {
  const defaults = ports.executionDefaults;
  if (!defaults) return [];
  const attemptId = ports.makeId("audit-attempt");
  const mode = action === "owner_reverification_requested" ? "재검증" : "검증";
  const executionRequest: ExecutionRequest = {
    roomId: defaults.roomId, taskId: taskOrProposalId, attemptId, actorId: defaults.actorId,
    requestedBy: input.envelope.telegramUserId ?? "unknown", adapterType: "codex", projectPath: defaults.projectPath,
    prompt: buildAuditExecutionPrompt(mode, taskOrProposalId, requestText),
    timeoutMs: Math.min(defaults.timeoutMs, 300000), idempotencyKey: `audit-execution:${taskOrProposalId}:${attemptId}`,
    createdAt: ports.now(), reportBotRole: "auditor"
  };
  // 검증/재검증은 같은 taskOrProposalId 에 대해 여러 번(보완 요청 -> 재검증 반복) 정당하게
  // 재발생한다. entityId 만으로 멱등키를 잡으면(승인과 달리) 두 번째 재검증부터 전부
  // 막혀버린다. 라운드마다 새 메시지(새 완료 키보드)가 나가므로 그 메시지의
  // telegramMessageId 가 "이번 라운드의 이 결정"을 가리키는 안정적인 키가 된다 —
  // 같은 메시지의 버튼을 연타해도 telegramMessageId 는 그대로라 두 번째 클릭만 걸러지고,
  // 새 라운드는 새 메시지라 걸러지지 않는다. Mini App 결정 폴러는 verify/reverify 를
  // 아직 다루지 않으므로(miniapp-decision-poller.ts 의 CALLBACK_ACTION_BY_STAGE_DECISION 가
  // task_approval/final_approval/cancellation 만 지원) 이 경로에는 채널 간 충돌이 없다.
  return [{ target: { kind: "local_gateway", gatewayId: defaults.gatewayId }, idempotencyKey: `gateway:audit:${taskOrProposalId}:${decisionRoundKey(input)}`, payload: { executionRequest } }];
}

// 콜백이면 클릭된 메시지(=그 라운드의 키보드)의 id, 커맨드/메시지면 그 메시지 자체의 id.
// 둘 다 없을 매우 예외적인 경우에만 updateId 로 물러난다(항상 값이 있어야 하지만, 방어적으로).
function decisionRoundKey(input: NormalizedTelegramInput): string {
  return input.envelope.telegramMessageId ?? input.envelope.updateId;
}


function buildAuditExecutionPrompt(mode: string, taskOrProposalId: string, requestText?: string): string {
  const request = requestText?.trim();
  return [
    `독립 감사자로서 ${mode} 대상 ${taskOrProposalId}를 감사하세요.`,
    "중점: 보안, 비밀정보 노출, 사용자 표시 문구, 완료 기준, 실제 동작 여부.",
    "보고: 사람이 알아야 할 결론과 필요한 조치만 간결하게 작성하세요.",
    "금지: 내부 JSON, hook log, stack trace, token, API key, 원문 시크릿 출력.",
    request ? "" : undefined,
    request ? "감사 요청 원문:" : undefined,
    request || undefined
  ].filter((line): line is string => typeof line === "string").join("\n");
}
