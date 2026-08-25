export type TaskStatus =
  | "proposal_pending"
  | "proposal_revision_requested"
  | "proposal_rejected"
  | "scheduled"
  | "waiting_dependencies"
  | "queued_for_gateway"
  | "in_progress"
  | "mid_approval_pending"
  | "paused_by_owner"
  | "verification_pending"
  | "verification_in_progress"
  | "revision_requested"
  | "revision_in_progress"
  | "reverification_pending"
  | "commander_completion_pending"
  | "completion_approval_pending"
  | "owner_supplement_requested"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed_retryable"
  | "blocked"
  | "rejected_or_cancelled";

export type WorkflowEventType =
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

export type WorkflowContext = {
  actorRole: string;
  isOwner: boolean;
  isAssignee: boolean;
  isVerifier: boolean;
  authorActorId?: string;
  verifierActorId?: string;
  hasOwnerTaskApproval: boolean;
  hasVerificationPass: boolean;
  hasCommanderCompletionDecision: boolean;
  hasOwnerFinalApproval: boolean;
  changedScope?: "format_only" | "content" | "scope_change";
  idempotencyKey: string;
};

export type TransitionDecision =
  | { allowed: true; nextStatus: TaskStatus }
  | { allowed: false; reason: string };


export type WorkflowTaskNode = {
  taskId: string;
  status: TaskStatus;
  resourceKeys?: readonly string[];
};

export type WorkflowTaskDependency = {
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: "blocks" | "same_file_conflict" | "resource_conflict" | "related";
  isBlocking: boolean;
};

export type DagScheduleDecision = {
  readyTaskIds: string[];
  waitingTaskIds: string[];
  blockedBy: Record<string, string[]>;
  conflicts: Array<{ taskId: string; resourceKey: string; runningTaskId: string }>;
  cycleTaskIds: string[];
};

export function planReadyTasks(
  tasks: readonly WorkflowTaskNode[],
  dependencies: readonly WorkflowTaskDependency[]
): DagScheduleDecision {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const completed = new Set(tasks.filter((task) => isDependencySatisfiedStatus(task.status)).map((task) => task.taskId));
  const runningResources = new Map<string, string>();
  const readyTaskIds: string[] = [];
  const waitingTaskIds: string[] = [];
  const blockedBy: Record<string, string[]> = {};
  const conflicts: DagScheduleDecision["conflicts"] = [];
  const cycleTaskIds = detectBlockingDependencyCycle(tasks, dependencies);
  const cycleSet = new Set(cycleTaskIds);

  for (const task of tasks) {
    if (task.status === "in_progress" || task.status === "queued_for_gateway") {
      for (const key of task.resourceKeys ?? []) runningResources.set(key, task.taskId);
    }
  }

  for (const task of tasks) {
    if (!["scheduled", "waiting_dependencies"].includes(task.status)) continue;
    const blockers = dependencies
      .filter((dependency) => dependency.successorTaskId === task.taskId && dependency.isBlocking && dependency.dependencyType !== "related")
      .map((dependency) => dependency.predecessorTaskId)
      .filter((predecessorId) => taskById.has(predecessorId) && !completed.has(predecessorId));
    if (cycleSet.has(task.taskId)) blockers.push("cycle");
    if (blockers.length > 0) {
      blockedBy[task.taskId] = Array.from(new Set(blockers));
      waitingTaskIds.push(task.taskId);
      continue;
    }

    const resourceConflict = (task.resourceKeys ?? [])
      .map((key) => ({ key, runningTaskId: runningResources.get(key) }))
      .find((item): item is { key: string; runningTaskId: string } => Boolean(item.runningTaskId));
    if (resourceConflict) {
      conflicts.push({ taskId: task.taskId, resourceKey: resourceConflict.key, runningTaskId: resourceConflict.runningTaskId });
      blockedBy[task.taskId] = [resourceConflict.runningTaskId];
      waitingTaskIds.push(task.taskId);
      continue;
    }

    readyTaskIds.push(task.taskId);
    for (const key of task.resourceKeys ?? []) runningResources.set(key, task.taskId);
  }

  return { readyTaskIds, waitingTaskIds, blockedBy, conflicts, cycleTaskIds };
}

function isDependencySatisfiedStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "commander_completion_pending" || status === "completion_approval_pending";
}

function detectBlockingDependencyCycle(tasks: readonly WorkflowTaskNode[], dependencies: readonly WorkflowTaskDependency[]): string[] {
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const graph = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (!dependency.isBlocking || dependency.dependencyType === "related") continue;
    if (!taskIds.has(dependency.predecessorTaskId) || !taskIds.has(dependency.successorTaskId)) continue;
    const edges = graph.get(dependency.predecessorTaskId) ?? [];
    edges.push(dependency.successorTaskId);
    graph.set(dependency.predecessorTaskId, edges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle = new Set<string>();

  function visit(taskId: string, stack: string[]): void {
    if (visiting.has(taskId)) {
      const start = stack.indexOf(taskId);
      for (const id of stack.slice(Math.max(start, 0))) cycle.add(id);
      return;
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const next of graph.get(taskId) ?? []) visit(next, [...stack, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const taskId of taskIds) visit(taskId, []);
  return Array.from(cycle).sort();
}
export function transitionTaskStatus(
  current: TaskStatus,
  event: WorkflowEventType,
  context: WorkflowContext
): TransitionDecision {
  if (event === "proposal_revision_requested" && current === "proposal_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "proposal_revision_requested" };
  }
  if (event === "proposal_rejected" && current === "proposal_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "proposal_rejected" };
  }
  if (event === "owner_task_approved" && current === "proposal_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "scheduled" };
  }
  if (event === "owner_task_rejected" && ["proposal_pending", "scheduled"].includes(current) && context.isOwner) {
    return { allowed: true, nextStatus: "rejected_or_cancelled" };
  }
  if (event === "dependencies_satisfied" && ["scheduled", "waiting_dependencies"].includes(current)) {
    return { allowed: true, nextStatus: "queued_for_gateway" };
  }
  if (event === "gateway_enqueued" && current === "queued_for_gateway") {
    return { allowed: true, nextStatus: "queued_for_gateway" };
  }
  if (event === "task_started" && current === "queued_for_gateway") {
    return { allowed: true, nextStatus: "in_progress" };
  }
  if (event === "mid_approval_required" && current === "in_progress") {
    return { allowed: true, nextStatus: "mid_approval_pending" };
  }
  if (event === "owner_mid_approved" && current === "mid_approval_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "in_progress" };
  }
  if (event === "owner_mid_rejected" && current === "mid_approval_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "paused_by_owner" };
  }
  if (event === "owner_verification_requested" && ["in_progress", "revision_in_progress", "reverification_pending"].includes(current) && context.isOwner) {
    return { allowed: true, nextStatus: "verification_pending" };
  }
  // 의미 있는 산출물이 나오면 시스템이 검증을 부른다 (FR-012).
  // 방장이 매번 "검증해줘"를 눌러야 한다면 작업이 사람 손을 떠나지 못한다.
  // 검증 호출 자체는 방장 결정 사항이 아니다 — 완료 승인만 방장 몫이다.
  //
  // current 에 "blocked" 도 받는 이유(실측 결함, 2026-08-25): 다중 AI("both") 배정은
  // Claude·Codex 를 병렬로 돌린다. 한쪽이 먼저 시간초과로 실패하면 이 함수가 그 실패
  // 하나만 보고 즉시 blocked 로 확정했는데, 그 직후 다른 한쪽이 실제로 성공해도
  // meaningful_intermediate_ready 가 current==="in_progress" 만 받아줘서 blocked 에서는
  // 막혔다 — 짝의 성공이 조용히 묻히고 작업이 영영 "막힘"에 남았다(라이브 재현:
  // task d364326a, ClaudeBot 실패 후 CodexBot 이 실제로 산출물까지 만들었는데 상태만
  // blocked 로 굳음). blocked 를 여기서도 받아야, 나중에 도착하는 짝의 성공이 작업을
  // 다시 앞으로 옮길 수 있다 — "한쪽만 실패해도 병렬 배정 전체가 죽는다"는 뜻이
  // 아니게 하려는 것이다.
  if (event === "meaningful_intermediate_ready" && (current === "in_progress" || current === "blocked")) {
    return { allowed: true, nextStatus: "verification_pending" };
  }
  if (event === "verification_started" && current === "verification_pending" && isIndependentVerifier(context)) {
    return { allowed: true, nextStatus: "verification_in_progress" };
  }
  if (event === "verification_failed_or_changes_requested" && current === "verification_in_progress" && context.isVerifier) {
    return { allowed: true, nextStatus: "revision_requested" };
  }
  if (event === "owner_reverification_requested" && ["revision_requested", "reverification_pending"].includes(current) && context.isOwner) {
    return { allowed: true, nextStatus: "reverification_pending" };
  }
  if (event === "revision_submitted" && current === "revision_requested" && context.isAssignee) {
    return { allowed: true, nextStatus: "reverification_pending" };
  }
  if (event === "verification_passed" && current === "verification_in_progress" && context.isVerifier) {
    return { allowed: true, nextStatus: "commander_completion_pending" };
  }
  if (event === "reverification_passed" && current === "verification_in_progress" && context.isVerifier) {
    return { allowed: true, nextStatus: "commander_completion_pending" };
  }
  if (event === "commander_completion_approved" && current === "commander_completion_pending" && context.actorRole === "leader") {
    return { allowed: true, nextStatus: "completion_approval_pending" };
  }
  if (event === "owner_supplement_requested" && current === "completion_approval_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "owner_supplement_requested" };
  }
  if (event === "owner_final_approved" && current === "completion_approval_pending" && context.isOwner) {
    return { allowed: true, nextStatus: "completed" };
  }
  if (event === "owner_cancel_requested" && !["completed", "cancelled"].includes(current) && context.isOwner) {
    return { allowed: true, nextStatus: "cancel_requested" };
  }
  if (event === "cancel_approved" && current === "cancel_requested" && context.isOwner) {
    return { allowed: true, nextStatus: "cancelled" };
  }
  if (event === "execution_retry_scheduled" && !isTerminalStatus(current)) {
    return { allowed: true, nextStatus: "failed_retryable" };
  }
  if (event === "execution_delayed_or_failed" && !isTerminalStatus(current)) {
    return { allowed: true, nextStatus: "blocked" };
  }
  if (event === "post_completion_minor_change_requested" && current === "completed") {
    return { allowed: true, nextStatus: "completed" };
  }
  if (event === "post_completion_scope_change_requested" && current === "completed") {
    return { allowed: false, reason: "scope-change-requires-new-task" };
  }
  return { allowed: false, reason: "transition-not-allowed" };
}

export function isForbiddenTransition(current: TaskStatus, event: WorkflowEventType): boolean {
  return (
    (current === "proposal_pending" && ["task_started", "gateway_enqueued"].includes(event)) ||
    (current === "verification_pending" && ["owner_final_approved"].includes(event)) ||
    (current === "verification_in_progress" && event === "owner_final_approved") ||
    (current === "commander_completion_pending" && event === "owner_final_approved") ||
    (current === "revision_requested" && event === "owner_final_approved") ||
    (current === "completed" && ["task_started", "owner_task_approved"].includes(event))
  );
}

function isTerminalStatus(status: TaskStatus): boolean {
  return ["completed", "cancelled", "proposal_rejected", "rejected_or_cancelled"].includes(status);
}

function isIndependentVerifier(context: WorkflowContext): boolean {
  return context.isVerifier && Boolean(context.verifierActorId) && context.verifierActorId !== context.authorActorId;
}

