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
  role: "owner" | "human_member" | "platoon_leader" | "claude_leader" | "codex_leader" | "auditor" | "operator";
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
  const authorization = authorizeTelegramInput(input, context);
  if (!authorization.allowed) {
    return { accepted: false, authorization };
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
    }
  }

  return applyOwnerCallback(input, ports);
}

export function createProposalFromTelegram(
  input: Extract<NormalizedTelegramInput, { kind: "message" | "command" }>,
  ports: TelegramInputHandlingPorts
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const proposalId = ports.makeId("proposal");
  const text = input.kind === "message" ? input.envelope.messageText ?? "" : input.command.args.join(" ");
  const routed = routeProposalText(input, text);
  const title = summarizeTitle(routed.text);
  const event: OrchestratorEvent = {
    eventType: "proposal_created",
    idempotencyKey: `proposal:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
    payload: {
      proposalId,
      telegramChatId: input.envelope.telegramChatId,
      telegramUserId: input.envelope.telegramUserId,
      sourceMessageId: input.envelope.telegramMessageId,
      title,
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
        target: makeOutboxTargetForRole("platoon_leader", input.envelope.telegramChatId),
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
  if (isContinuationOnlyText(text)) return renderContinuationClarification(input);
  const vagueDelegationRole = detectVagueActorDelegation(text, input);
  if (vagueDelegationRole) return renderActorDelegationClarification(input, vagueDelegationRole);
  if (input.envelope.telegramBotRole === "auditor") return createDirectAuditRequest(input, ports, text);
  const freeformIntent = classifyFreeformIntent(text);
  if (freeformIntent === "acknowledgement") return renderAcknowledgementAnswer(input);
  if (freeformIntent === "informational_answer") return renderInformationalAnswer(input, text);
  return createProposalFromTelegram(input, ports);
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
    outbox: [
      makeRoleMessageOutbox({
        botRole: "auditor",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:audit-request:${auditRequestId}:${input.envelope.updateId}`,
        text: `감사 요청을 접수했습니다: ${title}`,
        bindingId: `audit-request:${auditRequestId}:${input.envelope.updateId}`
      }),
      ...enqueueAuditExecutionIfConfigured(auditRequestId, "owner_verification_requested", input, ports, requestText)
    ]
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
    idempotencyKey: `${action}:${input.envelope.telegramBotId}:${input.envelope.updateId}:${input.callback.entityId}`,
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
    ...buildOwnerActionOutbox(action, input.callback.entityId, input, ports)
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
  ports: TelegramInputHandlingPorts
): OrchestratorOutboxItem[] {
  if (action === "owner_task_approved") {
    return [
      makeRoleMessageOutbox({
        botRole: "platoon_leader",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:execution-started:${taskOrProposalId}:${input.envelope.updateId}`,
        text: `작업 실행을 시작했습니다: ${taskOrProposalId}\n필요한 AI 작업자를 배정했습니다. 결과가 나오면 보고하겠습니다.`,
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `execution-started:${taskOrProposalId}:${input.envelope.updateId}`
      }),
      enqueueExecutionAfterApproval(taskOrProposalId, input, ports)
    ];
  }
  if (action === "owner_verification_requested" || action === "owner_reverification_requested") {
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
        botRole: "platoon_leader",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:final-approved:${taskOrProposalId}:${input.envelope.updateId}`,
        text: `최종 승인 완료: ${taskOrProposalId}`,
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `final-approved:${taskOrProposalId}:${input.envelope.updateId}`
      })
    ];
  }
  if (action === "owner_supplement_requested") {
    return [
      makeRoleMessageOutbox({
        botRole: "platoon_leader",
        telegramChatId: input.envelope.telegramChatId,
        idempotencyKey: `telegram:supplement-requested:${taskOrProposalId}:${input.envelope.updateId}`,
        text: `보완 요청: ${taskOrProposalId}`,
        callbackQueryId: input.envelope.callbackQueryId,
        bindingId: `supplement-requested:${taskOrProposalId}:${input.envelope.updateId}`,
        keyboard: buildCompletionKeyboard(taskOrProposalId)
      })
    ];
  }
  return [];
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
    idempotencyKey: `gateway:execution:${taskOrProposalId}:${input.envelope.updateId}`,
    payload: { executionRequest }
  };
}

function makeRoleMessageOutbox(input: {
  botRole: TelegramBotRole;
  telegramChatId: string;
  idempotencyKey: string;
  text: string;
  bindingId: string;
  callbackQueryId?: string;
  keyboard?: unknown;
}): OrchestratorOutboxItem {
  return {
    target: makeOutboxTargetForRole(input.botRole, input.telegramChatId),
    idempotencyKey: input.idempotencyKey,
    payload: {
      text: input.text,
      keyboard: input.keyboard,
      callbackQueryId: input.callbackQueryId,
      binding: { kind: "event", eventId: input.bindingId }
    }
  };
}

export function renderTelegramQuery(
  input: Extract<NormalizedTelegramInput, { kind: "command" }>
): Extract<TelegramInputHandlingResult, { accepted: true }> {
  const query = input.command.name === "/tasks"
    ? { kind: "tasks" as const, limit: 10 }
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
        target: makeOutboxTargetForRole("platoon_leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:query:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload
      }
    ]
  };
}

type RoutedProposalText = {
  text: string;
  intent: "new_task" | "task_followup" | "multi_ai_review";
  targetId?: string;
  requestedActorRole?: "claude_leader" | "codex_leader";
};

function routeProposalText(
  input: Extract<NormalizedTelegramInput, { kind: "message" | "command" }>,
  originalText: string
): RoutedProposalText {
  const text = input.kind === "message" ? normalizeFreeformMessageText(input) : originalText.trim();
  const targetId = extractWorkItemId(text);
  const intent = isMultiAiReviewRequest(text)
    ? "multi_ai_review"
    : targetId && isContinuationLikeText(text) ? "task_followup" : "new_task";
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

function isContinuationOnlyText(text: string): boolean {
  return isContinuationLikeText(text) && !extractWorkItemId(text);
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
        target: makeOutboxTargetForRole("platoon_leader", input.envelope.telegramChatId),
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
        target: makeOutboxTargetForRole("platoon_leader", input.envelope.telegramChatId),
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
        target: makeOutboxTargetForRole("platoon_leader", input.envelope.telegramChatId),
        idempotencyKey: `telegram:mention-router:clarify:${input.envelope.telegramBotId}:${input.envelope.updateId}`,
        payload: {
          text: "어느 작업을 이어갈지 확인이 필요합니다. task_id 또는 proposal_id를 붙여 다시 말하거나, 해당 작업 메시지에 답장해 주세요.",
          binding: { kind: "event", eventId: `mention-router:clarify:${input.envelope.updateId}` }
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
        target: makeOutboxTargetForRole("platoon_leader", input.envelope.telegramChatId),
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
        return "task:read";
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
  return "platoon_leader";
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
function summarizeTitle(text: string): string {
  const normalized = stripRequestFiller(text);
  if (!normalized) return "새 작업";
  if (normalized.includes("추가로 개선할 사항") || normalized.includes("개선할 사항") || normalized.includes("개선 사항") || normalized.includes("보완점")) return "개선 사항 도출";
  if (normalized.includes("완성도") || normalized.includes("평가")) return "완성도 평가";
  if (isMultiAiReviewRequest(normalized)) return "다중 AI 검토";
  if (normalized.includes("자동감사") || normalized.includes("오딧") || normalized.includes("감사")) return "감사 흐름 조정";
  if (normalized.includes("권한") || normalized.includes("쓰기") || normalized.includes("write")) return "실행 권한 보정";
  if (normalized.includes("안됨") || normalized.includes("안 되") || normalized.includes("오류") || normalized.includes("반응")) return "장애 원인 수정";
  if (normalized.includes("진행 상황") || normalized.includes("진도")) return "진행 상황 보고";
  if (normalized.includes("보안") || normalized.includes("검증")) return "검증 및 감사";
  if (normalized.includes("버튼") || normalized.includes("화면") || normalized.includes("문구") || normalized.includes("텔레그램")) return "Telegram 사용자 경험 개선";
  if (normalized.includes("문서") || normalized.includes("설명") || normalized.includes("관계도") || normalized.includes("흐름도")) return "문서 및 다이어그램 갱신";
  if (normalized.includes("수정") || normalized.includes("고쳐") || normalized.includes("개선")) return "수정 작업";
  if (normalized.includes("구현") || normalized.includes("만들")) return "구현 작업";
  if (normalized.includes("테스트")) return "테스트 작업";
  return "요청 처리";
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
  return [{ target: { kind: "local_gateway", gatewayId: defaults.gatewayId }, idempotencyKey: `gateway:audit:${taskOrProposalId}:${input.envelope.updateId}`, payload: { executionRequest } }];
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
