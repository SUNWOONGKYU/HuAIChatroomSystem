// supabase-store.ts 에서 뽑아낸 outbox/event DB row ↔ 도메인 타입 매핑 + 승인(approval) 판정 + 관련 파싱 유틸. 순수 함수(I/O 없음).
import { maskTelegramSensitiveText as maskSensitiveText } from "../../../packages/telegram-ui/src/sanitize.js";
import {
  type OutboxRecord,
  type OutboxTarget,
  type TelegramUpdateReceipt
} from "../../../packages/contracts/src/index.js";
import { type PersistedEvent, type PersistedOutboxItem } from "./persistence.js";
import { type WorkflowContext } from "../../../packages/workflow/src/index.js";
import { type OrchestratorPersistencePortEvent, type EventRow, type OutboxRow } from "./command-prompt-helpers.js";

export function workflowContextFromEvent(event: OrchestratorPersistencePortEvent): WorkflowContext {
  const payload = event.payload;
  const actorRole = stringValue(payload.actorRole) ?? inferredActorRoleFromEvent(event.eventType);
  const actorId = stringValue(payload.actorId);
  const verifierActorId = stringValue(payload.verifierActorId) ?? (actorRole === "auditor" ? actorId : undefined);
  return {
    actorRole,
    isOwner: actorRole === "human_owner" || event.eventType.startsWith("owner_"),
    isAssignee: actorRole === "claude_leader" || actorRole === "codex_leader",
    isVerifier: actorRole === "auditor" || Boolean(verifierActorId),
    authorActorId: stringValue(payload.authorActorId),
    verifierActorId,
    hasOwnerTaskApproval: booleanValue(payload.hasOwnerTaskApproval),
    hasVerificationPass: booleanValue(payload.hasVerificationPass),
    hasCommanderCompletionDecision: booleanValue(payload.hasCommanderCompletionDecision),
    hasOwnerFinalApproval: booleanValue(payload.hasOwnerFinalApproval),
    changedScope: changedScopeValue(payload.changedScope),
    idempotencyKey: event.idempotencyKey
  };
}

// 승인성 이벤트 -> huai_approvals 의 (stage, decision).
// 기획서 FR-008 / FR-015 / AC-08 이 요구하는 "완료 전 3단계 승인 증거"를 남기기 위한 매핑이다.
// 여기에 없는 이벤트는 승인 기록 대상이 아니다.
const APPROVAL_STAGE_BY_EVENT: Readonly<Record<string, { stage: ApprovalStage; decision: ApprovalDecision }>> = {
  owner_task_approved: { stage: "task_approval", decision: "approved" },
  owner_task_rejected: { stage: "task_approval", decision: "rejected" },
  proposal_rejected: { stage: "task_approval", decision: "rejected" },
  proposal_revision_requested: { stage: "task_approval", decision: "revision_requested" },
  owner_mid_approved: { stage: "midpoint_approval", decision: "approved" },
  owner_mid_rejected: { stage: "midpoint_approval", decision: "rejected" },
  commander_completion_approved: { stage: "commander_completion", decision: "approved" },
  owner_final_approved: { stage: "final_approval", decision: "approved" },
  owner_final_rejected: { stage: "final_approval", decision: "rejected" },
  owner_supplement_requested: { stage: "final_approval", decision: "revision_requested" },
  owner_cancel_requested: { stage: "cancellation", decision: "cancelled" },
  cancel_approved: { stage: "cancellation", decision: "cancelled" }
};

export type ApprovalStage = "task_approval" | "midpoint_approval" | "commander_completion" | "final_approval" | "cancellation";
export type ApprovalDecision = "approved" | "rejected" | "revision_requested" | "cancelled";

export function approvalRecordForEvent(eventType: string): { stage: ApprovalStage; decision: ApprovalDecision } | undefined {
  return APPROVAL_STAGE_BY_EVENT[eventType];
}

// 승인 시점 대상 식별자. proposal 단계면 "proposal_xxxx", 이후 단계면 task UUID 가 들어온다.
export function approvalEntityRefFromPayload(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.entityId) ?? stringValue(payload.targetId) ?? stringValue(payload.taskId) ?? stringValue(payload.proposalId);
}

export function approvalDeciderFromPayload(payload: Record<string, unknown>): string | undefined {
  const value = payload.telegramUserId ?? payload.deciderTelegramUserId;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && /^\d+$/.test(value.trim()) ? value.trim() : undefined;
}

export function approvalReasonFromPayload(payload: Record<string, unknown>): string | null {
  const reason = stringValue(payload.reason) ?? stringValue(payload.rawText);
  return reason ? maskSensitiveText(reason).slice(0, 2000) : null;
}

export function inferredActorRoleFromEvent(eventType: string): string {
  if (eventType.startsWith("owner_")) return "human_owner";
  if (eventType.startsWith("verification") || eventType.startsWith("reverification")) return "auditor";
  if (eventType.startsWith("commander_")) return "leader";
  return "system";
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function changedScopeValue(value: unknown): WorkflowContext["changedScope"] {
  return value === "format_only" || value === "content" || value === "scope_change" ? value : undefined;
}
export function taskIdFromEventPayload(payload: Record<string, unknown>): string | undefined {
  const value = payload.targetId ?? payload.entityId ?? payload.taskId;
  return typeof value === "string" && isUuid(value) ? value : undefined;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function toPersistedEvent(row: EventRow): PersistedEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type as PersistedEvent["eventType"],
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    createdAt: row.created_at
  };
}

export function toPersistedOutboxItem(row: OutboxRow): PersistedOutboxItem {
  return {
    ...toOutboxRecord(row),
    eventId: row.event_id ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    lastError: row.last_error ?? undefined
  };
}

export function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    outboxId: row.huai_outbox_id,
    idempotencyKey: row.idempotency_key,
    target: parseTarget(row.target),
    payload: row.payload,
    status: row.status,
    attempts: row.attempts
  };
}

export function parseTarget(target: string | OutboxTarget): OutboxTarget {
  if (typeof target !== "string") return target;
  const parsed = JSON.parse(target) as OutboxTarget;
  if (parsed.kind !== "telegram_bot" && parsed.kind !== "local_gateway") {
    throw new Error("invalid-outbox-target");
  }
  return parsed;
}

export function sameOutboxContent(expected: {
  target_kind: OutboxRow["target_kind"];
  target: string;
  payload: Record<string, unknown>;
}, existing: OutboxRow): boolean {
  return expected.target_kind === existing.target_kind
    && stableStringify(JSON.parse(expected.target)) === stableStringify(parseTarget(existing.target))
    && stableStringify(normalizeVolatileExecutionRequestFields(expected.payload)) === stableStringify(normalizeVolatileExecutionRequestFields(existing.payload));
}

// packages/orchestrator/src/index.ts 의 enqueueExecutionAfterApproval(:516-528)·
// enqueueAuditExecutionIfConfigured(:1039-1047) 는 executionRequest.attemptId 를
// ports.makeId() 로, createdAt 을 ports.now() 로 호출마다 새로 만든다. idempotencyKey
// 필드(executionRequest 내부, outbox 행 자체의 idempotency_key 와는 다른 필드)도
// `...:${attemptId}` 형태라 attemptId 에 종속돼 같이 매번 달라진다.
// 같은 승인 결정을 두 번 제출해도(Telegram 버튼 재클릭, 또는 Telegram·Mini App
// 두 창구에서 같은 결정이 각각 들어올 때) outbox 행의 idempotency_key(entityId 단위,
// 위 두 함수 주석 참고)는 같게 설계돼 있는데 이 3개 필드만 매번 달라서 여기서
// "내용이 다르다"고 오판해 outbox-idempotency-conflict 를 던지고 있었다.
// roomId/taskId/actorId/requestedBy/adapterType/projectPath/prompt/timeoutMs/
// reportBotRole 등 나머지 필드가 전부 같다면 이건 정말 "같은 요청"이 맞다 — 그래서
// 이 3개 필드만 비교에서 뺀다. 진짜 내용이 다른 충돌(다른 actorId, 다른 prompt 등)은
// 이 필드들을 빼도 나머지가 여전히 달라 정상적으로 outbox-idempotency-conflict 로 걸린다.
export function normalizeVolatileExecutionRequestFields(payload: Record<string, unknown>): Record<string, unknown> {
  const executionRequest = payload.executionRequest;
  if (!executionRequest || typeof executionRequest !== "object" || Array.isArray(executionRequest)) return payload;
  const stableExecutionRequest = { ...(executionRequest as Record<string, unknown>) };
  delete stableExecutionRequest.attemptId;
  delete stableExecutionRequest.idempotencyKey;
  delete stableExecutionRequest.createdAt;
  return { ...payload, executionRequest: stableExecutionRequest };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + stableStringify(item))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

export function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function eventIdForOutbox(binding: unknown, events: PersistedEvent[]): string | undefined {
  const eventId = typeof binding === "object" && binding !== null && "eventId" in binding
    ? (binding as { eventId?: unknown }).eventId
    : undefined;
  if (typeof eventId !== "string") return undefined;
  return events.find((event) => event.idempotencyKey === eventId || event.eventId === eventId)?.eventId;
}

export function parseTelegramUpdateIdempotencyKey(idempotencyKey: string): { telegramBotId: string; updateId: string } {
  const parts = idempotencyKey.split(":");
  if (parts.length !== 3 || parts[0] !== "telegram-update") {
    throw new Error("invalid-telegram-update-idempotency-key");
  }
  return { telegramBotId: parts[1] ?? "", updateId: parts[2] ?? "" };
}

export function receiptStatus(status: string | undefined): Extract<TelegramUpdateReceipt, { inserted: false }>["status"] {
  if (status === "processing" || status === "retry_pending" || status === "failed") return status;
  return "processed";
}

export function toBigIntString(value: string, field: string): string {
  if (!/^-?\d+$/.test(value)) throw new Error(`invalid-${field}`);
  return value;
}

export function stripUndefined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export async function safeResponseText(response: Response): Promise<string> {
  return maskSensitiveText(await response.text().catch(() => "unreadable-response"));
}

export function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

export function requireMiniAppDirectLinkBaseUrl(value: string): string {
  if (!value.startsWith("https://t.me/")) {
    throw new Error(`invalid-env:BOT_SERVICE_MINIAPP_DIRECT_LINK must start with https://t.me/ (got: ${maskSensitiveText(value)})`);
  }
  return value;
}

// God file 분리(2026-08, 3차)로 supabase-store.ts 에서 옮겨왔다. outbox payload 의
// 선택적 문자열 필드를 안전하게 꺼내는 자리 — execution-hydration-store.ts /
// chat-command-store.ts / supabase-store.ts 세 곳이 공통으로 쓴다.
export function optionalPayloadString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isOwnerControlKeyboard(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const rows = (value as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => Array.isArray(row) && row.some((button) => {
    if (!button || typeof button !== "object") return false;
    const callback = (button as { callback_data?: unknown }).callback_data;
    if (typeof callback !== "string") return false;
    return /^(proposal|task):[^:]+:(approve|reject|revise|request_revision|mid_approve|mid_reject|reverify|final_approve|cancel|rv|rr|fa)$/.test(callback);
  }));
}
