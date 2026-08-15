import { randomUUID } from "node:crypto";
import {
  TelegramUpdateEnvelope,
  type NormalizedTelegramInput,
  type TelegramCallbackAction
} from "../../../packages/contracts/src/index.js";
import {
  handleTelegramInput,
  type ExecutionRequestDefaults,
  type RoomAuthorizationContext,
  type TelegramInputHandlingPorts
} from "../../../packages/orchestrator/src/index.js";
import { type OrchestratorPersistencePort } from "./persistence.js";

// Mini App 승인 버튼은 huai_approvals 에 기록만 하고 그 자체로는 아무 실행도
// 일으키지 않는다(조사 확정 사실). 유일한 실행 트리거는 huai_outbox 에
// target_kind='local_gateway' pending 행이 들어가는 것이고, 그건
// SupabaseBotServiceStore.commitTelegramInputResult 안의 hydrateExecutionOutboxPrompts
// 가 만든다. 이 폴러는 그 경로를 그대로 재사용한다 — Telegram 이 만드는 것과
// 똑같은 합성 콜백 입력을 만들어 handleTelegramInput → commitTelegramInputResult 로
// 태우는 것 말고는 아무 로직도 새로 만들지 않는다. 승인/실행 판단 로직을 여기
// 복제하면 Telegram 승인과 Mini App 승인이 다른 프롬프트로 다른 결과를 낼 위험이
// 생긴다 — 그게 이 파일이 존재하는 유일한 이유(0 복제)를 깨는 것이다.
//
// huai_approvals 는 append-only 라(schema.sql 의 huai_approvals_append_only 트리거)
// "처리됨" 표시를 원장에 못 쓴다. 대신:
//   - huai_miniapp_decision_cursor: 스캔 시작점 최적화용 워터마크(싱글톤 1행)
//   - huai_miniapp_decision_processed: 이 폴러가 이미 판단을 끝낸 승인 행의 결과
// 두 테이블 다 마이그레이션을 여기서 쓰지 않는다(소대장 지시) — 정확한 DDL 은
// 팀 보고에 첨부했다.

export type MiniAppDecisionPollerRoom = {
  roomId: string;
  telegramChatId: string;
};

export type MiniAppDecisionOutcome =
  | "replayed"
  | "skipped_duplicate"
  | "skipped_already_executed"
  | "skipped_unsupported_stage"
  | "skipped_unauthorized"
  | "failed";

export type MiniAppDecisionOutcomeEvent = {
  approvalId: string;
  roomId: string;
  entityRef: string | null;
  stage: string;
  outcome: MiniAppDecisionOutcome;
  reason?: string;
};

export type MiniAppDecisionPollerOptions = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  rooms: readonly MiniAppDecisionPollerRoom[];
  authorization: RoomAuthorizationContext;
  // local-runtime.ts 가 A-4 에서 만든 방별 실행 기본값 맵을 그대로 재사용한다.
  executionDefaultsByChatId: ReadonlyMap<string, ExecutionRequestDefaults | undefined>;
  persistence: OrchestratorPersistencePort;
  limit: number;
  now?: () => Date;
  makeId?: (prefix: string) => string;
  onDecisionOutcome?: (event: MiniAppDecisionOutcomeEvent) => void;
};

export type MiniAppDecisionPollResult = {
  fetched: number;
  replayed: number;
  skipped: number;
  failed: number;
};

export type MiniAppDecisionPollerHandle = {
  stop(): void;
};

// huai_approvals.(stage, decision) -> Telegram 콜백 액션. applyOwnerCallback 이
// 이미 처리하는 7개 액션으로만 매핑한다 — 매핑이 없는 조합(예: midpoint_approval,
// commander_completion, final_approval/rejected)은 Mini App 이 아직 안 쓰거나
// applyOwnerCallback 바깥의 다른 경로에서만 나오는 이벤트로 보고 일부러 미지원
// 처리한다(skipped_unsupported_stage). 여기서 새 분기를 만들면 그게 곧 로직
// 복제이므로, 지원 범위를 넓혀야 하면 orchestrator 쪽에 콜백 액션을 먼저 추가해야 한다.
const CALLBACK_ACTION_BY_STAGE_DECISION: Readonly<Record<string, Readonly<Record<string, TelegramCallbackAction>>>> = {
  task_approval: {
    approved: "approve",
    rejected: "reject",
    revision_requested: "revise"
  },
  final_approval: {
    approved: "final_approve",
    revision_requested: "request_revision"
  },
  cancellation: {
    cancelled: "cancel"
  }
};

const MINIAPP_SYNTHETIC_BOT_ID = "miniapp-decision-poller";
const MINIAPP_SYNTHETIC_BOT_USERNAME = "miniapp";

export async function runMiniAppDecisionPollOnce(options: MiniAppDecisionPollerOptions): Promise<MiniAppDecisionPollResult> {
  const client = new MiniAppRestClient(options);
  const roomsById = new Map(options.rooms.map((room) => [room.roomId, room]));

  const cursor = await client.fetchCursor();
  const rows = await client.fetchApprovalsSince(cursor, options.limit);
  if (rows.length === 0) return { fetched: 0, replayed: 0, skipped: 0, failed: 0 };

  const alreadyProcessed = await client.fetchProcessedSet(rows.map((row) => row.approval_id));

  let replayed = 0;
  let skipped = 0;
  let failed = 0;
  // 이번 배치에서 처음 만난 실패 행의 created_at. 커서를 이 지점 이전으로 묶어둬야
  // 다음 주기에 이 행이 다시 잡힌다 — 안 그러면 방 하나가 영구 고장났을 때 그
  // 뒤에 줄 선(다른 방일 수도 있는) 결정들까지 영원히 못 잡히는 새로운 아사(starvation)
  // 버그가 생긴다(이건 A-5 에서 고친 배치 중단 버그와 같은 종류의 함정이다).
  let earliestUnresolvedCreatedAt: string | undefined;

  for (const row of rows) {
    if (alreadyProcessed.has(row.approval_id)) continue;

    const event = await resolveDecision(row, roomsById, options, client);
    options.onDecisionOutcome?.(event);

    if (event.outcome === "failed") {
      failed += 1;
      if (earliestUnresolvedCreatedAt === undefined) earliestUnresolvedCreatedAt = row.created_at;
      continue; // 이 행만 미해결로 남기고 배치의 나머지는 계속 처리한다.
    }

    await client.markProcessed(row.approval_id, event.outcome, event.reason);
    if (event.outcome === "replayed") replayed += 1;
    else skipped += 1;
  }

  const newCursor = earliestUnresolvedCreatedAt ?? rows[rows.length - 1]?.created_at;
  if (newCursor) await client.advanceCursor(newCursor);

  return { fetched: rows.length, replayed, skipped, failed };
}

export function startMiniAppDecisionPollerLoop(
  options: MiniAppDecisionPollerOptions & { intervalMs: number; onError?: (error: unknown) => void }
): MiniAppDecisionPollerHandle {
  let stopped = false;
  let running = false;

  const tick = () => {
    if (stopped || running) return;
    running = true;
    void runMiniAppDecisionPollOnce(options)
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

async function resolveDecision(
  row: ApprovalRow,
  roomsById: Map<string, MiniAppDecisionPollerRoom>,
  options: MiniAppDecisionPollerOptions,
  client: MiniAppRestClient
): Promise<MiniAppDecisionOutcomeEvent> {
  const base = { approvalId: row.approval_id, roomId: row.room_id, entityRef: row.entity_ref, stage: row.stage };

  const room = roomsById.get(row.room_id);
  if (!room) return { ...base, outcome: "failed", reason: `unknown-room:${row.room_id}` };
  if (!row.entity_ref) return { ...base, outcome: "failed", reason: "missing-entity-ref" };

  const action = CALLBACK_ACTION_BY_STAGE_DECISION[row.stage]?.[row.decision];
  if (!action) return { ...base, outcome: "skipped_unsupported_stage", reason: `unsupported:${row.stage}:${row.decision}` };

  // 폴러는 huai_approvals 를 origin 구분 없이 전부 읽는다 — Telegram 실시간 흐름이
  // 이미 처리한 결정도 이 테이블에 행을 남기므로(recordApprovals), 그 행도 그대로
  // fetchApprovalsSince 에 걸려 들어온다. Telegram 쪽은 이미 같은 idempotency_key 로
  // huai_events 행을 만들어 뒀을 것이다 — 그 상태에서 그대로 재생을 시도하면
  // commitTelegramInputResult 의 huai_events insert 가 그 키와 충돌해서 던진다
  // (huai_events 는 409 를 흡수하지 않는다). 예외는 "failed" 로 남아 매 주기 영원히
  // 재시도되는 유령 실패가 된다 — 다른 방을 막지는 않지만(A-5 격리는 여전히 지켜짐)
  // 로그만 영원히 스팸한다. idempotency_key 가 있는 행은 재생을 시도하기 전에 그
  // 키로 huai_events 가 이미 존재하는지 먼저 물어서, 있으면 "이미 실행됨"으로
  // 즉시 종결 처리한다(회귀 테스트: "a decision huai_approvals row that Telegram's
  // real-time flow already executed..." in miniapp-decision-poller.test.ts).
  if (row.idempotency_key) {
    const alreadyExecuted = await client.eventAlreadyRecorded(row.idempotency_key);
    if (alreadyExecuted) return { ...base, outcome: "skipped_already_executed" };
  }

  // 같은 (room, entity_ref, stage, decision) 에 대한 결정이 Telegram 과 Mini App
  // 양쪽에서, 혹은 Mini App 에서 두 번 올 수 있다. 시간순 첫 행만 "진짜" 결정으로
  // 재생하고 나머지는 중복으로 스킵한다 — 그래야 같은 승인이 두 번 실행되지 않는다.
  //
  // decision 을 반드시 키에 넣어야 한다. task 는 생애주기 동안 같은 (entity_ref,
  // stage) 로 정당하게 재결정될 수 있다 — 예: 보완 요청(revision_requested) →
  // 재작업 → 완료 승인(approved). decision 없이 (room, entity_ref, stage) 만 보면
  // 두 번째(진짜 새 결정인 approved)가 첫 번째(revision_requested)의 "중복"으로
  // 걸러진다 — 재작업이 끝났는데 완료 승인이 조용히 무시되고 task 가 영영 안
  // 끝나는 사고가 난다(회귀 테스트: "a different decision for the same
  // entity+stage..." in miniapp-decision-poller.test.ts). 반대로 같은 decision 이
  // 두 번(Telegram 과 Mini App 양쪽에서, 혹은 중복 클릭으로) 오면 이 키로 여전히
  // 걸러진다 — 크로스 플랫폼 중복 실행 방지라는 원래 목적은 유지된다.
  //
  // 기존 Telegram 경로 자체의 멱등키(updateId 기반, 중복 클릭 시 재실행되는 기존
  // 알려진 갭)는 이번 범위 밖이라 손대지 않았다 — 이 검사는 Mini App 쪽 창구만
  // 추가로 방어한다.
  //
  // 재검토(소대장 지시, 2026-08-15): eventAlreadyRecorded·아웃박스 idempotency
  // (gateway:execution:<entityId>, Delta)·processed-set 세 층이 이미 있는데 이
  // tuple dedup 이 여전히 필요한지 실측했다 — 필요하다. 이유:
  //   - final_approval/approved 는 makeRoleMessageOutbox 알림만 만들고 실행
  //     아웃박스를 아예 안 만든다(orchestrator/index.ts) — 아웃박스 층이 안 걸리는
  //     경로다. cancellation 도 마찬가지 구조다.
  //   - eventAlreadyRecorded 는 "이 행 자신의 idempotency_key" 로만 판단한다.
  //     크로스 플랫폼 중복(서로 다른 approval_id, 서로 다른 idempotency_key, 같은
  //     실제 결정)은 서로 다른 키를 가지므로 그 검사를 통과한다.
  //   - 이 tuple dedup 없이 그대로 두면, 두 번째(진짜 중복인) 결정이
  //     applyTaskTransitions 까지 도달하고, task 가 이미 전이된 뒤라
  //     transitionTaskStatus 가 {allowed:false} 를 반환해 supabase-store.ts 가
  //     `task-transition-not-allowed` 를 던진다 — huai_events unique 충돌과
  //     똑같은 모양의 "실패는 processed 로 안 남아 매 주기 영원히 재시도되는
  //     유령 실패" 가 다시 열린다. 실측 확인(mutation: 이 검사를 끄고 재현) —
  //     `reason: "task-transition-not-allowed:owner_final_approved:completed:
  //     transition-not-allowed"` 로 정확히 재현됨.
  // 결론: tuple dedup 은 (huai_events 층·아웃박스 층이 안 걸리는 결정 유형에 대한)
  // 마지막 방어선이라 제거하지 않는다. 회귀 테스트: "tuple dedup is still
  // required..." in miniapp-decision-poller.test.ts.
  const isAuthoritative = await client.isFirstDecisionForEntity(row.room_id, row.entity_ref, row.stage, row.decision, row.approval_id);
  if (!isAuthoritative) return { ...base, outcome: "skipped_duplicate" };

  const envelope = buildSyntheticEnvelope(room.telegramChatId, row);
  const input: NormalizedTelegramInput = {
    kind: "callback",
    envelope,
    callback: {
      entity: isUuid(row.entity_ref) ? "task" : "proposal",
      entityId: row.entity_ref,
      action
    }
  };

  const ports: TelegramInputHandlingPorts = {
    makeId: options.makeId ?? ((prefix) => `${prefix}_${randomUUID()}`),
    now: () => (options.now ? options.now() : new Date()).toISOString(),
    executionDefaults: options.executionDefaultsByChatId.get(room.telegramChatId),
    // Delta 의 orchestrator 훅. 원본 huai_approvals 행의 idempotency_key 를 그대로
    // 주입하면, 폴러가 재생하며 만드는 이벤트가 recordApprovals 의 huai_approvals
    // insert 에서 409 로 흡수돼 원장에 중복 행이 안 쌓인다(null 이면 undefined 로
    // 넘겨 기존과 동일하게 자동 생성).
    approvalEventIdempotencyKey: row.idempotency_key ?? undefined
  };

  let result: ReturnType<typeof handleTelegramInput>;
  try {
    // 승인/거절/실행 판단은 전부 여기서 Telegram 과 동일한 함수가 그대로 한다.
    // executionDefaults 가 없는 방이면(A-5) orchestrator 가 (Delta 분대의 수정 이후)
    // 던지지 않고 "이 방은 아직 실행 준비가 되지 않았습니다" 안내 메시지를
    // accepted:true 로 돌려준다 — 그래서 그 경우도 여기선 정상적으로 재생(replayed)
    // 처리된다. 이 try/catch 는 그 경로가 아니라, 인가 판정 로직 자체가 예기치 않게
    // 던지는 등 orchestrator 의 진짜 버그/예외를 방 하나로 격리하기 위한 안전망이다.
    result = handleTelegramInput(input, options.authorization, ports);
  } catch (error) {
    return { ...base, outcome: "failed", reason: maskMiniAppError(error) };
  }

  if (!result.accepted) {
    return {
      ...base,
      outcome: "skipped_unauthorized",
      reason: result.authorization.allowed ? "unexpected-not-accepted" : result.authorization.reason
    };
  }

  try {
    // persistence.ts 를 거치지 않고 commitTelegramInputResult 를 직접 부른다.
    // markTelegramUpdateProcessed 는 idempotencyKey 가 "telegram-update:<botId>:<updateId>"
    // 형식을 강제하는데, 이 합성 경로는 Telegram update 가 아니라서 그 형식을 만족시킬
    // 필요도 이유도 없다 — persistence.ts 를 타면 이 파싱에서 예외가 난다.
    await options.persistence.commitTelegramInputResult({
      message: { input, idempotencyKey: `miniapp:${row.approval_id}`, receivedAt: new Date().toISOString() },
      result
    });
  } catch (error) {
    return { ...base, outcome: "failed", reason: maskMiniAppError(error) };
  }

  return { ...base, outcome: "replayed" };
}

function buildSyntheticEnvelope(telegramChatId: string, row: ApprovalRow): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope(
    MINIAPP_SYNTHETIC_BOT_ID,
    MINIAPP_SYNTHETIC_BOT_USERNAME,
    "platoon_leader",
    `miniapp-${row.approval_id}`,
    telegramChatId,
    undefined,
    String(row.decider_telegram_user_id),
    false,
    undefined,
    undefined
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function maskMiniAppError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization|service_role)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}

type ApprovalRow = {
  approval_id: string;
  task_id: string | null;
  room_id: string;
  stage: string;
  decider_telegram_user_id: number | string;
  decision: string;
  reason: string | null;
  created_at: string;
  idempotency_key: string | null;
  entity_ref: string | null;
};

// 이 파일 전용 최소 REST 클라이언트. apps/bot-service/src 안에 이미 같은 모양의
// 클라이언트가 두 벌(supabase-runtime-loader.ts, supabase-store.ts) 있는데, 둘 다
// 비공개(unexported) 클래스라 재사용이 안 되고, 이건 기존 코드베이스가 이미 택한
// 패턴(파일마다 자기 몫의 얇은 fetch 래퍼)이라 여기서도 그대로 따른다 — 복제 금지
// 원칙은 승인/실행 판단 로직에 대한 것이지 이 정도 배관 코드까지는 아니다.
class MiniAppRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MiniAppDecisionPollerOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.serviceRoleKey = options.serviceRoleKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchCursor(): Promise<string> {
    const rows = await this.get<Array<{ last_seen_created_at: string }>>(
      "/huai_miniapp_decision_cursor?id=eq.1&select=last_seen_created_at&limit=1"
    );
    return rows[0]?.last_seen_created_at ?? new Date(0).toISOString();
  }

  async fetchApprovalsSince(cursor: string, limit: number): Promise<ApprovalRow[]> {
    return this.get<ApprovalRow[]>(
      "/huai_approvals?created_at=gte." + encodeURIComponent(cursor) +
        "&order=created_at.asc,approval_id.asc&limit=" + limit +
        "&select=approval_id,task_id,room_id,stage,decider_telegram_user_id,decision,reason,created_at,idempotency_key,entity_ref"
    );
  }

  async fetchProcessedSet(approvalIds: readonly string[]): Promise<Set<string>> {
    if (approvalIds.length === 0) return new Set();
    const quoted = approvalIds.map((id) => `"${escapePostgrestInValue(id)}"`).join(",");
    const rows = await this.get<Array<{ approval_id: string }>>(
      "/huai_miniapp_decision_processed?approval_id=in.(" + encodeURIComponent(quoted) + ")&select=approval_id"
    );
    return new Set(rows.map((row) => row.approval_id));
  }

  async isFirstDecisionForEntity(roomId: string, entityRef: string, stage: string, decision: string, approvalId: string): Promise<boolean> {
    const rows = await this.get<Array<{ approval_id: string }>>(
      "/huai_approvals?room_id=eq." + encodeURIComponent(roomId) +
        "&entity_ref=eq." + encodeURIComponent(entityRef) +
        "&stage=eq." + encodeURIComponent(stage) +
        "&decision=eq." + encodeURIComponent(decision) +
        "&order=created_at.asc,approval_id.asc&limit=1&select=approval_id"
    );
    return rows[0]?.approval_id === approvalId;
  }

  // Telegram 실시간 흐름이 이미 같은 idempotency_key 로 huai_events 행을 만들어
  // 뒀는가. huai_events.idempotency_key 는 not null unique 라 이 조회만으로
  // "이미 실행됐다"를 안전하게 판정할 수 있다.
  async eventAlreadyRecorded(idempotencyKey: string): Promise<boolean> {
    const rows = await this.get<Array<{ event_id: string }>>(
      "/huai_events?idempotency_key=eq." + encodeURIComponent(idempotencyKey) + "&select=event_id&limit=1"
    );
    return rows.length > 0;
  }

  async markProcessed(approvalId: string, outcome: MiniAppDecisionOutcome, detail: string | undefined): Promise<void> {
    const response = await this.request("POST", "/huai_miniapp_decision_processed", {
      body: { approval_id: approvalId, outcome, detail: detail ?? null },
      prefer: "return=minimal"
    });
    if (response.status === 409) return; // 이미 처리 표시됨(경합) — 그대로 두면 된다.
    await expectOk(response);
  }

  async advanceCursor(lastSeenCreatedAt: string): Promise<void> {
    const response = await this.request("POST", "/huai_miniapp_decision_cursor?on_conflict=id", {
      body: { id: 1, last_seen_created_at: lastSeenCreatedAt, updated_at: new Date().toISOString() },
      prefer: "resolution=merge-duplicates,return=minimal"
    });
    await expectOk(response);
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.request("GET", path);
    await expectOk(response);
    return (await response.json()) as T;
  }

  private async request(method: string, path: string, options: { body?: unknown; prefer?: string } = {}): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      method,
      headers: stripUndefined({
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: options.prefer
      }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  }
}

async function expectOk(response: Response): Promise<void> {
  if (!response.ok && response.status !== 409) {
    const text = await response.text().catch(() => "unreadable-response");
    throw new Error(`miniapp-decision-poller-http-error:${response.status}:${maskMiniAppError(new Error(text))}`);
  }
}

function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripUndefined(headers: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
