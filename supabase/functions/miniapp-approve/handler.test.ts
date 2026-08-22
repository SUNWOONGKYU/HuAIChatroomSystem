// handleMiniappApproveRequest 회귀 테스트. 실행 방법은
// ../_shared/proposal-payload.test.ts 상단 주석 참고.
//
// 핵심 회귀 대상(이번 라운드 — stage 정리 3건, Alpha 계약):
//   1) mid_approval_pending 은 결정 자체가 안 된다(어떤 액션이든 409) — Telegram 에 이
//      상태를 벗어나는 버튼이 없어서 Mini App 도 만들지 않는다(팀장님 확정).
//   2) commander_completion_pending 은 completion_approval_pending 과 같은 결정
//      (stage='final_approval')으로 취급된다 — 둘 다 final_approve/request_revision 만
//      받고 approve/reject 는 어느 쪽도 못 받는다(반려는 Telegram 완료 게이트에 없음).
//   3) request_revision 은 huai_can_act_in_room() 이 통과시켜도(non-owner + 권한 배열
//      보유) 추가로 owner 가 아니면 403 이어야 한다 — Telegram 콜백 경로의 requiresOwner()
//      와 동작을 맞춘 것.
//   4) idempotency_key 는 같은 (action, entity, status) 재시도에 항상 같은 값이어야
//      한다(Alpha 폴러가 이 값을 재사용해 재생을 원본과 같은 키로 흡수시킨다).
//   5) (실측 버그 수정) task.status 만으로는 부족하다 — 같은 상태로 두 번째 라운드에 다시
//      도달하면 status 만으론 라운드를 못 갈라 huai_approvals unique 제약에 막혀 두 번째
//      결정이 원장에 기록조차 안 된다. task.updated_at 을 같이 넣어 라운드를 가른다.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMiniappApproveRequest, requiresOwnerRoleOverride, isUuid, type ApproveHandlerDeps, type TaskRow } from "./handler";

const FINAL_APPROVAL_TASK: TaskRow = {
  task_id: "task-1",
  room_id: "room-1",
  status: "completion_approval_pending",
  updated_at: "2026-08-15T10:00:00.000Z"
};
const COMMANDER_COMPLETION_TASK: TaskRow = {
  task_id: "task-2",
  room_id: "room-1",
  status: "commander_completion_pending",
  updated_at: "2026-08-15T10:00:00.000Z"
};
const MID_APPROVAL_TASK: TaskRow = {
  task_id: "task-3",
  room_id: "room-1",
  status: "mid_approval_pending",
  updated_at: "2026-08-15T10:00:00.000Z"
};

function makeDeps(overrides: Partial<ApproveHandlerDeps> = {}): ApproveHandlerDeps {
  return {
    authenticate: async () => ({ ok: true, telegramUserId: "111" }),
    fetchTask: async () => ({ data: FINAL_APPROVAL_TASK }),
    checkPermission: async () => ({ data: true }), // huai_can_act_in_room 이 통과시켰다고 가정
    fetchMembershipRole: async () => ({ data: { role: "human_member" } }),
    fetchProposalRoomId: async () => ({ data: { room_id: "room-1" } }),
    checkProposalAlreadyDecided: async () => ({ data: false }),
    insertApproval: async () => ({ data: { approval_id: "appr-1" } }),
    insertEvent: async () => ({}),
    fetchTaskQuizStatus: async () => ({ data: { hasQuiz: false, passed: false } }),
    ...overrides
  };
}

function req(body: unknown): Request {
  return new Request("https://x/miniapp-approve", {
    method: "POST",
    headers: { authorization: "tma fake", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("requiresOwnerRoleOverride 는 request_revision 에만 true", () => {
  assert.equal(requiresOwnerRoleOverride("request_revision"), true);
  assert.equal(requiresOwnerRoleOverride("approve"), false);
  assert.equal(requiresOwnerRoleOverride("reject"), false);
  assert.equal(requiresOwnerRoleOverride("final_approve"), false);
  assert.equal(requiresOwnerRoleOverride("cancel"), false);
});

// ── 1) mid_approval_pending: 결정 창구 없음 ──

test("mid_approval_pending 상태의 task는 어떤 액션을 보내도 409 (권한 체크 전에 이미 차단)", async () => {
  let permissionChecked = false;
  const deps = makeDeps({
    fetchTask: async () => ({ data: MID_APPROVAL_TASK }),
    checkPermission: async () => {
      permissionChecked = true;
      return { data: true };
    }
  });
  for (const action of ["approve", "reject", "request_revision", "final_approve"]) {
    const res = await handleMiniappApproveRequest(req({ taskId: "task-3", action }), deps);
    assert.equal(res.status, 409, action);
    const body = await res.json();
    assert.equal(body.error, "not-awaiting-decision", action);
  }
  assert.equal(permissionChecked, false, "결정 불가 상태면 권한 체크까지 갈 필요가 없다");
});

// ── 2) commander_completion_pending == completion_approval_pending (stage 통합) ──

test("commander_completion_pending 도 completion_approval_pending 과 똑같이 final_approve/request_revision만 받는다", async () => {
  const inserted: any[] = [];
  const deps = makeDeps({
    fetchTask: async () => ({ data: COMMANDER_COMPLETION_TASK }),
    insertApproval: async (row) => {
      inserted.push(row);
      return { data: { approval_id: "appr-cc" } };
    }
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-2", action: "final_approve" }), deps);
  assert.equal(res.status, 200);
  assert.equal(inserted[0].stage, "final_approval", "commander_completion_pending도 stage='final_approval'로 기록되어야 한다");
  assert.equal(inserted[0].decision, "approved");
});

test("commander_completion_pending 에서 approve/reject 는 거부된다(둘 다 final_approval 전용 액션 세트 밖)", async () => {
  const deps = makeDeps({ fetchTask: async () => ({ data: COMMANDER_COMPLETION_TASK }) });
  for (const action of ["approve", "reject"]) {
    const res = await handleMiniappApproveRequest(req({ taskId: "task-2", action }), deps);
    assert.equal(res.status, 409, action);
    const body = await res.json();
    assert.equal(body.error, "action-not-allowed-for-stage", action);
  }
});

test("completion_approval_pending 에서 reject 는 거부된다 (Telegram 완료 게이트엔 반려가 없다)", async () => {
  const deps = makeDeps({ fetchTask: async () => ({ data: FINAL_APPROVAL_TASK }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "reject" }), deps);
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error, "action-not-allowed-for-stage");
});

test("completion_approval_pending 에서 approve(final_approve 아님)도 거부된다", async () => {
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "approve" }), makeDeps());
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error, "action-not-allowed-for-stage");
});

test("completion_approval_pending 에서 request_revision(보완요청)은 통과된다", async () => {
  const deps = makeDeps({ fetchMembershipRole: async () => ({ data: { role: "owner" } }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "request_revision" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.decision, "revision_requested");
});

// ── 3) request_revision owner 강제 ──

test("비-owner(human_member)의 request_revision은 huai_can_act_in_room이 통과시켜도 403으로 거부된다", async () => {
  let membershipChecked = false;
  const deps = makeDeps({
    checkPermission: async () => ({ data: true }), // schema.sql의 'task:create'는 관대해서 통과
    fetchMembershipRole: async () => {
      membershipChecked = true;
      return { data: { role: "human_member" } };
    },
    insertApproval: async () => {
      throw new Error("owner 가 아닌데 원장에 기록되면 안 된다");
    }
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "request_revision" }), deps);
  assert.equal(res.status, 403);
  assert.equal(membershipChecked, true);
});

test("owner의 request_revision은 통과되어 원장에 기록된다", async () => {
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } })
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "request_revision" }), deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.decision, "revision_requested");
});

test("final_approve 액션은 owner 여부와 무관하게 huai_can_act_in_room 결과만 본다(멤버십 재조회 없음)", async () => {
  let membershipChecked = false;
  const deps = makeDeps({
    checkPermission: async () => ({ data: true }),
    fetchMembershipRole: async () => {
      membershipChecked = true;
      return { data: { role: "human_member" } };
    }
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 200);
  assert.equal(membershipChecked, false, "final_approve는 추가 owner 게이트를 타면 안 된다(회귀 방지)");
});

test("huai_can_act_in_room이 false면 403 (owner 게이트 이전에 이미 차단)", async () => {
  const deps = makeDeps({ checkPermission: async () => ({ data: false }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 403);
});

test("결정을 받을 수 없는 상태의 작업이면 409", async () => {
  const deps = makeDeps({
    fetchTask: async () => ({ data: { task_id: "t", room_id: "r", status: "in_progress", updated_at: "2026-08-15T10:00:00.000Z" } })
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "t", action: "final_approve" }), deps);
  assert.equal(res.status, 409);
});

test("idempotency_key 충돌(23505)은 이미 기록된 것으로 보고 200을 반환한다", async () => {
  const deps = makeDeps({
    insertApproval: async () => ({ error: { code: "23505", message: "duplicate" } })
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 200);
});

test("존재하지 않는 taskId는 404", async () => {
  const deps = makeDeps({ fetchTask: async () => ({ data: null }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "nope", action: "final_approve" }), deps);
  assert.equal(res.status, 404);
});

// ── 4) idempotency_key 안정성 (Alpha 폴러 재생 흡수 전제조건) ──

test("idempotency_key는 시간에 따라 바뀌지 않는다 — 같은 (action, task, status) 재시도는 항상 같은 키", async () => {
  const keys: string[] = [];
  const deps = makeDeps({
    insertApproval: async (row) => {
      keys.push(row.idempotency_key);
      return { data: { approval_id: "appr-x" } };
    }
  });
  await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(keys[0], keys[1], "5초 버킷처럼 시간에 좌우되면 재시도가 흡수되지 않는다(팀장님 지적)");
});

test("제안 idempotency_key도 시간에 따라 바뀌지 않는다", async () => {
  const keys: string[] = [];
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    insertApproval: async (row) => {
      keys.push(row.idempotency_key);
      return { data: { approval_id: "appr-y" } };
    }
  });
  await handleMiniappApproveRequest(req({ proposalId: "p_stable", action: "approve" }), deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await handleMiniappApproveRequest(req({ proposalId: "p_stable", action: "approve" }), deps);
  assert.equal(keys[0], keys[1]);
});

// 실측으로 확인된 버그의 정확한 재현 + 수정 증명. 시나리오(팀장님 보고 그대로):
//   1) completion_approval_pending 에서 보완 요청 (1라운드)
//   2) 재작업 완료 → 다시 completion_approval_pending 도달 (2라운드)
//   3) 또 보완 요청
// task.status 만 키에 넣으면 1·3번의 문자열이 완전히 같아서 huai_approvals unique 제약에
// 막혀 3번이 원장에 기록조차 안 된다(팀장님 실측). task.updated_at 을 추가하면 라운드마다
// 값이 달라(patchTaskStatus 가 전이마다 갱신) 3번이 새 키로 정상 통과해야 한다.
test("라운드 넘어간 재요청 — 같은 status로 되돌아와도 updated_at이 다르면 새 결정으로 통과한다 (버그 수정 핵심)", async () => {
  const keys: string[] = [];
  const inserted: string[] = []; // idempotency_key 별로 몇 번 "실제 삽입"됐는지 시뮬레이션
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    fetchTask: async () => ({
      data: { task_id: "task-1", room_id: "room-1", status: "completion_approval_pending", updated_at: "2026-08-15T10:00:00.000Z" }
    }),
    insertApproval: async (row) => {
      keys.push(row.idempotency_key);
      // 실제 DB의 idempotency_key unique 제약을 흉내낸다 — 같은 키가 두 번째로 오면 23505.
      if (inserted.includes(row.idempotency_key)) return { error: { code: "23505", message: "duplicate" } };
      inserted.push(row.idempotency_key);
      return { data: { approval_id: "appr-round-" + inserted.length } };
    }
  });

  // 1라운드: 보완 요청.
  const round1 = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "request_revision" }), deps);
  assert.equal(round1.status, 200);

  // 2라운드: 재작업 후 같은 상태로 복귀(updated_at 만 바뀜) — fetchTask 를 교체해 흉내낸다.
  deps.fetchTask = async () => ({
    data: { task_id: "task-1", room_id: "room-1", status: "completion_approval_pending", updated_at: "2026-08-15T11:30:00.000Z" }
  });
  const round2 = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "request_revision" }), deps);

  assert.notEqual(keys[0], keys[1], "status 만 같고 updated_at 이 다르면 서로 다른 키가 나와야 한다");
  assert.equal(round2.status, 200, "2라운드 결정이 unique 제약에 막혀 조용히 사라지면 안 된다(팀장님 실측 버그)");
  assert.equal(inserted.length, 2, "두 라운드 모두 원장에 실제로 기록되어야 한다");
});

test("같은 라운드 안의 진짜 중복 클릭(짧은 재시도, updated_at 불변)은 여전히 걸러진다", async () => {
  const keys: string[] = [];
  const deps = makeDeps({
    insertApproval: async (row) => {
      keys.push(row.idempotency_key);
      return { data: { approval_id: "appr-z" } };
    }
  });
  await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps); // fetchTask 는 그대로(같은 updated_at)
  assert.equal(keys[0], keys[1]);
});

test("final_approve/cancel 도 status+updated_at 규칙을 그대로 쓴다(같은 코드 경로 확인)", async () => {
  const finalApproveKeys: string[] = [];
  const deps1 = makeDeps({
    insertApproval: async (row) => {
      finalApproveKeys.push(row.idempotency_key);
      return { data: { approval_id: "a1" } };
    }
  });
  await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps1);
  assert.equal(finalApproveKeys[0], "miniapp:final_approve:task-1:completion_approval_pending:2026-08-15T10:00:00.000Z");

  const cancelKeys: string[] = [];
  const deps2 = makeDeps({
    checkPermission: async () => ({ data: true }),
    insertApproval: async (row) => {
      cancelKeys.push(row.idempotency_key);
      return { data: { approval_id: "a2" } };
    }
  });
  await handleMiniappApproveRequest(req({ taskId: "task-1", action: "cancel" }), deps2);
  assert.equal(cancelKeys[0], "miniapp:cancel:task-1:completion_approval_pending:2026-08-15T10:00:00.000Z");
});

test("taskId와 proposalId를 동시에 보내면 400", async () => {
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", proposalId: "p_abc", action: "final_approve" }), makeDeps());
  assert.equal(res.status, 400);
});

test("taskId도 proposalId도 없으면 400", async () => {
  const res = await handleMiniappApproveRequest(req({ action: "final_approve" }), makeDeps());
  assert.equal(res.status, 400);
});

test("제안에 final_approve/cancel을 보내면 400 (제안 단계에 없는 개념)", async () => {
  for (const action of ["final_approve", "cancel"]) {
    const res = await handleMiniappApproveRequest(req({ proposalId: "p_abc", action }), makeDeps());
    assert.equal(res.status, 400, action);
  }
});

test("제안 승인 — owner 통과, isUuid=false 인 id 형식(proposal_/p_)은 task_id=null로 기록된다", async () => {
  const inserted: any[] = [];
  const deps = makeDeps({
    fetchProposalRoomId: async () => ({ data: { room_id: "room-9" } }),
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    insertApproval: async (row) => {
      inserted.push(row);
      return { data: { approval_id: "appr-9" } };
    }
  });
  const res = await handleMiniappApproveRequest(
    req({ proposalId: "proposal_11111111-1111-1111-1111-111111111111", action: "approve" }),
    deps
  );
  assert.equal(res.status, 200);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].task_id, null, "proposal_<uuid> 는 isUuid()를 통과하지 못해 task_id가 null이어야 한다");
  assert.equal(inserted[0].room_id, "room-9");
  assert.equal(inserted[0].stage, "task_approval");
  assert.equal(inserted[0].decision, "approved");
  assert.equal(inserted[0].entity_ref, "proposal_11111111-1111-1111-1111-111111111111");
});

test("제안 거부 — p_<16hex> 형식도 동일하게 처리되고 task_id=null", async () => {
  const inserted: any[] = [];
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    insertApproval: async (row) => {
      inserted.push(row);
      return { data: { approval_id: "appr-10" } };
    }
  });
  const res = await handleMiniappApproveRequest(req({ proposalId: "p_0123456789abcdef", action: "reject" }), deps);
  assert.equal(res.status, 200);
  assert.equal(inserted[0].task_id, null);
  assert.equal(inserted[0].decision, "rejected");
});

test("isUuid() — 순수 UUID만 true, proposal_/p_ 접두 형식은 false", () => {
  assert.equal(isUuid("11111111-1111-1111-1111-111111111111"), false, "v1 형식(첫 그룹 1)이 아니라 확인용");
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isUuid("proposal_11111111-1111-4111-8111-111111111111"), false);
  assert.equal(isUuid("p_0123456789abcdef"), false);
});

test("제안 승인 — 비-owner는 403이고 원장에 기록하지 않는다", async () => {
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "human_member" } }),
    insertApproval: async () => {
      throw new Error("owner 가 아닌데 기록되면 안 된다");
    }
  });
  const res = await handleMiniappApproveRequest(req({ proposalId: "p_abc", action: "approve" }), deps);
  assert.equal(res.status, 403);
});

test("제안 승인 — 존재하지 않는(또는 이벤트가 없는) proposalId는 404", async () => {
  const deps = makeDeps({ fetchProposalRoomId: async () => ({ data: null }) });
  const res = await handleMiniappApproveRequest(req({ proposalId: "p_ghost", action: "approve" }), deps);
  assert.equal(res.status, 404);
});

test("제안 승인 — 이미 결정된 제안에 또 결정하면 409 (원장 모순 방지)", async () => {
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    checkProposalAlreadyDecided: async () => ({ data: true }),
    insertApproval: async () => {
      throw new Error("이미 결정된 제안에 또 기록되면 안 된다");
    }
  });
  const res = await handleMiniappApproveRequest(req({ proposalId: "p_abc", action: "approve" }), deps);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "already-decided");
});

test("제안 승인 — huai_events(miniapp_decision_recorded) payload에 proposalId가 실린다", async () => {
  let eventPayload: any;
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    insertEvent: async (row) => {
      eventPayload = row.payload;
      return {};
    }
  });
  await handleMiniappApproveRequest(req({ proposalId: "p_watched", action: "request_revision", reason: "더 구체화 필요" }), deps);
  assert.equal(eventPayload.proposalId, "p_watched");
  assert.equal(eventPayload.action, "request_revision");
  assert.equal(eventPayload.decision, "revision_requested");
  assert.equal(eventPayload.reason, "더 구체화 필요");
});

// ── 인지부채 방지 퀴즈 게이트 (Orca/Buzz 벤치마킹) ──

test("퀴즈가 있는데 통과 못 했으면 final_approve 는 409 quiz-not-passed", async () => {
  let approvalInserted = false;
  const deps = makeDeps({
    fetchTaskQuizStatus: async () => ({ data: { hasQuiz: true, passed: false } }),
    insertApproval: async () => { approvalInserted = true; return { data: { approval_id: "appr-x" } }; }
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "quiz-not-passed");
  assert.equal(approvalInserted, false, "퀴즈를 안 풀었으면 승인 원장에 아예 기록되면 안 된다");
});

test("퀴즈를 통과했으면 final_approve 는 정상 처리된다", async () => {
  const deps = makeDeps({ fetchTaskQuizStatus: async () => ({ data: { hasQuiz: true, passed: true } }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 200);
});

test("퀴즈 행 자체가 없으면(파일 안 바꾼 작업) final_approve 는 게이트 없이 통과된다", async () => {
  const deps = makeDeps({ fetchTaskQuizStatus: async () => ({ data: { hasQuiz: false, passed: false } }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 200);
});

test("request_revision(보완요청)은 퀴즈를 통과하지 않았어도 막히지 않는다", async () => {
  const deps = makeDeps({
    fetchMembershipRole: async () => ({ data: { role: "owner" } }),
    fetchTaskQuizStatus: async () => ({ data: { hasQuiz: true, passed: false } })
  });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "request_revision" }), deps);
  assert.equal(res.status, 200);
});

test("퀴즈 상태 조회가 실패하면 500 (승인을 조용히 통과시키지 않는다)", async () => {
  const deps = makeDeps({ fetchTaskQuizStatus: async () => ({ error: "network-error" }) });
  const res = await handleMiniappApproveRequest(req({ taskId: "task-1", action: "final_approve" }), deps);
  assert.equal(res.status, 500);
});
