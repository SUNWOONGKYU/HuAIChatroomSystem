// 순수 핸들러 — Deno.* 를 참조하지 않는다. index.ts 가 실제 Supabase 호출을 주입한다.
// (miniapp-proposals/handler.ts 와 같은 이유 — node --test 로 회귀 테스트를 돌리기 위함.)
//
// 이 파일은 두 가지 결정을 받는다. 요청 body 에 taskId 또는 proposalId 중 정확히 하나가
// 있어야 하고, 그걸로 어느 경로인지 가른다:
//   - taskId  → 기존 huai_tasks 기반 결정. Mini App 이 실제로 제공하는 건 완료 단계
//     (commander_completion_pending/completion_approval_pending, 둘 다 stage='final_approval')의
//     final_approve/request_revision 과, 어느 상태에서나 가능한 cancel 뿐이다 — 아래
//     STAGE_BY_STATUS/FINAL_APPROVAL_ALLOWED_ACTIONS 주석 참고(Telegram 에 없는 결정 창구를
//     Mini App 이 새로 만들지 않는다는 원칙에 따라 mid_approval_pending 과 완료 단계 반려는
//     의도적으로 뺐다).
//   - proposalId → 아직 huai_tasks 행이 없는 제안 자체에 대한 최초 승인/거부/보완요청
//
// 두 경로 모두 같은 계약으로 huai_approvals 에 쓴다 — 이유: apps/bot-service/src/supabase-store.ts:201-231
// recordApprovals 가 Telegram 콜백 승인에 대해 이미 이렇게 하고 있다(task/proposal 구분 없이
// 같은 테이블, 같은 컬럼). 그 함수가 하는 정확한 판단을 그대로 따른다:
//   - entity_ref: 받은 식별자(taskId 또는 proposalId)를 그대로 보존한다. 형식을 파싱하지 않는다.
//   - task_id: entity_ref 가 순수 UUID 일 때만 채운다("proposal_<uuid>", "p_<16hex>" 는 접두어/축약이
//     붙어 있어 isUuid() 를 통과하지 못하므로, 오늘 존재하는 두 제안 id 형식은 항상 task_id=null 이 된다 —
//     recordApprovals:211 의 `task_id: isUuid(entityRef) ? entityRef : null` 과 동일 로직).
//
// 제안 결정은 huai_can_act_in_room() 을 아예 타지 않는다 — Telegram 콜백 경로의 requiresOwner()
// (packages/orchestrator/src/index.ts:851-855, "콜백이면 무조건 owner")가 제안 단계(entity='proposal')
// 에도 그대로 적용되는 정책이라, task 경로처럼 권한 배열을 볼 여지 자체가 없다. owner 인지만 본다.
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import type { MiniAppAuthResult } from "../_shared/types.ts";

export type ActionName = "approve" | "reject" | "request_revision" | "final_approve" | "cancel";
// 제안 단계에서 의미가 있는 액션만. final_approve/cancel 은 huai_tasks 가 있어야만 의미가
// 있는 개념(최종 완료 승인, 실행 중 취소)이라 제안에는 없다.
export type ProposalActionName = "approve" | "reject" | "request_revision";

// huai_approvals.decision 은 ('approved','rejected','revision_requested','cancelled') 만 허용한다
// (schema.sql huai_approvals_decision_check). 'reverify' 는 결정이 아니라 요청이라 이 enum에
// 맞지 않아 v1 범위에서 뺐다 — 승인 버튼이 아니라 별도 성격의 액션이라 판단.
export const ACTION_META: Record<
  ActionName,
  { decision: "approved" | "rejected" | "revision_requested" | "cancelled"; permission: string }
> = {
  approve: { decision: "approved", permission: "task:approve" },
  reject: { decision: "rejected", permission: "task:reject" },
  request_revision: { decision: "revision_requested", permission: "task:create" },
  final_approve: { decision: "approved", permission: "task:final_approve" },
  cancel: { decision: "cancelled", permission: "task:cancel" }
};

// 제안 단계 결정의 (stage, decision) — apps/bot-service/src/supabase-store.ts:1335-1338
// approvalRecordForEvent 의 매핑과 동일하다: owner_task_approved/owner_task_rejected/
// proposal_rejected/proposal_revision_requested 전부 stage='task_approval' 이다.
const PROPOSAL_ACTION_META: Record<ProposalActionName, { decision: "approved" | "rejected" | "revision_requested" }> = {
  approve: { decision: "approved" },
  reject: { decision: "rejected" },
  request_revision: { decision: "revision_requested" }
};
const PROPOSAL_STAGE = "task_approval";

// huai_approvals.stage 는 ('task_approval','midpoint_approval','commander_completion',
// 'final_approval','cancellation') 만 허용하지만, 이 Mini App 이 실제로 쓰는 건 그 중
// ('task_approval','final_approval','cancellation') 세 개뿐이다. Alpha 폴러가 재생하는
// (stage, decision) 조합도 정확히 이 세 개다 — 아래 매핑은 팀장님이 FSM/키보드 코드를
// 직접 대조해 확정한 것을 그대로 반영한다:
//
//   commander_completion_pending → final_approval (변경, 원래 'commander_completion'이었음)
//     packages/workflow/src/index.ts:284 가 이 상태에서 owner_final_approved 를 허용한다 —
//     completion_approval_pending 과 "같은 결정"이다(방장 입장에서 둘 다 "완료 승인").
//     같은 결정에 다른 stage 이름을 붙이면 (entity_ref, stage) 판정이 갈라지므로 통합했다.
//
//   mid_approval_pending → 의도적으로 없음 (매핑 삭제)
//     이 상태는 owner_mid_approved/owner_mid_rejected 로만 벗어나는데, Telegram 쪽에도 이걸
//     누를 버튼이 없다(packages/telegram-ui/src/index.ts:38-48 buildTaskDecisionKeyboard 는
//     approve/reject/cancel 뿐이고 그건 owner_task_* 이벤트를 만든다 — mid 게이트가 아니다).
//     FSM 은 이 상태에 도달하는데 어떤 UI 도 못 벗어나는 기존 공백이다. Mini App 이 Telegram
//     에 없는 결정 창구를 새로 발명하면 두 채널이 다른 정책을 갖게 되므로, 여기서도 만들지
//     않는다 — 목록에는 보이되 결정 버튼은 없다(_shared/task-status.ts 의 decidable=false).
const STAGE_BY_STATUS: Record<string, string> = {
  commander_completion_pending: "final_approval",
  completion_approval_pending: "final_approval"
};

// final_approval 단계에서 허용하는 액션 — Telegram 의 완료 게이트(buildCompletionKeyboard,
// rv/rr/fa)와 정확히 맞춘다. 반려(reject)는 그 키보드에 없어서 여기도 안 둔다 — approve 도
// final_approve 로만 받는다(같은 이유로 "approve"는 이 stage 에서 무효).
const FINAL_APPROVAL_ALLOWED_ACTIONS = new Set<ActionName>(["final_approve", "request_revision"]);

// request_revision 만 huai_can_act_in_room() 위에 추가로 owner 를 강제한다(task 경로).
// 근거: schema.sql:106-112 의 'task:create' 관대함 vs orchestrator requiresOwner() 불일치,
// scripts/dry-run-spec.mjs NFR-01/AC-02.
export function requiresOwnerRoleOverride(action: ActionName): boolean {
  return action === "request_revision";
}

// entity_ref → huai_tasks.task_id FK 를 채울지 판정. recordApprovals:211 과 동일 정규식.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isProposalAction(action: ActionName): action is ProposalActionName {
  return action === "approve" || action === "reject" || action === "request_revision";
}

export type TaskRow = { task_id: string; room_id: string; status: string; updated_at: string };
export type MembershipRow = { role: string };
export type ApprovalInsertRow = {
  task_id: string | null;
  room_id: string;
  stage: string;
  decider_telegram_user_id: string;
  decision: string;
  reason: string | null;
  idempotency_key: string;
  entity_ref: string;
};
export type EventInsertRow = {
  room_id: string;
  task_id: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
};

export type ApproveHandlerDeps = {
  authenticate(req: Request): Promise<MiniAppAuthResult>;
  fetchTask(taskId: string): Promise<{ error?: string; data?: TaskRow | null }>;
  checkPermission(roomId: string, telegramUserId: string, permission: string): Promise<{ error?: string; data?: boolean }>;
  fetchMembershipRole(roomId: string, telegramUserId: string): Promise<{ error?: string; data?: MembershipRow | null }>;
  // 제안은 huai_tasks 행이 없어 room_id 를 알 방법이 huai_events(proposal_created) 조회뿐이다.
  // 클라이언트가 주장하는 roomId 는 신뢰하지 않는다 — 여기서 서버가 되짚어 확인한다.
  fetchProposalRoomId(proposalId: string): Promise<{ error?: string; data?: { room_id: string } | null }>;
  // 이미 결정된 제안에 또 결정이 쌓이는 것을 막는다(원장에 서로 모순되는 행이 쌓이는 걸 방지).
  // miniapp-proposals 의 "미결" anti-join 과 정확히 같은 조건이다.
  checkProposalAlreadyDecided(roomId: string, proposalId: string): Promise<{ error?: string; data?: boolean }>;
  insertApproval(row: ApprovalInsertRow): Promise<{ error?: { code: string; message: string }; data?: { approval_id: string } | null }>;
  insertEvent(row: EventInsertRow): Promise<{ error?: { code: string; message: string } }>;
  // 인지부채 방지 퀴즈(huai_task_quizzes) 게이트. 파일을 안 바꾼 작업은 애초에 행이
  // 없다(hasQuiz=false) — 그런 작업은 이 게이트가 아무 영향을 주지 않는다.
  fetchTaskQuizStatus(taskId: string): Promise<{ error?: string; data?: { hasQuiz: boolean; passed: boolean } | null }>;
};

export async function handleMiniappApproveRequest(req: Request, deps: ApproveHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse(405, { error: "method-not-allowed" });

  const auth = await deps.authenticate(req);
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.message });

  let body: { taskId?: unknown; proposalId?: unknown; action?: unknown; reason?: unknown; idempotencyKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "invalid-json" });
  }

  const taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : undefined;
  const proposalId = typeof body.proposalId === "string" && body.proposalId ? body.proposalId : undefined;
  const action = typeof body.action === "string" ? (body.action as ActionName) : undefined;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 2000) : undefined;
  const clientIdempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 200) : undefined;

  if (!action || !(action in ACTION_META) || (!taskId && !proposalId) || (taskId && proposalId)) {
    return jsonResponse(400, { error: "invalid-request" });
  }

  if (proposalId) {
    if (!isProposalAction(action)) return jsonResponse(400, { error: "invalid-request" });
    return handleProposalDecision(deps, auth.telegramUserId, proposalId, action, reason, clientIdempotencyKey);
  }

  return handleTaskDecision(deps, auth.telegramUserId, taskId!, action, reason, clientIdempotencyKey);
}

async function handleProposalDecision(
  deps: ApproveHandlerDeps,
  telegramUserId: string,
  proposalId: string,
  action: ProposalActionName,
  reason: string | undefined,
  clientIdempotencyKey: string | undefined
): Promise<Response> {
  const roomResult = await deps.fetchProposalRoomId(proposalId);
  if (roomResult.error) {
    console.error(`miniapp-approve: proposal room lookup failed: ${roomResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  if (!roomResult.data) return jsonResponse(404, { error: "not-found" });
  const roomId = roomResult.data.room_id;

  // 제안 승인은 owner 전용이다(huai_can_act_in_room 을 안 타고 바로 role 을 본다 — 파일 상단 주석 참고).
  const membershipResult = await deps.fetchMembershipRole(roomId, telegramUserId);
  if (membershipResult.error) {
    console.error(`miniapp-approve: membership lookup failed: ${membershipResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  if (!membershipResult.data || membershipResult.data.role !== "owner") {
    return jsonResponse(403, { error: "forbidden" });
  }

  const decidedResult = await deps.checkProposalAlreadyDecided(roomId, proposalId);
  if (decidedResult.error) {
    console.error(`miniapp-approve: proposal decision check failed: ${decidedResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  if (decidedResult.data) return jsonResponse(409, { error: "already-decided" });

  // Alpha 폴러가 이 값을 재사용해 재생 승인을 원본과 같은 idempotency_key 로 만든다 — 그래야
  // 재생분이 23505 로 흡수되어 원장에 한 행만 남는다(팀장님 확정 사항). 그러려면 이 키가
  // "같은 결정"에 대해 항상 같은 값이어야 한다. 이전엔 5초 시간 버킷을 썼는데, 6초 뒤
  // 재시도가 오면 다른 값이 나와 흡수가 안 됐다(팀장님 지적, 정확함) — 제거했다.
  // 제안은 한 번 결정되면 checkProposalAlreadyDecided 가 재결정 자체를 막으므로(위 참고),
  // entity+action 만으로도 시간 요소 없이 안전하게 고유·안정적이다.
  const idempotencyKey =
    clientIdempotencyKey && clientIdempotencyKey.length > 0
      ? `miniapp:${action}:${proposalId}:${clientIdempotencyKey}`
      : `miniapp:${action}:${proposalId}`;

  return finalizeDecision(deps, {
    taskId: isUuid(proposalId) ? proposalId : null,
    roomId,
    entityRef: proposalId,
    stage: PROPOSAL_STAGE,
    decision: PROPOSAL_ACTION_META[action].decision,
    telegramUserId,
    reason,
    idempotencyKey,
    eventPayloadExtra: { proposalId },
    responseAction: action
  });
}

async function handleTaskDecision(
  deps: ApproveHandlerDeps,
  telegramUserId: string,
  taskId: string,
  action: ActionName,
  reason: string | undefined,
  clientIdempotencyKey: string | undefined
): Promise<Response> {
  const taskResult = await deps.fetchTask(taskId);
  if (taskResult.error) {
    console.error(`miniapp-approve: task lookup failed: ${taskResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  const task = taskResult.data;
  if (!task) return jsonResponse(404, { error: "not-found" });

  const stage = action === "cancel" ? "cancellation" : STAGE_BY_STATUS[task.status];
  if (!stage) return jsonResponse(409, { error: "not-awaiting-decision" });
  if (stage === "final_approval" && !FINAL_APPROVAL_ALLOWED_ACTIONS.has(action)) {
    // final_approval 단계에서 approve/reject 를 받으면 안 된다(위 FINAL_APPROVAL_ALLOWED_ACTIONS
    // 주석 참고) — Telegram 완료 게이트에 없는 결정을 Mini App 이 만들지 않는다.
    return jsonResponse(409, { error: "action-not-allowed-for-stage" });
  }

  const permission = ACTION_META[action].permission;
  const permResult = await deps.checkPermission(task.room_id, telegramUserId, permission);
  if (permResult.error) {
    console.error(`miniapp-approve: permission check failed: ${permResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  if (!permResult.data) return jsonResponse(403, { error: "forbidden" });

  // 인지부채 방지 퀴즈(Orca/Buzz 벤치마킹) — 파일을 실제로 바꾼 작업은, 방장이 완료
  // 승인을 누르기 전에 무엇이 바뀌었는지 이해했는지 객관식 3문항으로 먼저 확인한다.
  // Grok Bot 의 "행동 카테고리별 승인" 과는 다른 축이지만 같은 목적(승인이 형식적
  // 클릭으로 끝나지 않게)이라 같은 게이트 지점에 건다. 클라이언트가 이 검사를
  // 우회할 방법이 없다 — 퀴즈 정답은 miniapp-quiz 함수 밖으로 절대 안 나간다.
  if (action === "final_approve") {
    const quizStatusResult = await deps.fetchTaskQuizStatus(taskId);
    if (quizStatusResult.error) {
      console.error(`miniapp-approve: quiz status lookup failed: ${quizStatusResult.error}`);
      return jsonResponse(500, { error: "lookup-failed" });
    }
    if (quizStatusResult.data?.hasQuiz && !quizStatusResult.data.passed) {
      return jsonResponse(409, { error: "quiz-not-passed" });
    }
  }

  if (requiresOwnerRoleOverride(action)) {
    const membershipResult = await deps.fetchMembershipRole(task.room_id, telegramUserId);
    if (membershipResult.error) {
      console.error(`miniapp-approve: membership lookup failed: ${membershipResult.error}`);
      return jsonResponse(500, { error: "lookup-failed" });
    }
    if (!membershipResult.data || membershipResult.data.role !== "owner") {
      return jsonResponse(403, { error: "forbidden" });
    }
  }

  // 제안과 달리 task 는 생애주기 동안 같은 (action, taskId) 조합으로 여러 번 정당하게
  // 재결정될 수 있다(예: 보완요청 → 재작업 → 다시 completion_approval_pending 도달 →
  // 또 request_revision). entity+action 만 쓰면 이전 결정과 잘못 뭉쳐진다.
  //
  // task.status 만으로는 부족하다 — 실측으로 확인된 버그: 같은 상태(completion_approval_pending)
  // 로 두 번째 라운드에 다시 도달하면 status 문자열이 첫 라운드와 완전히 같아서 키가 겹치고,
  // 두 번째 결정의 huai_approvals INSERT 가 unique 제약에 막혀 원장에 남지도 않고 사라진다
  // (huai_approvals 행 수가 1로 고정, Telegram 쪽은 이벤트 idempotency_key 에 매번 다른
  // update_id 가 들어가 이 문제가 없다 — 두 창구가 갈렸던 실제 사례).
  //
  // 해법: task.updated_at 을 같이 넣는다. apps/bot-service/src/supabase-store.ts:273-283
  // patchTaskStatus 가 상태 전이마다 매번 updated_at 을 새로 찍으므로, status 는 라운드를
  // 못 갈라도 updated_at 은 가른다 — 같은 라운드 안의 진짜 중복 클릭(그 사이 updated_at
  // 불변)은 여전히 걸러지고, 라운드가 넘어간 재요청(그 사이 updated_at 이 바뀜)은 새 키로
  // 정상 통과한다.
  //
  // 잔여 위험(수용, 다음 사람을 위해 남김): 클릭과 그 재시도 사이에 이 결정과 무관한 이유로
  // task.updated_at 이 바뀌면(다른 필드 업데이트로 인한 것이라도) 재시도가 새 결정으로
  // 취급되어 중복 행이 생길 수 있다. patchTaskStatus 는 상태 전이 시에만 도는 데다 재시도는
  // 보통 수 초 안에 일어나므로 그 사이 진짜 상태 전이가 끼어들 확률은 낮다고 보고 수용한다.
  const idempotencyKey =
    clientIdempotencyKey && clientIdempotencyKey.length > 0
      ? `miniapp:${action}:${taskId}:${clientIdempotencyKey}`
      : `miniapp:${action}:${taskId}:${task.status}:${task.updated_at}`;

  return finalizeDecision(deps, {
    taskId,
    roomId: task.room_id,
    entityRef: taskId,
    stage,
    decision: ACTION_META[action].decision,
    telegramUserId,
    reason,
    idempotencyKey,
    eventPayloadExtra: {},
    responseAction: action
  });
}

// 두 경로가 공유하는 마지막 단계 — huai_approvals + huai_events 기록, 응답 조립.
// apps/bot-service/src/supabase-store.ts:201-231 recordApprovals 와 같은 컬럼 구성을 쓴다.
async function finalizeDecision(
  deps: ApproveHandlerDeps,
  input: {
    taskId: string | null;
    roomId: string;
    entityRef: string;
    stage: string;
    decision: "approved" | "rejected" | "revision_requested" | "cancelled";
    telegramUserId: string;
    reason: string | undefined;
    idempotencyKey: string;
    eventPayloadExtra: Record<string, unknown>;
    responseAction: ActionName;
  }
): Promise<Response> {
  // reason: task 경로(taskId, stage='final_approval', action='request_revision')는 이제
  // 이 값을 실제로 소비한다 — Mini App 이 사유 입력란을 받고(supabase/miniapp-web/index.html),
  // Mini App 결정 폴러(apps/bot-service/src/miniapp-decision-poller.ts)가 이 컬럼을 읽어
  // 합성 콜백의 callback.reason 에 싣고, orchestrator 의 buildOwnerActionOutbox 가
  // owner_supplement_requested 알림 본문에 그대로 포함시켜 방과 담당자에게 전달한다
  // (packages/orchestrator/src/index.ts 의 buildSupplementRequestedText 참고).
  // 제안 경로(proposalId, task_approval 단계의 "수정")는 여전히 이 값을 아무도 읽지 않는다
  // — 이번 작업 범위 밖(팀장님 지시로 보류)이라 Mini App 쪽에도 그 버튼엔 입력란이 없다.
  // 두 경로 모두 컬럼에는 그대로 저장한다 — insert 자체는 경로를 가리지 않는다.
  const insertResult = await deps.insertApproval({
    task_id: input.taskId,
    room_id: input.roomId,
    stage: input.stage,
    decider_telegram_user_id: input.telegramUserId,
    decision: input.decision,
    reason: input.reason ?? null,
    idempotency_key: input.idempotencyKey,
    entity_ref: input.entityRef
  });
  // unique violation(23505) = 이미 같은 idempotency_key 로 기록됨 → 멱등하게 성공 처리.
  if (insertResult.error && insertResult.error.code !== "23505") {
    console.error(`miniapp-approve: approval insert failed: ${insertResult.error.message}`);
    return jsonResponse(500, { error: "write-failed" });
  }

  const eventResult = await deps.insertEvent({
    room_id: input.roomId,
    task_id: input.taskId,
    event_type: "miniapp_decision_recorded",
    idempotency_key: `event:${input.idempotencyKey}`,
    payload: {
      action: input.responseAction,
      decision: input.decision,
      stage: input.stage,
      telegramUserId: input.telegramUserId,
      reason: input.reason ?? null,
      ...input.eventPayloadExtra
    }
  });
  if (eventResult.error && eventResult.error.code !== "23505") {
    // 원장 기록은 이미 성공했다. 감사 이벤트 실패는 치명적이지 않으니 로그만 남기고 200을 유지한다.
    console.error(`miniapp-approve: event insert failed: ${eventResult.error.message}`);
  }

  return jsonResponse(200, {
    ok: true,
    approvalId: insertResult.data?.approval_id ?? null,
    decision: input.decision,
    note: "결정이 기록되었습니다. 실제 작업 진행 반영에는 별도 처리가 필요할 수 있습니다."
  });
}
