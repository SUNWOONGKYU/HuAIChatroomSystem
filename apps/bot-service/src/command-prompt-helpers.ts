// supabase-store.ts 에서 뽑아낸 텔레그램 명령/제안 payload 파싱 + 프롬프트/메시지 빌더 + 작업 상태 포맷팅. 순수 함수(I/O 없음).
import { maskTelegramSensitiveText as maskSensitiveText, safeTelegramTraceUri } from "../../../packages/telegram-ui/src/sanitize.js";
import { classifyTaskRisk, type OutboxTarget } from "../../../packages/contracts/src/index.js";
import { type TaskStatus } from "../../../packages/workflow/src/index.js";
import { type PersistedOutboxItem, type OrchestratorPersistencePort } from "./persistence.js";
import { type RoomTurn } from "../../../packages/orchestrator/src/leader-planning.js";
import { isUuid } from "./event-row-mapping.js";

export type OrchestratorPersistencePortEvent = Parameters<OrchestratorPersistencePort["commitTelegramInputResult"]>[0]["result"]["events"][number];

export type EventRow = {
  event_id: string;
  room_id: string;
  task_id?: string | null;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type OutboxRow = {
  huai_outbox_id: string;
  room_id?: string | null;
  event_id?: string | null;
  idempotency_key: string;
  target_kind: "telegram_bot" | "local_gateway";
  target: string | OutboxTarget;
  payload: Record<string, unknown>;
  status: PersistedOutboxItem["status"];
  attempts: number;
  created_at: string;
  sent_at?: string | null;
  last_error?: string | null;
};

export type TelegramUpdateRow = {
  status?: string;
};

export type ExecutionActorRole = "claude_leader" | "codex_leader";

export type ProposalExecutionHint = {
  prompt: string;
  title: string;
  // 이 제안이 시작된 포럼 주제. 승인되면 작업 행에 그대로 옮겨 적는다.
  messageThreadId?: string;
  requestedActorRole?: ExecutionActorRole;
  executionMode?: "multi_ai_review";
  rawText?: string;
  // FR-007: 제안 단계에서 구조화된 목적·범위·완료조건. 완료조건은 검증 판정 기준이 된다.
  purpose?: string;
  scope?: string;
  completionCriteria?: string;
  // "버전 N개 만들어줘" 변형이면 true — 공유 프로젝트 폴더가 아니라 자기만의 격리된
  // git worktree 에서 실행돼야 한다(huai_tasks.use_isolated_worktree).
  useIsolatedWorktree?: boolean;
};

export type OutboxInsertRow = {
  // 방 단위 공평 리스(lease_huai_outbox, migration 20260815140000)의 파티션 키.
  // 여기서 안 채우면 새로 들어가는 행은 전부 room_id=null 로 한 버킷에 묶여 공평 리스가 무력화된다.
  room_id: string;
  event_id: string | undefined;
  idempotency_key: string;
  target_kind: OutboxRow["target_kind"];
  target: string;
  payload: Record<string, unknown>;
};

export function taskIdFromBinding(binding: unknown): string | undefined {
  if (!binding || typeof binding !== "object") return undefined;
  const value = binding as Record<string, unknown>;
  return value.kind === "task" && typeof value.taskId === "string" && isUuid(value.taskId) ? value.taskId : undefined;
}

export function buildFinalApprovalResultText(
  taskId: string,
  reportBody: string | undefined,
  artifacts: ReadonlyArray<{ uri: string; public_url?: string | null }>
): string {
  const summary = String(reportBody ?? "").trim();
  const artifactLines = artifacts.map((artifact) => {
    const uri = artifact.public_url && /^https?:\/\//i.test(artifact.public_url) ? artifact.public_url : artifact.uri;
    return "- " + safeTelegramTraceUri(uri);
  });
  return [
    `승인 완료: ${taskId}`,
    summary ? "결과 보고:\n" + summary : "결과 보고: 저장된 실행 보고가 없습니다.",
    artifactLines.length > 0 ? "산출물:\n" + artifactLines.join("\n") : "산출물: 없음"
  ].join("\n\n");
}

export type ExecutionActorRow = {
  actor_id: string;
  role: ExecutionActorRole;
  adapter_type: "claude_code" | "codex";
};


export type TaskSummaryRow = {
  task_id: string;
  title?: string | null;
  status: TaskStatus;
  priority?: string | null;
  assignee_actor_id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type TaskDetailRow = TaskSummaryRow & {
  purpose?: string | null;
  scope?: string | null;
  completion_criteria?: string | null;
};

export type TaskTraceEventRow = {
  event_type: string;
  created_at?: string | null;
};

export type TaskTraceArtifactRow = {
  uri: string;
  version: string;
  is_final?: boolean | null;
  created_at?: string | null;
};

export type TaskTraceVerificationRow = {
  verdict: string;
  target_version: string;
  created_at?: string | null;
};

export type TaskQueryPayload =
  | { kind: "center" }
  | { kind: "tasks"; limit: number }
  | { kind: "task"; taskId: string }
  | { kind: "search"; term: string }
  | { kind: "trace"; taskId: string };
export function taskQueryPayload(payload: Record<string, unknown>): TaskQueryPayload | undefined {
  const value = payload.query;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  if (query.kind === "center") return { kind: "center" };
  if (query.kind === "tasks") {
    const limit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.trunc(query.limit) : 10;
    return { kind: "tasks", limit };
  }
  if (query.kind === "task") {
    return { kind: "task", taskId: typeof query.taskId === "string" ? query.taskId : "" };
  }
  if (query.kind === "search") {
    return { kind: "search", term: typeof query.term === "string" ? query.term : "" };
  }
  if (query.kind === "trace") {
    return { kind: "trace", taskId: typeof query.taskId === "string" ? query.taskId : "" };
  }
  return undefined;
}

export type AgentPersonaCommandPayload =
  | { action: "create"; personaName: string; baseRole: string; instructions: string; createdByTelegramUserId?: string }
  | { action: "list" };
export function agentPersonaCommandPayload(payload: Record<string, unknown>): AgentPersonaCommandPayload | undefined {
  const value = payload.agentPersonaCommand;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  if (command.action === "list") return { action: "list" };
  if (command.action === "create") {
    return {
      action: "create",
      personaName: typeof command.personaName === "string" ? command.personaName : "",
      baseRole: typeof command.baseRole === "string" ? command.baseRole : "",
      instructions: typeof command.instructions === "string" ? command.instructions : "",
      createdByTelegramUserId: typeof command.createdByTelegramUserId === "string" ? command.createdByTelegramUserId : undefined
    };
  }
  return undefined;
}

export type AiActorCommandPayload = { action: "invite"; role: string; adapterType: string } | { action: "check" };
export function aiActorCommandPayload(payload: Record<string, unknown>): AiActorCommandPayload | undefined {
  const value = payload.aiActorCommand;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  if (command.action === "check") return { action: "check" };
  if (command.action !== "invite" || typeof command.role !== "string" || typeof command.adapterType !== "string") return undefined;
  const roles = ["leader", "claude_leader", "codex_leader", "auditor"];
  const adapters = ["orchestrator", "claude_code", "codex", "auditor"];
  if (!roles.includes(command.role) || !adapters.includes(command.adapterType)) return undefined;
  return { action: "invite", role: command.role, adapterType: command.adapterType };
}

export type RoomCommandPayload = { action: "register"; telegramChatId: string; ownerTelegramUserId: string };
export function roomCommandPayload(payload: Record<string, unknown>): RoomCommandPayload | undefined {
  const value = payload.roomCommand;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  if (command.action !== "register" || typeof command.telegramChatId !== "string" || typeof command.ownerTelegramUserId !== "string") return undefined;
  return { action: "register", telegramChatId: command.telegramChatId, ownerTelegramUserId: command.ownerTelegramUserId };
}

export type RoomMemberCommandPayload = { action: "add" | "leave"; telegramUserId: string };
export function roomMemberCommandPayload(payload: Record<string, unknown>): RoomMemberCommandPayload | undefined {
  const value = payload.roomMemberCommand;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  if ((command.action !== "add" && command.action !== "leave") || typeof command.telegramUserId !== "string" || !/^-?\d+$/.test(command.telegramUserId)) return undefined;
  return { action: command.action, telegramUserId: command.telegramUserId };
}

export function formatTraceTime(value?: string | null): string {
  return value ? " · " + value : "";
}

export function shortTaskId(taskId: string): string {
  return taskId.length <= 12 ? taskId : taskId.slice(0, 8);
}

// PostgREST 의 `Prefer: count=exact` 응답 헤더 형식: "0-9/25"(부분) 또는 "*/0"(빈 결과).
// 슬래시 뒤의 총 건수만 뽑는다. 헤더가 없거나 형식이 다르면 undefined — 호출부가
// "실제보다 많다고 거짓 안내"하지 않도록 rows.length 로 안전하게 폴백한다.
export function parseContentRangeTotal(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\/(\d+)$/);
  if (!match) return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : undefined;
}

// ---------- 작업 상태 라벨: 단일 출처 ----------
// 예전엔 humanTaskStatus(status: string) 가 따로 있었다. 실제 huai_tasks_status_check(schema.sql)
// 값과 어긋나는 case 가 섞여 있었고("proposed"/"running"/"verified" 는 실제 TaskStatus 에 존재하지
// 않는 값), 다수의 실제 상태값(proposal_pending/in_progress/mid_approval_pending 등)은 default 로
// 원문 snake_case 그대로 노출됐다. /search·/task·room facts(리더 판단 프롬프트) 세 경로가 전부
// 이 결함을 물려받고 있었다 — room facts 쪽이 특히 나빴다: 리더가 방 상태를 판단할 때 원문
// 값을 그대로 읽고 있었다는 뜻이다. TASK_STATUS_META(Record<TaskStatus, ...>, 23개 전수 컴파일
// 타임 강제)가 이미 있었으므로 두 표를 남기지 않고 이걸 유일한 출처로 통일했다.
// Record<TaskStatus, ...> 로 선언해 huai_tasks_status_check 의 23개 값 전수를 컴파일 타임에 강제한다.
export type TaskStatusGroupKey = "approval_pending" | "action_needed" | "in_progress" | "waiting" | "paused" | "completed" | "closed";

// 출력 순서: 방장이 지금 결정해야 하는 것(승인 대기) -> 막힌 것(조치 필요) -> 돌고 있는 것(진행 중)
// -> 대기 -> 일시정지 -> 끝난 것(완료/종료됨) 순. 방장이 가장 궁금해할 것을 위로 올린다.
export const TASK_STATUS_GROUP_ORDER: readonly TaskStatusGroupKey[] = [
  "approval_pending", "action_needed", "in_progress", "waiting", "paused", "completed", "closed"
];

export const TASK_STATUS_GROUPS: Readonly<Record<TaskStatusGroupKey, { icon: string; label: string }>> = {
  approval_pending: { icon: "🗳️", label: "승인 대기" },
  action_needed: { icon: "⚠️", label: "조치 필요" },
  in_progress: { icon: "▶️", label: "진행 중" },
  waiting: { icon: "⏳", label: "대기 중" },
  paused: { icon: "⏸️", label: "일시정지" },
  completed: { icon: "✅", label: "완료" },
  closed: { icon: "🚫", label: "종료됨" }
};

const TASK_STATUS_META: Readonly<Record<TaskStatus, { group: TaskStatusGroupKey; label: string }>> = {
  proposal_pending: { group: "waiting", label: "제안 검토 대기" },
  proposal_revision_requested: { group: "action_needed", label: "제안 보완 필요" },
  proposal_rejected: { group: "closed", label: "제안 반려됨" },
  scheduled: { group: "waiting", label: "실행 대기" },
  waiting_dependencies: { group: "waiting", label: "선행 작업 대기" },
  queued_for_gateway: { group: "waiting", label: "실행 준비 중" },
  in_progress: { group: "in_progress", label: "실행 중" },
  mid_approval_pending: { group: "approval_pending", label: "중간 승인 대기" },
  paused_by_owner: { group: "paused", label: "방장이 일시정지" },
  verification_pending: { group: "waiting", label: "검증 대기" },
  verification_in_progress: { group: "in_progress", label: "검증 중" },
  revision_requested: { group: "action_needed", label: "보완 필요" },
  revision_in_progress: { group: "in_progress", label: "보완 작업 중" },
  reverification_pending: { group: "waiting", label: "재검증 대기" },
  commander_completion_pending: { group: "approval_pending", label: "리더 완료 확인 대기" },
  completion_approval_pending: { group: "approval_pending", label: "승인 대기" },
  owner_supplement_requested: { group: "action_needed", label: "보완 요청함" },
  completed: { group: "completed", label: "완료" },
  cancel_requested: { group: "action_needed", label: "취소 처리 중" },
  cancelled: { group: "closed", label: "취소됨" },
  failed_retryable: { group: "action_needed", label: "실패(재시도 예정)" },
  blocked: { group: "action_needed", label: "조치 필요" },
  rejected_or_cancelled: { group: "closed", label: "반려/취소됨" }
};

// DB 제약이 지켜지는 한 항상 히트하지만, 방어적으로 미지의 값은 "조치 필요"로 눈에 띄게 분류한다
// (조용히 숨기지 않는다 — 방장이 모르는 상태값이면 그게 더 위험하다).
export function taskStatusMeta(status: TaskStatus): { group: TaskStatusGroupKey; label: string } {
  return TASK_STATUS_META[status] ?? { group: "action_needed", label: String(status) };
}

// 우리 방 봇 4개(leader/claude_leader/codex_leader/auditor)의 사람이 읽는 담당자 이름.
// botLabelForRole() 은 리더 판단 프롬프트용 긴 표기("LeaderBot(리더)")라 목적이 다르다 —
// /tasks 는 여러 건을 한 화면에 보여줘야 해서 짧은 표기를 따로 둔다.
const TASK_ASSIGNEE_DISPLAY_BY_ROLE: Readonly<Record<string, string>> = {
  leader: "리더",
  claude_leader: "ClaudeBot",
  codex_leader: "CodexBot",
  auditor: "AuditBot"
};

export function taskAssigneeLabel(role: string | undefined): string {
  if (!role) return "미배정";
  return TASK_ASSIGNEE_DISPLAY_BY_ROLE[role] ?? role;
}

// 절대 시각은 방장이 직접 계산해야 해서 안 읽힌다 — 상대 표현으로만 보여준다.
export function formatElapsedSince(iso: string | null | undefined, now: Date): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Math.max(0, now.getTime() - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  return `${months}개월 전`;
}
// ---------- /Phase 3 ----------

export function requestedExecutionRolesForHint(hint: ProposalExecutionHint): ExecutionActorRole[] {
  if (hint.executionMode === "multi_ai_review") return ["claude_leader", "codex_leader"];
  return hint.requestedActorRole ? [hint.requestedActorRole] : [];
}

export function buildMultiAiExecutionRows(row: OutboxInsertRow, executionRequest: Record<string, unknown>, hint: ProposalExecutionHint, actorsByRole: Map<ExecutionActorRole, ExecutionActorRow>): OutboxInsertRow[] {
  const baseAttemptId = typeof executionRequest.attemptId === "string" ? executionRequest.attemptId : "attempt";
  const rows: OutboxInsertRow[] = [];
  const claude = actorsByRole.get("claude_leader");
  const codex = actorsByRole.get("codex_leader");
  const requestText = hint.rawText ?? hint.prompt;
  if (claude) rows.push(buildRoleExecutionRow(row, executionRequest, "claude", claude, promptWithRiskQuiz(buildRoleSpecificPrompt("claude_leader", requestText), requestText), `${baseAttemptId}-claude`));
  if (codex) rows.push(buildRoleExecutionRow(row, executionRequest, "codex", codex, promptWithRiskQuiz(buildRoleSpecificPrompt("codex_leader", requestText), requestText), `${baseAttemptId}-codex`));
  return rows.length > 0 ? rows : [{ ...row, payload: { ...row.payload, executionRequest: { ...executionRequest, prompt: promptWithRiskQuiz(hint.prompt, requestText) } } }];
}

export function buildRoleExecutionRow(row: OutboxInsertRow, executionRequest: Record<string, unknown>, suffix: string, actor: ExecutionActorRow, prompt: string, attemptId: string): OutboxInsertRow {
  return { ...row, idempotency_key: row.idempotency_key + ":" + suffix, payload: { ...row.payload, executionRequest: { ...executionRequest, attemptId, actorId: actor.actor_id, adapterType: actor.adapter_type, prompt, reportBotRole: actor.role } } };
}

// 파일을 실제로 바꾼 작업만, 완료 보고 끝에 이해도 확인용 객관식 3문항을 실어 달라고
// 고위험 작업에만 요청한다 — 방장이 "완료" 버튼을 누르기 전에 무엇이 바뀌었는지 실제로
// 이해했는지 확인하기 위함(인지부채 방지, Orca/Buzz 벤치마킹). packages/supabase-runtime 의
// extractTaskQuizFromEvents 가 이 블록을 파싱하고, huai_task_quizzes 로 저장돼
// miniapp-approve 가 통과 여부를 강제한다. 조회성 작업(파일 변경 없음)에는 의미가
// 없어 생략한다 — 저장 쪽도 같은 위험도 함수를 한 번 더 적용한다.
export function appendQuizInstruction(prompt: string): string {
  return [
    prompt,
    "",
    "---",
    "고위험 작업에서 파일을 실제로 만들거나 바꿨다면(조회·설명 또는 단순 저위험 변경이면 이 블록은 생략하세요), 보고의",
    "맨 끝에 아래 형식 그대로 한 블록을 추가하세요. 방장이 변경 내용을 이해했는지",
    "확인하는 객관식 3문항입니다 — 방장에게 그대로 보이는 문장이니 자연스러운 한국어로",
    "쓰세요.",
    "QUIZ_START",
    '{"summary":"무엇을 왜 바꿨는지 3~5문장 요약","questions":[',
    '{"q":"질문1","choices":["보기1","보기2","보기3","보기4"],"correct":0},',
    '{"q":"질문2","choices":["보기1","보기2","보기3","보기4"],"correct":0},',
    '{"q":"질문3","choices":["보기1","보기2","보기3","보기4"],"correct":0}',
    "]}",
    "QUIZ_END",
    "correct 는 0부터 시작하는 정답 인덱스입니다. QUIZ_START 와 QUIZ_END 사이에는",
    "유효한 JSON 외에 다른 말을 넣지 마세요."
  ].join("\n");
}

export function promptWithRiskQuiz(prompt: string, taskText: string): string {
  return classifyTaskRisk(taskText) === "high" ? appendQuizInstruction(prompt) : prompt;
}

export function buildRoleSpecificPrompt(role: "claude_leader" | "codex_leader" | "auditor", requestText: string): string {
  const roleLine = role === "claude_leader"
    ? "역할: ClaudeBot. 설계 관점, 누락 위험, 보완 의견을 제시하세요."
    : role === "codex_leader"
      ? "역할: CodexBot. 구현 관점, 실행 가능성, 필요한 코드 조치를 제시하세요."
      : "역할: AuditBot. ClaudeBot과 CodexBot 결과를 독립 검증할 기준과 최종 판정을 제시하세요.";
  return [
    "HuAI Collab Chatroom System의 승인된 다중 AI 협의 작업입니다.",
    roleLine,
    "사람이 알아야 할 결론과 필요한 조치만 간결하게 보고하세요.",
    "내부 JSON, hook log, stack trace, token, API key, 원문 시크릿은 출력하지 마세요.",
    "",
    "USER_REQUEST:",
    requestText
  ].join("\n");
}

export function proposalExecutionModeFromPayload(payload: Record<string, unknown>): "multi_ai_review" | undefined {
  return payload.intent === "multi_ai_review" ? "multi_ai_review" : undefined;
}

// Telegram raw update 에서 사람 발화만 뽑는다. 봇 메시지와 콜백은 대화가 아니다.
export function roomTurnFromRawUpdate(rawUpdate: Record<string, unknown>, ownerTelegramUserId: string | undefined): RoomTurn | undefined {
  const message = (rawUpdate?.message ?? undefined) as Record<string, unknown> | undefined;
  if (!message) return undefined;
  const from = message.from as Record<string, unknown> | undefined;
  if (from?.is_bot === true) return undefined;
  const text = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
  const attachmentNote = attachmentNoteFromMessage(message);
  const combined = [text.trim(), attachmentNote].filter(Boolean).join("\n");
  if (!combined) return undefined;
  const userId = from?.id === undefined ? undefined : String(from.id);
  const isOwner = Boolean(userId && ownerTelegramUserId && userId === ownerTelegramUserId);
  const speaker = isOwner ? "방장" : nameFromTelegramUser(from, userId);
  return { speaker, text: maskSensitiveText(combined).slice(0, 500), isOwner };
}

// 다운로드에 성공한 첨부는 polling.ts 가 message._huaiLocalAttachments 에 로컬 경로를
// 실어 저장해 둔다. 여기서 그 경로를 프롬프트에 노출해야 AI 실행기가 Read 로 열어 본다.
export function attachmentNoteFromMessage(message: Record<string, unknown>): string {
  const attachments = message._huaiLocalAttachments as Array<{ path?: unknown; kind?: unknown }> | undefined;
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  return attachments
    .filter((item) => typeof item.path === "string")
    .map((item) => `[첨부 ${item.kind === "document" ? "파일" : "이미지"}: ${item.path}]`)
    .join("\n");
}

export function nameFromTelegramUser(from: Record<string, unknown> | undefined, userId: string | undefined): string {
  const first = typeof from?.first_name === "string" ? from.first_name.trim() : "";
  const username = typeof from?.username === "string" ? from.username.trim() : "";
  return first || username || (userId ? "참여자" + userId.slice(-4) : "참여자");
}

export function botLabelForRole(role: string): string {
  if (role === "leader") return "LeaderBot(리더)";
  if (role === "claude_leader") return "ClaudeBot(Claude Code 실행)";
  if (role === "codex_leader") return "CodexBot(Codex 실행)";
  if (role === "auditor") return "AuditBot(독립 검증)";
  return role;
}

export function executionWorkerLabel(
  role: ExecutionActorRole | undefined,
  mode: "multi_ai_review" | undefined
): string | undefined {
  if (mode === "multi_ai_review") return "ClaudeBot + CodexBot";
  if (role === "claude_leader") return "ClaudeBot";
  if (role === "codex_leader") return "CodexBot";
  return undefined;
}

export function proposalTitleFromPayload(payload: Record<string, unknown>): string {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  return title || rawText.slice(0, 80) || "승인된 Telegram 작업";
}

// 완료 조건이 없으면 검증자가 판정할 기준이 없다. 제안 단계에서 못 뽑았을 때만 쓰는 최후 기본값.
export const DEFAULT_COMPLETION_CRITERIA = "요청 내용이 실제로 수행되어 결과가 확인 가능한 형태로 보고된다.";

export function proposalFieldFromPayload(payload: Record<string, unknown>, key: "purpose" | "scope" | "completionCriteria"): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function proposalRequestTextFromPayload(payload: Record<string, unknown>): string | undefined {
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  return rawText || title || undefined;
}
export function proposalIdNeedingPromptHydration(row: {
  target_kind: OutboxRow["target_kind"];
  payload: Record<string, unknown>;
}): string | undefined {
  if (row.target_kind !== "local_gateway") return undefined;
  const executionRequest = executionRequestPayload(row.payload);
  if (!executionRequest) return undefined;
  const taskId = executionRequest.taskId;
  if (typeof taskId !== "string" || !taskId) return undefined;
  // 이미 물질화된 작업(UUID)은 프롬프트가 채워져 있다. 아직 제안 단계인 것만 채운다.
  //
  // 예전에는 `proposal_` 접두사로 판별했는데, Telegram 콜백 64바이트 제한 때문에
  // 리더 제안 id 를 `p_...` 로 줄이자 이 검사가 걸러내 실행 에이전트가
  // 작업 명세 대신 id 만 받았다("해당 ID 를 조회할 수 없습니다"로 끝남).
  // 접두사가 아니라 "프롬프트가 아직 비어 있는가"로 판별한다.
  if (isUuid(taskId)) return undefined;
  const prompt = executionRequest.prompt;
  if (typeof prompt === "string" && prompt.trim() && !prompt.startsWith("Execute approved task ")) return undefined;
  return taskId;
}

export function executionRequestPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = payload.executionRequest;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function proposalPromptFromPayload(payload: Record<string, unknown>): string | undefined {
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const requestText = rawText || title;
  if (!requestText) return undefined;

  // 리더가 구조화한 것이 있으면 그대로 실행자에게 넘긴다.
  // 특히 완료 조건은 검증자가 합격/불합격을 판정할 기준이라, 실행자가 모르면
  // 무엇을 만족시켜야 하는지 알 수 없는 채로 일하게 된다.
  const purpose = proposalFieldFromPayload(payload, "purpose");
  const scope = proposalFieldFromPayload(payload, "scope");
  const completionCriteria = proposalFieldFromPayload(payload, "completionCriteria");
  const structured = [
    title ? `작업: ${title}` : undefined,
    purpose ? `목적: ${purpose}` : undefined,
    scope ? `범위: ${scope}` : undefined,
    completionCriteria ? `완료 조건: ${completionCriteria}` : undefined
  ].filter(Boolean);

  const body = structured.length > 1 ? structured.join("\n") : requestText;
  return buildApprovedTelegramTaskPrompt(body);
}

export function proposalActorRoleFromPayload(payload: Record<string, unknown>): ExecutionActorRole | undefined {
  const value = payload.requestedActorRole;
  if (value === "claude_leader" || value === "codex_leader") return value;
  return undefined;
}

// 테스트에서 지시문 내용을 직접 확인한다 — 사고를 막는 문장이 조용히 사라지면 안 된다.
export function buildApprovedTelegramTaskPromptForTest(requestText: string): string {
  return buildApprovedTelegramTaskPrompt(requestText);
}

export function buildApprovedTelegramTaskPrompt(requestText: string): string {
  return [
    "You are CodexBot executing an approved Telegram project-room task for the HuAI Collab Chatroom System.",
    "Treat the Telegram user request below as authoritative.",
    "Do not call this product an MVP. Use '완성 제품' or '정식 운영 버전' when describing scope.",
    "For project progress or operation-status questions, inspect OPERATION_STATUS.md first if it exists, then verify live scripts or runtime state before reporting.",
    "Do not infer that Telegram/Supabase/webhook/local-gateway operation is incomplete only because older Gate documents describe setup steps.",
    "Report only verified facts. If a check cannot run, say exactly which check failed.",
    "If you reach a high-impact decision that must be approved before the remaining work is safe, stop at that checkpoint and output exactly one MID_APPROVAL_START/MID_APPROVAL_END block containing JSON fields reportId (UUID), approvalRequestId, summary, significanceReason, and affectedTaskIds (known downstream task UUIDs; [] if none are known). Do not continue past that checkpoint in the same execution.",
    // 라이브 사고 — 작업자가 브라우저 테스트를 하며 `taskkill /F /IM chrome.exe` 를 실행해
    // 방장이 열어 둔 Chrome 창 약 50개를 통째로 죽였다. 저장 안 한 작업물이 날아갔다.
    // 작업 폴더 안에서 무엇을 하든 그건 우리 일이지만, 사람이 쓰던 프로그램을 끄는 것은
    // 작업 범위가 아니다.
    "Never terminate processes you did not start. Do not run taskkill, Stop-Process, pkill, or",
    "kill against browsers, editors, or any application the human may be using — the work machine",
    "is a person's desktop, not a build agent. If a test needs a browser, launch your own instance",
    "with a separate user-data-dir and close only that instance.",
    "Never restart or stop the operation services (bot-service, local-gateway) — you are running",
    "inside them; killing them ends the task that is asking you to work.",
    "",
    "USER_REQUEST:",
    requestText
  ].join("\n");
}

export function uuidFromProposalId(proposalId: string): string | undefined {
  const value = proposalId.startsWith("proposal_") ? proposalId.slice("proposal_".length) : proposalId;
  return isUuid(value) ? value : undefined;
}

export function taskIdempotencyKey(proposalId: string): string {
  return "task:approved-proposal:" + proposalId;
}
