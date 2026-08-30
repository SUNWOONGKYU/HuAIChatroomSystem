// index.ts 에서 뽑아낸 텔레그램 입력 분류(제안 구조화·의도 판정·명료화 응답) + 권한 판정. 순수 함수(I/O 없음).
import {
  type NormalizedTelegramInput,
  type OutboxTarget,
  type TelegramBotRole
} from "../../contracts/src/index.js";
import { buildAcknowledgementAnswerText, buildInformationalAnswerText } from "./intent-router.js";
import { type RoomMembership, type RoomPermission, type TelegramInputHandlingResult } from "./index.js";

export type RoutedProposalText = {
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

export function derivePurpose(text: string, title: string): string {
  // "~하기 위해", "~하려고", "~할 수 있도록" 처럼 목적을 직접 말한 경우 그 절을 쓴다.
  const stated = text.match(/([^.!?\n]{4,80}?)(?:하기\s*위해|하기\s*위하여|하려고|할\s*수\s*있도록|하도록)/);
  if (stated?.[1]) return `${stated[1].trim()}하기 위해`;
  const firstSentence = text.split(/[.!?\n]/).map((part) => part.trim()).find((part) => part.length >= 4);
  return firstSentence && firstSentence !== title ? firstSentence : title;
}

export function deriveCompletionCriteria(text: string): string {
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

export function routeProposalText(
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

export function isMultiAiReviewRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsClaude = /@claude_chatroom1_bot\b/i.test(text) || /@claude_chatroom_bot\b/i.test(text) || /\bclaude\b/.test(normalized) || normalized.includes("claudebot") || normalized.includes("클로드");
  const mentionsCodex = /@codex_chatroom_bot\b/i.test(text) || /\bcodex\b/.test(normalized) || normalized.includes("codexbot") || normalized.includes("코덱스");
  const mentionsAudit = /@audit_chatroom_bot\b/i.test(text) || normalized.includes("auditbot") || normalized.includes("오딧") || normalized.includes("감사") || normalized.includes("검증");
  const asksForComparison = ["각각", "비교", "토론", "의견", "결론", "평가", "논의", "협의", "같이"].some((word) => normalized.includes(word));
  const asksForSystemImprovementReview = ["추가로 개선할 사항", "개선할 사항", "개선 사항", "완성도", "보완점"].some((word) => normalized.includes(word));
  return (mentionsClaude && mentionsCodex) || ((mentionsClaude || mentionsCodex || mentionsAudit) && asksForComparison) || asksForSystemImprovementReview;
}
export function detectRequestedExecutionActorRole(
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
export function normalizeFreeformMessageText(input: Extract<NormalizedTelegramInput, { kind: "message" }>): string {
  const username = input.envelope.telegramBotUsername.replace(/^@/, "");
  const mentionPattern = new RegExp("@" + username + "\\b", "gi");
  return (input.envelope.messageText ?? "").replace(mentionPattern, " ").replace(/\s+/g, " ").trim();
}

export function extractReplyTargetId(input: Extract<NormalizedTelegramInput, { kind: "message" }>): string | undefined {
  return extractWorkItemId(input.envelope.replyToMessageText ?? "");
}

export function hasAttachmentContext(input: Extract<NormalizedTelegramInput, { kind: "message" }>): boolean {
  return input.envelope.attachmentKinds.length > 0;
}

export function isContinuationOnlyText(text: string): boolean {
  return isContinuationLikeText(text) && !extractWorkItemId(text);
}

export function isContextDependentFixRequest(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (extractWorkItemId(normalized)) return false;
  return /^(이거|저거|그거|위\s*(오류|문제|작업)?|방금\s*(오류|문제|작업)?|아까\s*(오류|문제|작업)?|저\s*(오류|문제)|이\s*(오류|문제)|그\s*(오류|문제))\s*(오류|문제|장애)?\s*(해결|수정|고쳐|처리)(해|해줘|해라|줘|요|\.|!|\?)?$/.test(normalized);
}

export function detectVagueActorDelegation(
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

export function isContinuationLikeText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /^(계속|계속해|계속 진행|이어서|이어가|진행해|다음|다음 단계|continue|go on|next)(요|줘|해|\.)?$/.test(normalized)
    || normalized.includes("계속")
    || normalized.includes("이어서")
    || /\b(continue|next)\b/i.test(normalized);
}

export function extractWorkItemId(text: string): string | undefined {
  return /\b(?:task|proposal)_[0-9A-Za-z-]+\b/.exec(text)?.[0];
}

export function renderAcknowledgementAnswer(
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

export function renderInformationalAnswer(
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

export function renderContinuationClarification(
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

export function renderContextDependentFixClarification(
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

export function renderActorDelegationClarification(
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


export function hasRequiredPermission(input: NormalizedTelegramInput, membership: RoomMembership): boolean {
  if (membership.role === "owner") return true;

  const required = requiredPermissionForInput(input);
  if (!required) return true;
  return membership.permissions.includes(required);
}

export function requiresOwner(input: NormalizedTelegramInput): boolean {
  if (input.kind === "callback") return true;
  if (input.kind !== "command") return false;
  return ["/approve", "/reject", "/done", "/cancel", "/verify"].includes(input.command.name);
}

export function requiredPermissionForInput(input: NormalizedTelegramInput): RoomPermission | undefined {
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
      case "/center":
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

export function stripRequestFiller(text: string): string {
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
// "Telegram 사용자 경험 개선" 6건처럼 서로 구분이 안 되는 덩어리가 생겼다. 협업 운영센터가
// 생겨서 제안이 목록으로 쌓이기 전까지는 안 보이던 문제다(Telegram 은 한 건씩 흘러가서
// 같은 제목이 25개 있다는 걸 알 수 없었다).
//
// 라벨은 분류지 식별자가 아니다. 어느 라벨을 붙일지 규칙으로 맞히려는 시도 자체가
// 틀렸다 — 요청자가 이미 자기 말로 무슨 일인지 말했으므로 그 말을 그대로 쓴다.
// (라벨은 표시 전용이었다. 라우팅 intent 는 routeProposalText 가 따로 판정하고,
//  deriveProposalStructure 는 본문이 비었을 때의 대체값으로만 title 을 쓴다.)
const TITLE_MAX_LENGTH = 60;

export function summarizeTitle(text: string): string {
  const normalized = stripRequestFiller(text);
  if (!normalized) return "새 작업";
  return truncateTitle(normalized);
}

export function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX_LENGTH) return text;

  // 자를 자리를 찾을 땐 문장·어절 경계를 우선한다. 단어 한가운데서 끊으면 남은 앞부분
  // 만으로는 무슨 요청인지 못 읽는 경우가 생긴다. 다만 경계가 너무 앞이면(제목이
  // 지나치게 짧아지면) 식별력이 떨어지므로 그땐 그냥 길이로 자른다.
  const head = text.slice(0, TITLE_MAX_LENGTH);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf(" "), head.lastIndexOf(", "));
  const cut = boundary >= Math.floor(TITLE_MAX_LENGTH * 0.6) ? head.slice(0, boundary) : head;
  return `${cut.trimEnd()}…`;
}

