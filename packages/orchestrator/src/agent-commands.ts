// ─────────────────────────────────────────────────────────────────────────
// God module 분리(2026-08, 2차) — index.ts 에 있던 방장 전용 관리 명령
// (/newagent, /agents, /inviteai, /aihealth, /registerroom, /change, /member)
// 핸들러를 옮겼다. 전부 outbox payload 에 명령 표식만 실어 보내는 순수 함수라
// 서로 독립적이고, index.ts 로부터는 타입만 가져온다(import type — 컴파일 시
// 지워지므로 실질적인 순환 의존이 되지 않는다).
// ─────────────────────────────────────────────────────────────────────────
import type { NormalizedTelegramInput } from "../../contracts/src/index.js";
import type { TelegramInputHandlingResult } from "./index.js";
import { makeOutboxTargetForRole } from "./input-classification.js";

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
