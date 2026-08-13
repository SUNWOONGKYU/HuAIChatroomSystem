import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import {
  type ExecutionRequest,
  type GatewayEvent,
  type OutboxRecord,
  type OutboxTarget,
  type TelegramSendResult
} from "../../contracts/src/index.js";
import { buildCompletionKeyboard } from "../../telegram-ui/src/index.js";

export type SupabaseRuntimeConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
};

export class SupabaseOutboxStore {
  private readonly client: SupabaseRestClient;

  constructor(config: SupabaseRuntimeConfig) {
    this.client = new SupabaseRestClient(config);
  }

  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "telegram_bot");
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    const leased = await this.leaseOutbox(limit, leaseUntil, "local_gateway");
    const runnable: OutboxRecord[] = [];
    for (const row of leased) {
      const request = executionRequestFromOutbox(row);
      if (!request || await this.isTaskRunnable(request.taskId)) {
        runnable.push(row);
        continue;
      }
      await this.patchOutbox(row.outboxId, {
        status: "retry_pending",
        last_error: "waiting-dependencies",
        next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
        locked_until: null
      });
    }
    return runnable;
  }

  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    const updated = await this.client.rpc<boolean>("mark_huai_outbox_sent", {
      p_huai_outbox_id: outboxId,
      p_send_result: summarizeSupabaseSendResult(result)
    });
    if (updated !== true) throw new Error("outbox-state-conflict:mark-sent");
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "retry_pending",
      last_error: maskSensitiveText(error),
      next_attempt_at: nextAttemptAt,
      locked_until: null
    });
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "dead",
      last_error: maskSensitiveText(error),
      locked_until: null
    });
  }

  async recordGatewayExecutionResult(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }): Promise<void> {
    const telegramChatId = await this.fetchRoomTelegramChatId(input.request.roomId);
    const eventType = input.status === "completed" ? "meaningful_intermediate_ready" : "execution_delayed_or_failed";
    const eventKey = "gateway-result:" + input.request.attemptId + ":" + input.status;
    const event = await this.insertEventIdempotently({
      room_id: input.request.roomId,
      task_id: isUuid(input.request.taskId) ? input.request.taskId : null,
      event_type: eventType,
      idempotency_key: eventKey,
      payload: {
        taskId: input.request.taskId,
        attemptId: input.request.attemptId,
        actorId: input.request.actorId,
        adapterType: input.request.adapterType,
        status: input.status,
        errorKind: maskSensitiveText(input.errorKind ?? ""),
        occurredAt: input.occurredAt,
        events: summarizeGatewayEvents(input.events)
      }
    });

    const botRole = input.request.reportBotRole ?? (input.request.adapterType === "codex" ? "codex_leader" : "claude_leader");
    const resultSummary = summarizeGatewayOutput(input.events) ?? "";
    const text = renderGatewayReportText(input);
    const idempotencyKey = "telegram-report:" + input.request.attemptId + ":" + input.status;

    await this.insertOutboxIdempotently({
      event_id: event.event_id,
      idempotency_key: idempotencyKey,
      target_kind: "telegram_bot",
      target: JSON.stringify({ kind: "telegram_bot", botRole, telegramChatId }),
      payload: {
        botRole,
        telegramChatId,
        text,
        binding: { kind: "event", eventId: event.event_id },
        idempotencyKey
      }
    });

    if (input.status === "completed" && input.request.reportBotRole === "auditor") {
      await this.recordAuditVerification(input, resultSummary, telegramChatId, event.event_id);
    }

    if (input.status === "completed") {
      await this.enqueueMultiAiAuditIfReady(input, telegramChatId, event.event_id);
    }

    if (input.status === "completed" && shouldRequestAutomaticAudit(input.request, resultSummary)) {
      const auditIdempotencyKey = "telegram-audit:" + input.request.attemptId + ":completed";
      await this.insertOutboxIdempotently({
        event_id: event.event_id,
        idempotency_key: auditIdempotencyKey,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "auditor", telegramChatId }),
        payload: {
          botRole: "auditor",
          telegramChatId,
          text: renderAutomaticAuditRequestText(input.request),
          keyboard: buildCompletionKeyboard(input.request.taskId),
          binding: { kind: "verification", verificationId: event.event_id },
          idempotencyKey: auditIdempotencyKey
        }
      });
    }
  }

  private async recordAuditVerification(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }, resultSummary: string, telegramChatId: string, sourceEventId: string): Promise<void> {
    if (!isUuid(input.request.taskId)) return;
    const verdict = inferVerificationVerdict(resultSummary);
    const existing = await this.client
      .request("GET", "/huai_verifications?task_id=eq." + encodeURIComponent(input.request.taskId) + "&target_version=eq." + encodeURIComponent(input.request.attemptId) + "&select=verification_id&limit=1")
      .then((response) => response.json<Array<{ verification_id: string }>>());
    if (existing.length === 0) {
      await this.client.request("POST", "/huai_verifications", {
        body: {
          task_id: input.request.taskId,
          target_version: input.request.attemptId,
          verdict,
          evidence: resultSummary || "감사 결과가 기록되었습니다.",
          required_fixes: verdict === "fail" ? resultSummary || "보완이 필요합니다." : null,
          recommendations: verdict === "pass" ? null : resultSummary || null,
          reverify_scope: verdict === "pass" ? null : "보완 후 변경 범위 재검증",
          verifier_actor_id: isUuid(input.request.actorId) ? input.request.actorId : null
        },
        prefer: "return=minimal"
      }).then((response) => response.expectOk());
    }

    if (verdict === "pass") {
      await this.insertOutboxIdempotently({
        event_id: sourceEventId,
        idempotency_key: "telegram-completion-review:" + input.request.attemptId,
        target_kind: "telegram_bot",
        target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId }),
        payload: {
          botRole: "platoon_leader",
          telegramChatId,
          text: "검증이 통과되었습니다. 완료 승인 또는 보완 여부를 선택해 주세요.",
          keyboard: buildCompletionKeyboard(input.request.taskId),
          binding: { kind: "verification", verificationId: sourceEventId },
          idempotencyKey: "telegram-completion-review:" + input.request.attemptId
        }
      });
    }
  }

  private async enqueueMultiAiAuditIfReady(input: {
    request: ExecutionRequest;
    status: "completed" | "failed" | "rejected";
    events: GatewayEvent[];
    errorKind?: string;
    occurredAt: string;
  }, telegramChatId: string, eventId: string): Promise<void> {
    const group = multiAiAttemptGroup(input.request.attemptId);
    if (!group) return;

    const rows = await this.client
      .request("GET", "/huai_events?event_type=eq.meaningful_intermediate_ready&select=event_id,payload,created_at&order=created_at.desc&limit=100")
      .then((response) => response.json<Array<{ event_id: string; payload: Record<string, unknown>; created_at?: string }>>());
    const related = rows.filter((row) => isCompletedMultiAiSibling(row.payload, input.request.taskId, group.baseAttemptId));
    const claude = related.find((row) => String(row.payload.attemptId) === group.baseAttemptId + "-claude");
    const codex = related.find((row) => String(row.payload.attemptId) === group.baseAttemptId + "-codex");
    if (!claude || !codex) return;

    const gatewayId = await this.fetchActiveGatewayId(input.request.roomId);
    if (!gatewayId) return;

    const auditAttemptId = group.baseAttemptId + "-audit";
    const auditRequest: ExecutionRequest = {
      ...input.request,
      attemptId: auditAttemptId,
      adapterType: "codex",
      actorId: input.request.actorId,
      prompt: buildMultiAiAuditPrompt(input.request.taskId, claude.payload, codex.payload),
      idempotencyKey: "multi-ai-audit:" + input.request.taskId + ":" + group.baseAttemptId,
      reportBotRole: "auditor"
    };

    await this.insertOutboxIdempotently({
      event_id: eventId,
      idempotency_key: "gateway:multi-ai-audit:" + input.request.taskId + ":" + group.baseAttemptId,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId }),
      payload: { executionRequest: auditRequest, telegramChatId }
    });
  }

  private async fetchActiveGatewayId(roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_gateway_instances?room_id=eq." + encodeURIComponent(roomId) + "&select=gateway_id,status&order=created_at.asc&limit=20")
      .then((response) => response.json<Array<{ gateway_id: string; status?: string }>>());
    return rows.find((row) => row.status === "online")?.gateway_id ?? rows.find((row) => row.status !== "disabled")?.gateway_id;
  }
  private async isTaskRunnable(taskId: string): Promise<boolean> {
    if (!isUuid(taskId)) return true;
    const dependencies = await this.client
      .request("GET", "/huai_task_dependencies?successor_task_id=eq." + encodeURIComponent(taskId) + "&is_blocking=eq.true&select=predecessor_task_id,dependency_type,is_blocking")
      .then((response) => response.json<Array<{ predecessor_task_id: string; dependency_type: string; is_blocking: boolean }>>());
    const blockingIds = dependencies
      .filter((dependency) => dependency.is_blocking && dependency.dependency_type !== "related")
      .map((dependency) => dependency.predecessor_task_id);
    if (blockingIds.length === 0) return true;

    const quoted = blockingIds.map((id) => '"' + escapePostgrestInValue(id) + '"').join(",");
    const predecessors = await this.client
      .request("GET", "/huai_tasks?task_id=in.(" + encodeURIComponent(quoted) + ")&select=task_id,status")
      .then((response) => response.json<Array<{ task_id: string; status: string }>>());
    const done = new Set(predecessors.filter((task) => isDependencySatisfiedStatus(task.status)).map((task) => task.task_id));
    return blockingIds.every((taskId) => done.has(taskId));
  }

  private async leaseOutbox(limit: number, leaseUntil: string, targetKind: "telegram_bot" | "local_gateway"): Promise<OutboxRecord[]> {
    const rows = await this.client.rpc<OutboxRow[]>("lease_huai_outbox", {
      p_limit: limit,
      p_locked_until: leaseUntil,
      p_target_kind: targetKind
    });
    return rows.map(toOutboxRecord);
  }

  private async patchOutbox(outboxId: string, body: Record<string, unknown>): Promise<void> {
    await this.client
      .request("PATCH", `/huai_outbox?huai_outbox_id=eq.${encodeURIComponent(outboxId)}&status=eq.processing`, {
        body,
        prefer: "return=representation"
      })
      .then((response) => response.json<unknown[]>())
      .then((rows) => {
        if (rows.length !== 1) throw new Error("outbox-state-conflict:patch");
      });
  }

  private async fetchRoomTelegramChatId(roomId: string): Promise<string> {
    const rows = await this.client
      .request("GET", `/huai_rooms?room_id=eq.${encodeURIComponent(roomId)}&select=telegram_chat_id`)
      .then((response) => response.json<Array<{ telegram_chat_id: string | number }>>());
    const value = rows[0]?.telegram_chat_id;
    if (value === undefined || value === null) throw new Error("room-telegram-chat-id-not-found");
    return String(value);
  }

  private async insertEventIdempotently(row: EventInsertRow): Promise<EventRow> {
    const response = await this.client.request("POST", "/huai_events", {
      body: row,
      prefer: "return=representation"
    });
    if (response.status !== 409) return response.json<EventRow[]>().then((rows) => requireSingle(rows, "event-insert-missing-row"));

    const existing = await this.client
      .request("GET", `/huai_events?idempotency_key=eq.${encodeURIComponent(row.idempotency_key)}&select=event_id,room_id,task_id,event_type,idempotency_key,payload,created_at`)
      .then((found) => found.json<EventRow[]>())
      .then((rows) => requireSingle(rows, "event-idempotency-conflict"));
    if (existing.event_type !== row.event_type) {
      throw new Error("event-idempotency-conflict");
    }
    return existing;
  }

  private async insertOutboxIdempotently(row: OutboxInsertRow): Promise<void> {
    const response = await this.client.request("POST", "/huai_outbox", {
      body: row,
      prefer: "return=representation"
    });
    if (response.status !== 409) {
      await response.expectOk();
      return;
    }

    const existing = await this.client
      .request("GET", `/huai_outbox?idempotency_key=eq.${encodeURIComponent(row.idempotency_key)}&select=idempotency_key,target_kind,target,payload`)
      .then((found) => found.json<Array<{ idempotency_key: string; target_kind: string; target: string; payload: Record<string, unknown> }>>())
      .then((rows) => requireSingle(rows, "outbox-idempotency-conflict"));
    if (existing.target_kind !== row.target_kind || existing.target !== row.target) {
      throw new Error("outbox-idempotency-conflict");
    }
  }
}


export function summarizeSupabaseSendResult(result: TelegramSendResult): Record<string, unknown> {
  return { telegramMessageId: result.telegramMessageId };
}

export function buildSupabaseOutboxStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseOutboxStore {
  return new SupabaseOutboxStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY")
  });
}

class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: SupabaseRuntimeConfig) {
    this.baseUrl = input.url.replace(/\/+$/, "");
    this.serviceRoleKey = input.serviceRoleKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async rpc<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rpc/${name}`, { body }).then((response) => response.json<T>());
  }

  async request(method: string, path: string, options: { body?: unknown; prefer?: string } = {}): Promise<SupabaseRestResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      method,
      headers: stripUndefined({
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: options.prefer
      }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return new SupabaseRestResponse(response);
  }
}

class SupabaseRestResponse {
  constructor(private readonly response: Response) {}

  get status(): number {
    return this.response.status;
  }

  async expectOk(): Promise<void> {
    if (!this.response.ok) {
      throw new Error(`supabase-rest-error:${this.response.status}:${maskSensitiveText(await safeResponseText(this.response))}`);
    }
  }

  async json<T>(): Promise<T> {
    await this.expectOk();
    if (this.response.status === 204) return undefined as T;
    return (await this.response.json()) as T;
  }
}

type OutboxRow = {
  outbox_id?: string;
  huai_outbox_id?: string;
  idempotency_key: string;
  target: string | OutboxTarget;
  payload: Record<string, unknown>;
  status: OutboxRecord["status"];
  attempts: number;
};

type EventRow = {
  event_id: string;
  room_id: string;
  task_id?: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at?: string;
};

type EventInsertRow = {
  room_id: string;
  task_id: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
};

type OutboxInsertRow = {
  event_id: string;
  idempotency_key: string;
  target_kind: "telegram_bot" | "local_gateway";
  target: string;
  payload: Record<string, unknown>;
};

function executionRequestFromOutbox(row: OutboxRecord): ExecutionRequest | undefined {
  const value = row.payload.executionRequest ?? row.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ExecutionRequest;
}

function isDependencySatisfiedStatus(status: string): boolean {
  return status === "completed" || status === "commander_completion_pending" || status === "completion_approval_pending";
}

function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
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

function parseTarget(target: string | OutboxTarget): OutboxTarget {
  if (typeof target !== "string") return target;
  const parsed = JSON.parse(target) as OutboxTarget;
  if (parsed.kind !== "telegram_bot" && parsed.kind !== "local_gateway") {
    throw new Error("invalid-outbox-target");
  }
  return parsed;
}

function stripUndefined(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function safeResponseText(response: Response): Promise<string> {
  return response.text().catch(() => "unreadable-response");
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}




function summarizeGatewayEvents(events: GatewayEvent[]): Array<Record<string, unknown>> {
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

function shouldRequestAutomaticAudit(request: ExecutionRequest, resultSummary: string): boolean {
  if (process.env.HUAI_AUTO_AUDIT_ENABLED !== "true") return false;
  if (request.reportBotRole === "auditor") return false;

  const prompt = request.prompt.toLowerCase();
  const summary = resultSummary.toLowerCase();
  const combined = `${prompt}\n${summary}`;

  const explicitAuditWords = [
    "\uAC80\uC99D", "\uAC10\uC0AC", "\uBCF4\uC548", "\uCDE8\uC57D", "security", "audit", "verify", "review"
  ];
  if (explicitAuditWords.some((keyword) => combined.includes(keyword.toLowerCase()))) return true;

  const meaningfulOutcomeWords = [
    "\uAD6C\uD604 \uC644\uB8CC", "\uC218\uC815 \uC644\uB8CC", "\uD14C\uC2A4\uD2B8 \uD1B5\uACFC", "\uD30C\uC77C \uC0DD\uC131", "\uBB38\uC11C \uC791\uC131",
    "\uBC30\uD3EC", "\uB9C8\uC774\uADF8\uB808\uC774\uC158", "migration", "schema", "supabase", "typecheck", "build passed", "tests passed"
  ];
  return meaningfulOutcomeWords.some((keyword) => combined.includes(keyword.toLowerCase()));
}

function multiAiAttemptGroup(attemptId: string): { baseAttemptId: string; role: "claude" | "codex" } | undefined {
  if (attemptId.endsWith("-claude")) return { baseAttemptId: attemptId.slice(0, -"-claude".length), role: "claude" };
  if (attemptId.endsWith("-codex")) return { baseAttemptId: attemptId.slice(0, -"-codex".length), role: "codex" };
  return undefined;
}

function isCompletedMultiAiSibling(payload: Record<string, unknown>, taskId: string, baseAttemptId: string): boolean {
  return payload.taskId === taskId && payload.status === "completed" && (payload.attemptId === baseAttemptId + "-claude" || payload.attemptId === baseAttemptId + "-codex");
}

function buildMultiAiAuditPrompt(taskId: string, claudePayload: Record<string, unknown>, codexPayload: Record<string, unknown>): string {
  return [
    "HuAI Collab Chatroom System의 다중 AI 협의 결과를 독립 감사하세요.",
    "대상 작업: " + taskId,
    "판정 기준: 두 작업자 결과의 정확성, 상호 일치성, 누락된 실행 조치, 사용자에게 필요한 다음 선택지.",
    "보고: 사람이 알아야 할 결론과 필요한 조치만 간결하게 작성하세요.",
    "금지: 내부 JSON, hook log, stack trace, token, API key, 원문 시크릿 출력.",
    "",
    "ClaudeBot 결과:",
    summarizePersistedGatewayPayload(claudePayload),
    "",
    "CodexBot 결과:",
    summarizePersistedGatewayPayload(codexPayload)
  ].join("\n");
}

function summarizePersistedGatewayPayload(payload: Record<string, unknown>): string {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const stdoutTexts = events
    .filter((event) => event && typeof event === "object" && (event as { type?: unknown }).type === "stdout")
    .map((event) => String((event as { text?: unknown }).text ?? ""));
  const otherTexts = events
    .filter((event) => event && typeof event === "object" && (event as { type?: unknown }).type !== "stderr")
    .map((event) => String((event as { text?: unknown }).text ?? ""));
  const texts = (stdoutTexts.length > 0 ? stdoutTexts : otherTexts)
    .map((text) => extractCodexAgentMessage(text) ?? text)
    .map((text) => cleanHumanVisibleOutput(text) ?? "")
    .filter(Boolean);
  return truncate(texts.at(-1) ?? String(payload.errorKind ?? payload.status ?? "결과 요약 없음"), 3200);
}
function inferVerificationVerdict(summary: string): "pass" | "conditional_pass" | "fail" {
  const lower = summary.toLowerCase();
  if (/실패|불합격|문제 있음|보완 필요|수정 필요|fail|failed|reject/.test(lower)) return "fail";
  if (/조건부|일부|주의|conditional/.test(lower)) return "conditional_pass";
  if (/통과|승인|문제 없음|완료|pass|passed|ok/.test(lower)) return "pass";
  return "conditional_pass";
}

function renderAutomaticAuditRequestText(request: ExecutionRequest): string {
  const actor = request.adapterType === "codex" ? "CodexBot" : "ClaudeBot";
  return [
    "\uAC80\uC99D \uC694\uCCAD: " + request.taskId,
    "\uC791\uC5C5\uC790: " + actor,
    "\uC2E4\uD589 \uACB0\uACFC\uB97C \uB3C5\uB9BD \uAC80\uC99D\uD574 \uC8FC\uC138\uC694.",
    "\uBC84\uD2BC: \u21BB \uC7AC\uAC80 / \u270E \uBCF4\uC644 / \u2713 \uC644\uB8CC"
  ].join("\n");
}

export function renderGatewayReportText(input: {
  request: ExecutionRequest;
  status: "completed" | "failed" | "rejected";
  events: GatewayEvent[];
  errorKind?: string;
}): string {
  if (input.status === "completed") {
    const summary = summarizeGatewayOutput(input.events);
    return summary ? ["\uC791\uC5C5 \uC2E4\uD589 \uC644\uB8CC", "\uACB0\uACFC:", summary].join("\n") : "\uC791\uC5C5 \uC2E4\uD589 \uC644\uB8CC.";
  }

  const outputSummary = summarizeGatewayOutput(input.events);
  const reason = humanReadableGatewayError(input.errorKind ?? outputSummary ?? "failed", outputSummary);
  return ["\uC791\uC5C5 \uC2E4\uD589 \uC2E4\uD328", "\uC6D0\uC778: " + reason, "\uD544\uC694\uD558\uBA74 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uC791\uC5C5\uC790 \uBCF4\uC644\uC744 \uC694\uCCAD\uD574 \uC8FC\uC138\uC694."].join("\n");
}
function summarizeGatewayOutput(events: GatewayEvent[]): string | undefined {
  const stdout = [...events].reverse().find((event): event is GatewayEvent & { type: "stdout"; text: string } =>
    event.type === "stdout" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const stderr = [...events].reverse().find((event): event is GatewayEvent & { type: "stderr"; text: string } =>
    event.type === "stderr" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const text = stdout?.text ?? stderr?.text;
  if (!text) return undefined;
  const agentMessage = extractCodexAgentMessage(text);
  const visible = cleanHumanVisibleOutput(agentMessage ?? text);
  return visible ? maskSensitiveText(visible) : undefined;
}

function cleanHumanVisibleOutput(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isInternalOutputLine(line))
    .filter((line) => !isLowValueHumanLine(line));
  const summarized = compactHumanVisibleLines(lines);
  return summarized || undefined;
}

function compactHumanVisibleLines(lines: string[]): string {
  const important = lines.filter(isImportantHumanLine);
  const selected = (important.length > 0 ? important : lines).slice(0, 6);
  return truncate(selected.join("\n").trim(), 3200);
}

function isImportantHumanLine(line: string): boolean {
  const importantWords = [
    "\uACB0\uB860", "\uC810\uC218", "\uC644\uC131\uB3C4", "\uD310\uC815", "\uC6D0\uC778", "\uD544\uC694", "\uC870\uCE58",
    "\uC218\uC815", "\uBCF4\uC644", "\uC2E4\uD328", "\uC644\uB8CC", "\uD1B5\uACFC", "\uC2B9\uC778", "\uBD88\uAC00",
    "\uC704\uD5D8", "\uC8FC\uC758", "\uB2E4\uC74C", "secret", "token", "error", "failed", "passed"
  ];
  const lower = line.toLowerCase();
  return importantWords.some((word) => lower.includes(word.toLowerCase()));
}

function isLowValueHumanLine(line: string): boolean {
  const lowValuePrefixes = [
    "\uD83D\uDCC1", "\uD83D\uDCC4", "\uAC80\uC99D \uC81C\uD55C", "\uC774\uBC88 \uD658\uACBD\uC5D0\uC11C",
    "\uB610\uD55C Dynamic Workflow", "\uC624\uCC28 \uBC94\uC704", "C:\\"
  ];
  return (
    /^\|/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^[-*]\s*$/.test(line) ||
    /^[A-Z_]+:/.test(line) ||
    lowValuePrefixes.some((prefix) => line.startsWith(prefix)) ||
    /node_modules|dist\/|\.json|\.ts|\.js|OPERATION_STATUS\.md/.test(line)
  );
}
function isInternalOutputLine(line: string): boolean {
  return (
    /^```/.test(line) ||
    line.startsWith("{") ||
    line.startsWith("[") ||
    /^[}\]],?$/.test(line) ||
    /^"[^"\r\n]+"\s*:/.test(line) ||
    /^at\s+\S+\s+\(.+?:\d+:\d+\)$/i.test(line) ||
    /^(?:\d{4}-\d{2}-\d{2}[T\s]\S+\s+)?(?:DEBUG|INFO|WARN|ERROR|TRACE)\b/i.test(line) ||
    /^(?:stdout|stderr|stack|trace|payload|rawOutput)\s*[:=]/i.test(line) ||
    /^Session(Start|End) hook/i.test(line) ||
    /^Hook\s/i.test(line) ||
    /^\[DEBUG\]/i.test(line) ||
    /^\[INFO\]/i.test(line) ||
    /^Skill descriptions were shortened/i.test(line) ||
    /^clamping SessionEnd hook timeout/i.test(line) ||
    /^Assertion failed:/i.test(line) ||
    /^Node\.js v/i.test(line) ||
    /^EXECUTION\s+(COMPLETED|FAILED|REJECTED)\s*:?$/i.test(line) ||
    /^(OUTPUT|ERROR|STDOUT|STDERR)\s*:?$/i.test(line)
  );
}
function humanReadableGatewayError(error: string, outputSummary?: string): string {
  const masked = maskSensitiveText(error);
  const combined = masked + (outputSummary ? "\n" + outputSummary : "");
  if (/hit your session limit|session limit|resets\s+\d/i.test(combined)) return "Claude Code 사용 한도에 도달했습니다. 표시된 reset 시간 이후 다시 시도해야 합니다.";
  if (/BUTTON_DATA_INVALID/i.test(masked)) return "\uD154\uB808\uADF8\uB7A8 \uBC84\uD2BC \uB370\uC774\uD130\uAC00 \uB108\uBB34 \uAE38\uC5B4 \uC804\uC1A1\uC774 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.";
  if (/process-timeout/i.test(masked)) return "\uC791\uC5C5 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.";
  if (/spawn .*ENOENT/i.test(masked)) return "\uC2E4\uD589 \uD504\uB85C\uADF8\uB7A8\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  if (/exit-code-\d+/i.test(masked)) return "\uC2E4\uD589 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.";
  return "실행 중 내부 오류가 발생했습니다. 상세 로그는 운영 기록에서 확인해 주세요.";
}
function extractCodexAgentMessage(text: string): string | undefined {
  let latest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: unknown }; text?: unknown };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        latest = parsed.item.text;
      } else if (parsed.type === "agent_message" && typeof parsed.text === "string") {
        latest = parsed.text;
      }
    } catch {
      continue;
    }
  }
  return latest;
}
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength) + "...";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireSingle<T>(rows: T[], error: string): T {
  if (rows.length !== 1) throw new Error(error);
  return rows[0] as T;
}







