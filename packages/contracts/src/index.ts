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
    public readonly callbackQueryId: string | undefined = undefined
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

    return new TelegramUpdateEnvelope(
      botId,
      botUsername,
      botRole,
      String(update.update_id),
      String(chatId),
      message?.message_id === undefined ? undefined : String(message.message_id),
      userId === undefined ? undefined : String(userId),
      update.message?.from?.is_bot === true,
      update.message?.text,
      update.callback_query?.data,
      update.callback_query?.id
    );
  }
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
    };

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


