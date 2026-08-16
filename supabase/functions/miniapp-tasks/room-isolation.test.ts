// 방 격리(room isolation) 실행 검증 — 실행 방법은 ../_shared/proposal-payload.test.ts 상단
// 주석 참고(스크래치 디렉터리에 복사 + .ts 확장자 제거 + tsc + node --test).
//
// 이 테스트가 handler.test.ts 류(존재하지 않음 — 이 방은 이번에 처음 handler.ts 로 쪼갰다)와
// 다른 지점: deps.fetchTasksForRoom 을 가짜 함수로 통짜 대체하지 않고, buildDepsFromClient 에
// 진짜 쿼리 빌더 체인을 실행하는 FakeSupabaseClient 를 넣는다. 그래서 "room-A 를 요청하면
// room-B 행이 정말로 안 섞여 나오는가"를 handler 인자 전달 여부가 아니라 쿼리 결과로 증명한다.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeSupabaseClient } from "../_shared/fake-supabase-client";
import { handleMiniappTasksRequest, buildDepsFromClient, type TasksHandlerDeps, type TaskRow } from "./handler";

function taskRow(overrides: Partial<TaskRow> & { task_id: string; room_id: string }): TaskRow & { room_id: string } {
  return {
    status: "in_progress",
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

function seededClient() {
  return new FakeSupabaseClient({
    huai_tasks: [
      taskRow({ task_id: "task-a1", room_id: "room-A", title: "A방 작업1" }),
      taskRow({ task_id: "task-a2", room_id: "room-A", title: "A방 작업2" }),
      taskRow({ task_id: "task-b1", room_id: "room-B", title: "B방 작업1" })
    ]
  });
}

// 방장 요청 — 방 하나 안에서 주제를 갈라 쓰는데 현황판이 방 전체를 보여주면 주제를 나눈
// 의미가 없다. 주제마다 고정한 현황판은 그 주제 작업만 열어야 한다.
function topicSeededClient() {
  return new FakeSupabaseClient({
    huai_tasks: [
      taskRow({ task_id: "task-egg", room_id: "room-A", title: "달걀 게임", telegram_message_thread_id: "613" } as never),
      taskRow({ task_id: "task-sys", room_id: "room-A", title: "시스템 구현", telegram_message_thread_id: "42" } as never),
      taskRow({ task_id: "task-general", room_id: "room-A", title: "주제 없음" })
    ]
  });
}

test("주제를 지정하면 그 주제 작업만 나온다", async () => {
  const deps = buildDepsFromClient(topicSeededClient());
  const result = await deps.fetchTasksForRoom("room-A", "613");
  assert.deepEqual((result.data ?? []).map((t) => t.task_id), ["task-egg"]);
});

test("주제를 안 주면 방 전체가 나온다 — 일반 그룹·General 현황판이 그렇다", async () => {
  const deps = buildDepsFromClient(topicSeededClient());
  const result = await deps.fetchTasksForRoom("room-A");
  assert.deepEqual((result.data ?? []).map((t) => t.task_id).sort(), ["task-egg", "task-general", "task-sys"]);
});

test("주제 번호가 같아도 다른 방 작업은 안 섞인다", async () => {
  // 주제 번호는 방마다 새로 매겨진다. 주제만으로 거르면 남의 방 작업이 딸려 나온다.
  const client = new FakeSupabaseClient({
    huai_tasks: [
      taskRow({ task_id: "task-a", room_id: "room-A", telegram_message_thread_id: "613" } as never),
      taskRow({ task_id: "task-b", room_id: "room-B", telegram_message_thread_id: "613" } as never)
    ]
  });
  const deps = buildDepsFromClient(client);
  const result = await deps.fetchTasksForRoom("room-A", "613");
  assert.deepEqual((result.data ?? []).map((t) => t.task_id), ["task-a"]);
});

test("fetchTasksForRoom(room-A) — room-B 작업이 절대 섞이지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchTasksForRoom("room-A");
  assert.equal(result.error, undefined);
  const ids = (result.data ?? []).map((t) => t.task_id).sort();
  assert.deepEqual(ids, ["task-a1", "task-a2"]);
});

test("fetchTasksForRoom(room-B) — room-A 작업이 절대 섞이지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchTasksForRoom("room-B");
  assert.equal(result.error, undefined);
  const ids = (result.data ?? []).map((t) => t.task_id).sort();
  assert.deepEqual(ids, ["task-b1"]);
});

test("존재하지 않는 방을 요청하면 빈 배열 — 다른 방 작업으로 대체되지 않는다", async () => {
  const deps = buildDepsFromClient(seededClient());
  const result = await deps.fetchTasksForRoom("room-does-not-exist");
  assert.deepEqual(result.data, []);
});

function fakeAuthDeps(): Pick<TasksHandlerDeps, "authenticate" | "checkRoomAccess"> {
  return {
    authenticate: async () => ({ ok: true, telegramUserId: "111" }),
    checkRoomAccess: async (roomId) => ({ ok: true, room: { roomId, purpose: "테스트 방" }, viewerRole: "human_member" })
  };
}

function req(url: string): Request {
  return new Request(url, { method: "GET", headers: { authorization: "tma fake" } });
}

// 요청 수준(handler 전체) 격리 증명 — 쿼리 빌더 단위 검증(위 두 테스트)에 더해, 실제
// handleMiniappTasksRequest 를 FakeSupabaseClient 기반 deps 로 호출했을 때 응답 JSON 에
// room-B 항목이 0건인지까지 확인한다.
test("E2E — GET ?roomId=room-A 응답에는 room-A 작업만 있고 room-B 작업은 0건이다", async () => {
  const deps: TasksHandlerDeps = { ...fakeAuthDeps(), ...buildDepsFromClient(seededClient()) };
  const res = await handleMiniappTasksRequest(req("https://x/miniapp-tasks?roomId=room-A"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  const taskIds: string[] = body.tasks.map((t: { taskId: string }) => t.taskId);
  assert.deepEqual(taskIds.sort(), ["task-a1", "task-a2"]);
  assert.equal(taskIds.includes("task-b1"), false);
});

test("E2E — GET ?roomId=room-B 응답에는 room-B 작업만 있고 room-A 작업은 0건이다", async () => {
  const deps: TasksHandlerDeps = { ...fakeAuthDeps(), ...buildDepsFromClient(seededClient()) };
  const res = await handleMiniappTasksRequest(req("https://x/miniapp-tasks?roomId=room-B"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  const taskIds: string[] = body.tasks.map((t: { taskId: string }) => t.taskId);
  assert.deepEqual(taskIds, ["task-b1"]);
  assert.equal(taskIds.includes("task-a1"), false);
  assert.equal(taskIds.includes("task-a2"), false);
});

// 페이지 배포가 늦어 옛 화면을 보고 있는 사용자를 위해, roomId 에 주제가 통째로 실려 와도
// 서버에서 갈라 읽는다. 안 그러면 현황판이 빈 화면이 되고 원인이 화면에 안 보인다.
test("roomId 에 주제가 붙어 와도 방과 주제를 갈라 읽는다", async () => {
  const client = new FakeSupabaseClient({
    huai_tasks: [
      taskRow({ task_id: "task-egg", room_id: "room-A", telegram_message_thread_id: "613" } as never),
      taskRow({ task_id: "task-sys", room_id: "room-A", telegram_message_thread_id: "42" } as never)
    ]
  });
  const response = await handleMiniappTasksRequest(
    req("https://example.test/miniapp-tasks?roomId=room-A__t613"),
    { ...fakeAuthDeps(), ...buildDepsFromClient(client) }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tasks.map((task: { taskId: string }) => task.taskId), ["task-egg"]);
});
