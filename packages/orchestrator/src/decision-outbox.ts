// ─────────────────────────────────────────────────────────────────────────
// God module 분리(2026-08, 2차) — index.ts 에 있던 "결정(승인/검증/보완) → outbox"
// 빌더들을 옮겼다. applyMiniAppDecision 은 authorizeTelegramInput(값)을 필요로 해
// index.ts 에 그대로 두고, 여기 함수들을 값으로 import 해 쓴다(역방향 순환 방지).
// 여기서 index.ts 로부터 가져오는 것은 타입뿐이다(import type — 컴파일 시 완전히
// 지워지므로 실질적인 순환 의존이 되지 않는다).
// ─────────────────────────────────────────────────────────────────────────
import { type ExecutionRequest, type NormalizedTelegramInput, type TelegramBotRole, type TelegramCallbackAction, type WorkflowEventName } from "../../contracts/src/index.js";
import type { OrchestratorOutboxItem, TelegramInputHandlingPorts } from "./index.js";
import { makeOutboxTargetForRole } from "./input-classification.js";

export function buildCallbackAckOutbox(
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
export function buildMiniAppDecisionOutbox(
  action: WorkflowEventName,
  taskOrProposalId: string,
  input: NormalizedTelegramInput,
  ports: TelegramInputHandlingPorts,
  // Mini App [보완 요청] 사유. 이 함수는 내부 결정 재생 경로에서만 호출된다.
  // Telegram 명령·콜백 경로는 renderOwnerActionRedirect 로 분리되어 상태 변경 outbox를
  // 만들 수 없다.
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
        // 완료·보완 결정은 협업 운영센터에서 한다. 방에 버튼을 다시 붙이면 결정 창구가
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
    return `${base}\n이후 결정은 고정된 협업 운영센터에서 진행해 주세요.`;
  }
  const truncated = trimmedReason.length > SUPPLEMENT_REASON_DISPLAY_MAX;
  const shown = truncated ? `${trimmedReason.slice(0, SUPPLEMENT_REASON_DISPLAY_MAX)}…` : trimmedReason;
  return `${base}\n사유: ${shown}${truncated ? " (길어서 잘렸습니다 — 전체는 협업 운영센터에서 확인하세요)" : ""}\n이후 결정은 고정된 협업 운영센터에서 진행해 주세요.`;
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
export function buildExecutionNotConfiguredOutbox(input: {
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

export function makeRoleMessageOutbox(input: {
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

export function callbackActionToOwnerEvent(action: TelegramCallbackAction): WorkflowEventName {
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

export function enqueueAuditExecutionIfConfigured(taskOrProposalId: string, action: WorkflowEventName, input: NormalizedTelegramInput, ports: TelegramInputHandlingPorts, requestText?: string): OrchestratorOutboxItem[] {
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
