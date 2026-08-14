import assert from "node:assert/strict";
import test from "node:test";
import { isForbiddenTransition, planReadyTasks, transitionTaskStatus, type WorkflowContext } from "../src/index.js";

const baseContext: WorkflowContext = {
  actorRole: "human_owner",
  isOwner: true,
  isAssignee: false,
  isVerifier: false,
  hasOwnerTaskApproval: true,
  hasVerificationPass: false,
  hasCommanderCompletionDecision: false,
  hasOwnerFinalApproval: false,
  idempotencyKey: "test"
};

test("AC-02: 승인 전 제안은 실행으로 전이될 수 없다", () => {
  // 승인 전 상태에서 실행 시작·게이트웨이 투입은 명시적 금지 전이다.
  assert.equal(isForbiddenTransition("proposal_pending", "task_started"), true);
  assert.equal(isForbiddenTransition("proposal_pending", "gateway_enqueued"), true);
  // 화이트리스트 역시 같은 전이를 거부해야 한다 (이중 방어).
  assert.deepEqual(transitionTaskStatus("proposal_pending", "task_started", baseContext), {
    allowed: false,
    reason: "transition-not-allowed"
  });
  // 승인 이후에는 금지 대상이 아니다.
  assert.equal(isForbiddenTransition("queued_for_gateway", "task_started"), false);
});

test("AC-02: 검증 단계에서 방장 최종 승인으로 건너뛸 수 없다", () => {
  for (const status of ["verification_pending", "verification_in_progress", "commander_completion_pending", "revision_requested"] as const) {
    assert.equal(isForbiddenTransition(status, "owner_final_approved"), true, status);
  }
});

test("blocks verifier assignment when verifier matches author", () => {
  const decision = transitionTaskStatus("verification_pending", "verification_started", {
    ...baseContext,
    actorRole: "auditor",
    isOwner: false,
    isVerifier: true,
    authorActorId: "actor-a",
    verifierActorId: "actor-a"
  });

  assert.equal(decision.allowed, false);
});

test("allows independent verifier assignment", () => {
  const decision = transitionTaskStatus("verification_pending", "verification_started", {
    ...baseContext,
    actorRole: "auditor",
    isOwner: false,
    isVerifier: true,
    authorActorId: "actor-a",
    verifierActorId: "actor-b"
  });

  assert.deepEqual(decision, { allowed: true, nextStatus: "verification_in_progress" });
});

test("commander completion approval requires platoon leader role", () => {
  const denied = transitionTaskStatus("commander_completion_pending", "commander_completion_approved", {
    ...baseContext,
    actorRole: "codex_leader",
    isOwner: false,
    isAssignee: true
  });
  const allowed = transitionTaskStatus("commander_completion_pending", "commander_completion_approved", {
    ...baseContext,
    actorRole: "platoon_leader",
    isOwner: false
  });

  assert.equal(denied.allowed, false);
  assert.deepEqual(allowed, { allowed: true, nextStatus: "completion_approval_pending" });
});

test("terminal task status is not polluted by late execution failures", () => {
  const retryAfterComplete = transitionTaskStatus("completed", "execution_retry_scheduled", baseContext);
  const blockedAfterCancelled = transitionTaskStatus("cancelled", "execution_delayed_or_failed", baseContext);

  assert.equal(retryAfterComplete.allowed, false);
  assert.equal(blockedAfterCancelled.allowed, false);
});
test("DAG scheduler runs independent tasks and waits on blocking predecessors", () => {
  const decision = planReadyTasks(
    [
      { taskId: "task-a", status: "scheduled" },
      { taskId: "task-b", status: "scheduled" },
      { taskId: "task-c", status: "scheduled" }
    ],
    [{ predecessorTaskId: "task-a", successorTaskId: "task-c", dependencyType: "blocks", isBlocking: true }]
  );

  assert.deepEqual(decision.readyTaskIds, ["task-a", "task-b"]);
  assert.deepEqual(decision.waitingTaskIds, ["task-c"]);
  assert.deepEqual(decision.blockedBy["task-c"], ["task-a"]);
});

test("DAG scheduler serializes same resource conflicts", () => {
  const decision = planReadyTasks(
    [
      { taskId: "task-a", status: "scheduled", resourceKeys: ["file:README.md"] },
      { taskId: "task-b", status: "scheduled", resourceKeys: ["file:README.md"] }
    ],
    []
  );

  assert.deepEqual(decision.readyTaskIds, ["task-a"]);
  assert.deepEqual(decision.waitingTaskIds, ["task-b"]);
  assert.deepEqual(decision.conflicts, [{ taskId: "task-b", resourceKey: "file:README.md", runningTaskId: "task-a" }]);
});

test("DAG scheduler blocks cycles instead of releasing work", () => {
  const decision = planReadyTasks(
    [
      { taskId: "task-a", status: "scheduled" },
      { taskId: "task-b", status: "scheduled" }
    ],
    [
      { predecessorTaskId: "task-a", successorTaskId: "task-b", dependencyType: "blocks", isBlocking: true },
      { predecessorTaskId: "task-b", successorTaskId: "task-a", dependencyType: "blocks", isBlocking: true }
    ]
  );

  assert.deepEqual(decision.readyTaskIds, []);
  assert.deepEqual(decision.cycleTaskIds, ["task-a", "task-b"]);
});