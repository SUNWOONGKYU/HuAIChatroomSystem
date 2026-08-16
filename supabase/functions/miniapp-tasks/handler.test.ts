// handleMiniappTasksRequest 회귀 테스트(hint 필드 배선). 실행 방법은
// ../_shared/proposal-payload.test.ts 상단 주석 참고. 방 격리는 room-isolation.test.ts 가 따로 본다.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMiniappTasksRequest, type TasksHandlerDeps, type TaskRow } from "./handler";

function taskRow(overrides: Partial<TaskRow> & { task_id: string; status: string }): TaskRow {
  return {
    priority: "normal",
    title: "제목",
    purpose: "목적",
    scope: "범위",
    completion_criteria: "완료 기준",
    created_at: "2026-08-15T00:00:00Z",
    updated_at: "2026-08-15T00:00:00Z",
    assignee_actor_id: null,
    assignee: null,
    ...overrides
  };
}

function makeDeps(tasks: TaskRow[]): TasksHandlerDeps {
  return {
    authenticate: async () => ({ ok: true, telegramUserId: "111" }),
    checkRoomAccess: async (roomId) => ({ ok: true, room: { roomId, purpose: "테스트 방" }, viewerRole: "human_member" }),
    fetchArtifactsForTasks: async () => ({ data: [] }),
    fetchTasksForRoom: async () => ({ data: tasks })
  };
}

function req(): Request {
  return new Request("https://x/miniapp-tasks?roomId=room-a", { method: "GET", headers: { authorization: "tma fake" } });
}

test("mid_approval_pending 작업은 decidable=false이고 hint가 응답에 실린다", async () => {
  const deps = makeDeps([taskRow({ task_id: "t1", status: "mid_approval_pending" })]);
  const res = await handleMiniappTasksRequest(req(), deps);
  const body = await res.json();
  const task = body.tasks[0];
  assert.equal(task.decidable, false);
  assert.ok(task.hint && task.hint.length > 0);
});

test("completion_approval_pending 작업은 decidable=true이고 hint는 null이다", async () => {
  const deps = makeDeps([taskRow({ task_id: "t2", status: "completion_approval_pending" })]);
  const res = await handleMiniappTasksRequest(req(), deps);
  const body = await res.json();
  const task = body.tasks[0];
  assert.equal(task.decidable, true);
  assert.equal(task.hint, null);
});
