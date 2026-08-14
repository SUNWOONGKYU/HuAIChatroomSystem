export type ActorRole =
  | "platoon_leader"
  | "claude_leader"
  | "codex_leader"
  | "auditor"
  | "human_owner"
  | "human_member";

export type AiAdapterType = "claude_code" | "codex";

export type TelegramBotRole = Extract<ActorRole, "platoon_leader" | "claude_leader" | "codex_leader" | "auditor">;

export type TelegramCallbackAction =
  | "approve"
  | "revise"
  | "reject"
  | "reverify"
  | "request_revision"
  | "final_approve"
  | "cancel";

export type TelegramCommandName =
  | "/newtask"
  | "/tasks"
  | "/task"
  | "/search"
  | "/trace"
  | "/approve"
  | "/reject"
  | "/verify"
  | "/done"
  | "/cancel"
  | "/help";

export type TelegramCommand = {
  name: TelegramCommandName;
  args: string[];
};

export type WorkflowEventName =
  | "proposal_created"
  | "proposal_revision_requested"
  | "proposal_rejected"
  | "owner_task_approved"
  | "owner_task_rejected"
  | "dependencies_satisfied"
  | "gateway_enqueued"
  | "task_started"
  | "artifact_saved"
  | "meaningful_intermediate_ready"
  | "mid_approval_required"
  | "owner_mid_approved"
  | "owner_mid_rejected"
  | "owner_verification_requested"
  | "verification_started"
  | "verification_reported"
  | "verification_failed_or_changes_requested"
  | "owner_reverification_requested"
  | "reverification_passed"
  | "revision_submitted"
  | "verification_passed"
  | "commander_completion_requested"
  | "commander_completion_approved"
  | "owner_final_approved"
  | "owner_supplement_requested"
  | "owner_final_rejected"
  | "owner_cancel_requested"
  | "cancel_approved"
  | "execution_delayed_or_failed"
  | "execution_retry_scheduled"
  | "execution_failed_terminal"
  | "post_completion_minor_change_requested"
  | "post_completion_scope_change_requested"
  | "ai_actor_inactive";

export type TelegramCallback = {
  entity: "proposal" | "task";
  entityId: string;
  action: TelegramCallbackAction;
};

export type TelegramUpdateProcessingStatus =
  | "received"
  | "processing"
  | "processed"
  | "ignored"
  | "retry_pending"
  | "failed";

export type TelegramWebhookRejectReason =
  | "invalid-webhook-secret"
  | "unknown-bot"
  | "malformed-update"
  | "unauthorized-chat"
  | "bot-message-ignored"
  | "duplicate-update";

export type TelegramWebhookAck = {
  httpStatus: 200;
  queued: boolean;
  reason?: TelegramWebhookRejectReason;
};

export type TelegramUpdateReceipt =
  | {
      inserted: true;
      status: Extract<TelegramUpdateProcessingStatus, "received" | "ignored">;
      idempotencyKey: string;
    }
  | {
      inserted: false;
      status: "processed" | "processing" | "retry_pending" | "failed";
      idempotencyKey: string;
    };

export type TelegramInboundQueueMessage = {
  input: NormalizedTelegramInput;
  idempotencyKey: string;
  receivedAt: string;
};

export type TelegramWebhookRequestContext = {
  botUsername: string;
  secretToken?: string;
  receivedAt: string;
};

export type TelegramUpdate = {
  update_id: number | string;
  message?: {
    message_id: number | string;
    chat: { id: number | string };
    from?: { id: number | string; is_bot?: boolean; username?: string };
    text?: string;
    caption?: string;
    reply_to_message?: {
      message_id?: number | string;
      text?: string;
      caption?: string;
      from?: { id?: number | string; is_bot?: boolean; username?: string };
    };
    photo?: unknown;
    document?: unknown;
    video?: unknown;
    animation?: unknown;
    audio?: unknown;
    voice?: unknown;
  };
  callback_query?: {
    id: string;
    from: { id: number | string; username?: string };
    message?: {
      message_id: number | string;
      chat: { id: number | string };
    };
    data?: string;
  };
};

export class TelegramUpdateEnvelope {
  constructor(
    public readonly telegramBotId: string,
    public readonly telegramBotUsername: string,
    public readonly telegramBotRole: TelegramBotRole,
    public readonly updateId: string,
    public readonly telegramChatId: string,
    public readonly telegramMessageId: string | undefined,
    public readonly telegramUserId: string | undefined,
    public readonly fromIsBot: boolean,
    public readonly messageText: string | undefined,
    public readonly callbackData: string | undefined,
    public readonly callbackQueryId: string | undefined = undefined,
    public readonly replyToMessageId: string | undefined = undefined,
    public readonly replyToMessageText: string | undefined = undefined,
    public readonly attachmentKinds: readonly string[] = [],
    // 답장 대상 메시지를 보낸 봇의 username. 사람 메시지에 답장했으면 undefined.
    // "누구에게 답장했는가"를 알아야 그 봇에게 한 말인지 판정할 수 있다.
    public readonly replyToBotUsername: string | undefined = undefined
  ) {}

  static parse(
    botId: string,
    botUsername: string,
    botRole: TelegramBotRole,
    payload: unknown
  ): TelegramUpdateEnvelope {
    const update = payload as TelegramUpdate;
    if (typeof update?.update_id !== "number" && typeof update?.update_id !== "string") {
      throw new Error("invalid-telegram-update-id");
    }

    const message = update.message ?? update.callback_query?.message;
    const chatId = message?.chat?.id;
    if (chatId === undefined || chatId === null) {
      throw new Error("missing-telegram-chat-id");
    }

    const userId = update.message?.from?.id ?? update.callback_query?.from?.id;
    const messageText = update.message?.text ?? update.message?.caption;
    const replyToMessage = update.message?.reply_to_message;
    const replyToText = replyToMessage?.text ?? replyToMessage?.caption;
    const replyToBotUsername = replyToMessage?.from?.is_bot === true ? replyToMessage.from.username : undefined;
    const attachmentKinds = attachmentKindsFromMessage(update.message);

    return new TelegramUpdateEnvelope(
      botId,
      botUsername,
      botRole,
      String(update.update_id),
      String(chatId),
      message?.message_id === undefined ? undefined : String(message.message_id),
      userId === undefined ? undefined : String(userId),
      update.message?.from?.is_bot === true,
      messageText,
      update.callback_query?.data,
      update.callback_query?.id,
      replyToMessage?.message_id === undefined ? undefined : String(replyToMessage.message_id),
      replyToText,
      attachmentKinds,
      replyToBotUsername
    );
  }
}

function attachmentKindsFromMessage(message: TelegramUpdate["message"] | undefined): readonly string[] {
  if (!message) return [];
  const kinds: string[] = [];
  for (const key of ["photo", "document", "video", "animation", "audio", "voice"] as const) {
    if (message[key] !== undefined) kinds.push(key);
  }
  return kinds;
}

export type NormalizedTelegramInput =
  | {
      kind: "command";
      envelope: TelegramUpdateEnvelope;
      command: TelegramCommand;
    }
  | {
      kind: "callback";
      envelope: TelegramUpdateEnvelope;
      callback: TelegramCallback;
    }
  | {
      kind: "message";
      envelope: TelegramUpdateEnvelope;
    }
  // 소대장에게 말을 건 것이 아니라 사람끼리 나눈 대화.
  // 시스템은 이것을 듣고 맥락으로 보관하되 어떤 작업도 만들지 않는다.
  // 이 구분이 없으면 방의 모든 잡담이 승인 버튼으로 쌓인다.
  | {
      kind: "observation";
      envelope: TelegramUpdateEnvelope;
    };

// 이 발화가 "이 봇"에게 건넨 말인가.
//
// 봇 4개가 한 bot-service 를 공유하므로 "아무 봇이나 언급됐다"로 판정하면
// 한 발화를 네 봇이 각자 자기 지시로 처리한다. 반드시 이 봇 기준으로 본다.
//
// 세 가지 경로만 인정한다. 그 외 발화는 사람끼리의 대화다.
//   1) 이 봇을 @멘션           2) 이 봇의 메시지에 답장           3) 명령
export function isAddressedToBot(input: {
  envelope: TelegramUpdateEnvelope;
  thisBotUsername: string;
  thisBotRole: TelegramBotRole;
  allBotUsernames: readonly string[];
}): boolean {
  const text = (input.envelope.messageText ?? "").trim();

  if (text.startsWith("/")) return isCommandForThisBot(text, input.thisBotUsername, input.thisBotRole);

  // 다른 봇을 지목했으면 내 일이 아니다. 소대장이라도 가로채지 않는다.
  const mentionsThisBot = text.includes(`@${input.thisBotUsername}`);
  const mentionsOtherBot = input.allBotUsernames.some(
    (username) => username !== input.thisBotUsername && text.includes(`@${username}`)
  );
  if (mentionsThisBot) return true;
  if (mentionsOtherBot) return false;

  // 답장은 "내가 보낸 메시지"에 대한 것일 때만 나에게 한 말이다.
  if (input.envelope.replyToBotUsername === input.thisBotUsername) return true;

  // @태그 없이 이름만 부르는 것도 알아듣는다. "소대장 이거 해줘", "코덱스는 이렇게 해라".
  // 단 소대장만 받는다 — 분대장이 직접 받으면 작업 카드·승인·검증을 우회하기 때문이다.
  // 누구에게 시킬지는 소대장이 판단해서 배분한다.
  return input.thisBotRole === "platoon_leader" && isNamedDirective(text);
}

// 방에서 부르는 이름들. 사람이 실제로 쓰는 호칭을 넣는다.
const BOT_ALIASES = [
  "소대장", "리더", "leader",
  "클로드", "claude", "클로드봇",
  "코덱스", "codex", "코덱스봇",
  "감사관", "감사", "검증자", "audit", "오딧"
];

// 지시형 어미. "클로드가 만든 게 이상해"(사람끼리 얘기)와
// "클로드는 이걸 해라"(지시)를 가르는 기준이다.
const DIRECTIVE_ENDING =
  /(해라|해줘|해 줘|하라|해봐|해 봐|해주세요|해줄래|하자|부탁|진행해|정리해|확인해|시작해|맡아|맡아줘|처리해|알아봐|검토해|만들어|고쳐|수정해|실행해)/;

export function isNamedDirective(text: string): boolean {
  const normalized = text.toLowerCase();
  const named = BOT_ALIASES.some((alias) => normalized.includes(alias.toLowerCase()));
  return named && DIRECTIVE_ENDING.test(text);
}

// `/명령@봇이름` 은 그 봇에게. 이름 없는 `/명령` 은 기본 입력 창구인 소대장이 받는다.
function isCommandForThisBot(text: string, thisBotUsername: string, thisBotRole: TelegramBotRole): boolean {
  const first = text.split(/\s+/)[0] ?? "";
  const [, targetUsername] = first.split("@");
  if (targetUsername) return targetUsername === thisBotUsername;
  return thisBotRole === "platoon_leader";
}

export type ExecutionRequest = {
  roomId: string;
  taskId: string;
  attemptId: string;
  actorId: string;
  requestedBy: string;
  adapterType: AiAdapterType;
  projectPath: string;
  prompt: string;
  timeoutMs: number;
  idempotencyKey: string;
  createdAt: string;
  reportBotRole?: TelegramBotRole;
  artifactPolicy?: ArtifactPolicy;
  gitPolicy?: GitPolicy;
  // 이전 CLI 세션을 이어받는다. 소대장이 방의 맥락을 기억하려면 필요하다.
  resumeSessionId?: string;
  // 역할별 모델 지정. 소대장 판단은 실행보다 상위 모델이 필요할 수 있다.
  model?: string;
};

export function assertExecutionRequestPayload(value: unknown): ExecutionRequest {
  const request = value as ExecutionRequest;
  if (
    typeof request?.roomId !== "string" ||
    typeof request.taskId !== "string" ||
    typeof request.attemptId !== "string" ||
    typeof request.actorId !== "string" ||
    typeof request.requestedBy !== "string" ||
    (request.adapterType !== "claude_code" && request.adapterType !== "codex") ||
    typeof request.projectPath !== "string" ||
    typeof request.prompt !== "string" ||
    typeof request.timeoutMs !== "number" ||
    request.timeoutMs <= 0 ||
    typeof request.idempotencyKey !== "string" ||
    typeof request.createdAt !== "string" ||
    Number.isNaN(Date.parse(request.createdAt)) ||
    (request.reportBotRole !== undefined && !["platoon_leader", "claude_leader", "codex_leader", "auditor"].includes(request.reportBotRole))
  ) {
    throw new Error("invalid-execution-request-payload");
  }
  return request;
}
export type ArtifactPolicy = {
  collectGlobs: string[];
  maxArtifactBytes: number;
};

export type GitPolicy = {
  captureStatus: boolean;
  captureDiffSummary: boolean;
};

export type ExecutionAttempt = {
  attemptId: string;
  taskId: string;
  status: "queued" | "leased" | "running" | "cancelled" | "failed" | "retry_scheduled" | "completed";
  attemptNo: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  errorKind?: string;
};

export type GatewayEvent =
  | { type: "accepted"; taskId: string; attemptId: string }
  | { type: "started"; taskId: string; attemptId: string; at: string }
  | { type: "stdout"; taskId: string; attemptId: string; text: string }
  | { type: "stderr"; taskId: string; attemptId: string; text: string }
  | { type: "artifact_collected"; taskId: string; attemptId: string; artifact: ArtifactManifest }
  | { type: "artifact_collection_failed"; taskId: string; attemptId: string; reason: string }
  | { type: "git_snapshot"; taskId: string; attemptId: string; snapshot: GitSnapshot }
  | { type: "cancelled"; taskId: string; attemptId: string; reason: string }
  | { type: "failed"; taskId: string; attemptId: string; errorKind: string; retryable: boolean }
  | { type: "retry_scheduled"; taskId: string; attemptId: string; nextAttemptAt: string }
  | { type: "completed"; taskId: string; attemptId: string; at: string };

export type CancelExecutionRequest = {
  taskId: string;
  attemptId: string;
  requestedBy: string;
  reason: string;
};

export type ArtifactManifest = {
  path: string;
  sizeBytes: number;
  checksum: string;
  version: string;
  uri?: string;
};

export type GitSnapshot = {
  branch: string;
  commit: string;
  dirtyFiles: string[];
  diffSummary?: string;
};

export type OutboxTarget =
  | { kind: "telegram_bot"; botRole: TelegramBotRole; telegramChatId: string }
  | { kind: "local_gateway"; gatewayId: string };

export type OutboundBotMessage = {
  botRole: TelegramBotRole;
  telegramChatId: string;
  text: string;
  replyToMessageId?: string;
  editMessageId?: string;
  keyboard?: unknown;
  binding:
    | { kind: "event"; eventId: string }
    | { kind: "task"; taskId: string }
    | { kind: "report"; reportId: string }
    | { kind: "verification"; verificationId: string };
  idempotencyKey: string;
};

export type OutboxStatus = "pending" | "processing" | "sent" | "retry_pending" | "failed" | "dead";

export type OutboxRecord = {
  outboxId: string;
  idempotencyKey: string;
  target: OutboxTarget;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
};

export type TelegramSendMessageRequest = {
  botRole: TelegramBotRole;
  telegramChatId: string;
  text: string;
  replyToMessageId?: string;
  keyboard?: unknown;
};

export type TelegramEditMessageTextRequest = {
  botRole: TelegramBotRole;
  telegramChatId: string;
  telegramMessageId: string;
  text: string;
  keyboard?: unknown;
};

export type TelegramSendResult = {
  telegramMessageId: string;
  raw?: unknown;
};

export const knownCommands: readonly TelegramCommandName[] = [
  "/newtask",
  "/tasks",
  "/task",
  "/search",
  "/trace",
  "/approve",
  "/reject",
  "/verify",
  "/done",
  "/cancel",
  "/help"
] as const;

export function isKnownCommand(value: string): value is TelegramCommandName {
  return (knownCommands as readonly string[]).includes(value);
}

export function parseTelegramCallbackData(data: string | undefined): TelegramCallback | undefined {
  if (!data) return undefined;
  const [entity, entityId, rawAction] = data.split(":");
  const action = normalizeTelegramCallbackAction(rawAction);
  if ((entity !== "proposal" && entity !== "task") || !entityId || !action) {
    return undefined;
  }
  return { entity, entityId, action };
}

function normalizeTelegramCallbackAction(value: string | undefined): TelegramCallbackAction | undefined {
  switch (value) {
    case "rv":
      return "reverify";
    case "rr":
      return "request_revision";
    case "fa":
      return "final_approve";
    default:
      return isTelegramCallbackAction(value) ? value : undefined;
  }
}

function isTelegramCallbackAction(value: string | undefined): value is TelegramCallbackAction {
  return [
    "approve",
    "revise",
    "reject",
    "reverify",
    "request_revision",
    "final_approve",
    "cancel"
  ].includes(value ?? "");
}


