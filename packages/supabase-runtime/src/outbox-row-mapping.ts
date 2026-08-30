// index.ts 에서 뽑아낸 outbox/event DB row ↔ 도메인 타입 매핑 + 관련 파싱 유틸. 순수 함수(I/O 없음).
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import {
  isAiAdapterType,
  normalizeAiAdapterType,
  type ExecutionRequest,
  type GatewayEvent,
  type OutboxRecord,
  type OutboxTarget
} from "../../contracts/src/index.js";
import { truncate } from "./small-utils.js";

export type OutboxRow = {
  outbox_id?: string;
  huai_outbox_id?: string;
  idempotency_key: string;
  target: string | OutboxTarget;
  payload: Record<string, unknown>;
  status: OutboxRecord["status"];
  attempts: number;
};

export type EventRow = {
  event_id: string;
  room_id: string;
  task_id?: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

export type EventInsertRow = {
  room_id: string;
  task_id: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
};

export type OutboxInsertRow = {
  event_id: string;
  idempotency_key: string;
  target_kind: "telegram_bot" | "local_gateway";
  target: string;
  payload: Record<string, unknown>;
  // huai_outbox.room_id 는 nullable FK 다(20260815140000 마이그레이션). lease_huai_outbox
  // 가 방별 공평 리스를 위해 이 값으로 그룹핑하므로, roomId 를 아는 호출부는 반드시
  // 채워야 한다 — 안 채우면 그 행이 "room 없음" 공유 버킷으로 떨어져 공평 리스 대상에서
  // 사실상 빠진다. 옵셔널로 남긴 이유는 이벤트 없이 발생하는 outbox 행처럼 roomId 를
  // 구조적으로 모르는 호출부가 생길 가능성을 막지 않기 위해서다(지금은 전부 채운다).
  room_id?: string | null;
};

export function executionRequestFromOutbox(row: OutboxRecord): ExecutionRequest | undefined {
  const value = row.payload.executionRequest ?? row.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as ExecutionRequest;
  return {
    ...request,
    ...(isAiAdapterType(request.adapterType) ? { adapterType: normalizeAiAdapterType(request.adapterType) } : {}),
    ...(isAiAdapterType(request.workerAdapterType)
      ? { workerAdapterType: normalizeAiAdapterType(request.workerAdapterType) }
      : {}),
    ...(Array.isArray(request.triedAdapterTypes)
      ? { triedAdapterTypes: request.triedAdapterTypes.filter(isAiAdapterType).map(normalizeAiAdapterType) }
      : {})
  };
}

export function isDependencySatisfiedStatus(status: string): boolean {
  return status === "completed" || status === "commander_completion_pending" || status === "completion_approval_pending";
}

export function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function toOutboxRecord(row: OutboxRow): OutboxRecord {
  const outboxId = row.outbox_id ?? row.huai_outbox_id;
  if (!outboxId) throw new Error("missing-outbox-id");
  return {
    outboxId,
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

export function stripUndefined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
}


export function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}




export function summarizeGatewayEvents(events: GatewayEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    if (event.type === "stdout" || event.type === "stderr") {
      return { type: event.type, text: truncate(maskSensitiveText(event.text), 2000) };
    }
    if (event.type === "failed") {
      return { ...event, errorKind: maskSensitiveText(event.errorKind) };
    }
    return event;
  });
}
