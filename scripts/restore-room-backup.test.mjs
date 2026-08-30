import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWriteOperations,
  fetchExistingKeys,
  formatPreviewLine,
  previewRestore,
  runRestoreRoomBackup,
  RESTORE_STEPS
} from "./restore-room-backup.mjs";

// 결함 회귀 — room-backup.ts/create-room-backup.mjs는 백업(조회·저장)만 하고 복구가
// 저장소 어디에도 없었다(3차 평가 지적). 이 테스트는 실제 Supabase/디스크 없이 가짜
// 인메모리 REST 스토어를 주입해 오케스트레이션(dry-run 미리보기, 멱등 upsert,
// 불완전 스냅샷 거부, 실패 시 부분 진행 보고)만 검증한다.

// ---- 가짜 PostgREST 스토어 ------------------------------------------------
// GET: `/table?room_id=eq.X&select=a,b` 또는 `/table?task_id=in.(a,b)&select=a,b` 만 지원.
// POST: body 배열을 on_conflict 컬럼 기준으로 merge-duplicates(덮어쓰기) 또는
//       ignore-duplicates(이미 있으면 건너뜀)로 반영한다.
function createFakeStore(initialTables = {}) {
  const tables = new Map(Object.entries(initialTables).map(([key, rows]) => [key, [...rows]]));
  const calls = [];

  function parsePath(path) {
    const [tableAndQuery] = path.slice(1).split("?");
    const table = tableAndQuery;
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    return { table, query };
  }

  async function request(method, path, options = {}) {
    calls.push({ method, path, body: options.body, prefer: options.prefer });
    const { table, query } = parsePath(path);
    const rows = tables.get(table) ?? [];

    if (method === "GET") {
      let filtered = rows;
      for (const [key, value] of query.entries()) {
        if (key === "select") continue;
        if (value.startsWith("eq.")) {
          const target = value.slice(3);
          filtered = filtered.filter((row) => String(row[key]) === target);
        } else if (value.startsWith("in.(")) {
          const list = value.slice(4, -1).split(",").map(decodeURIComponent);
          filtered = filtered.filter((row) => list.includes(String(row[key])));
        }
      }
      const selectCols = query.get("select")?.split(",");
      const projected = selectCols ? filtered.map((row) => Object.fromEntries(selectCols.map((col) => [col, row[col]]))) : filtered;
      return fakeResponse(200, projected);
    }

    if (method === "POST") {
      const onConflict = query.get("on_conflict")?.split(",") ?? [];
      const resolution = /resolution=([a-z-]+)/.exec(options.prefer ?? "")?.[1];
      const body = Array.isArray(options.body) ? options.body : [options.body];
      if (!tables.has(table)) tables.set(table, []);
      const store = tables.get(table);

      for (const incoming of body) {
        const key = onConflict.map((col) => String(incoming[col])).join("|");
        const existingIndex = store.findIndex((row) => onConflict.map((col) => String(row[col])).join("|") === key);
        if (existingIndex === -1) {
          store.push({ ...incoming });
        } else if (resolution === "merge-duplicates") {
          store[existingIndex] = { ...store[existingIndex], ...incoming };
        }
        // ignore-duplicates + existingIndex found → 아무 것도 안 한다.
      }
      return fakeResponse(201, null);
    }

    throw new Error(`unsupported-method:${method}`);
  }

  return { request, tables, calls };
}

function fakeResponse(status, jsonBody) {
  return {
    status,
    async expectOk() {
      if (status >= 400) throw new Error(`fake-http-error:${status}`);
    },
    async json() {
      return jsonBody;
    }
  };
}

function buildSnapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    roomId: "room-1",
    capturedAt: "2026-08-30T00:00:00.000Z",
    tasks: [],
    events: [],
    approvals: [],
    artifacts: [],
    roomMembers: [],
    aiActors: [],
    taskProposals: [],
    taskDependencies: [],
    messageBindings: [],
    agentPersonas: [],
    taskReports: [],
    reports: [],
    revisionRequests: [],
    missingTables: [],
    ...overrides
  };
}

function alwaysOkVerify() {
  return async () => ({ ok: true, summary: { missingTables: [] } });
}

function fakeReadFile(snapshot) {
  return async () => JSON.stringify(snapshot);
}

// ---- previewRestore / dry-run ---------------------------------------------

test("previewRestore: 이미 있는 행과 새 행을 테이블별로 구분한다", async () => {
  const store = createFakeStore({
    huai_ai_actors: [{ actor_id: "a1", room_id: "room-1" }]
  });
  const snapshot = buildSnapshot({
    aiActors: [
      { actor_id: "a1", room_id: "room-1" },
      { actor_id: "a2", room_id: "room-1" }
    ]
  });

  const preview = await previewRestore(store.request, snapshot, new Set());
  const actorsEntry = preview.find((entry) => entry.table === "huai_ai_actors");

  assert.equal(actorsEntry.total, 2);
  assert.equal(actorsEntry.existing, 1);
  assert.equal(actorsEntry.new, 1);
});

test("previewRestore: missingTables에 든 테이블은 SKIP으로 표시하고 조회하지 않는다", async () => {
  const store = createFakeStore();
  const snapshot = buildSnapshot();
  const preview = await previewRestore(store.request, snapshot, new Set(["huai_events"]));
  const eventsEntry = preview.find((entry) => entry.table === "huai_events");

  assert.equal(eventsEntry.skipped, true);
  assert.ok(!store.calls.some((call) => call.path.startsWith("/huai_events")));
  assert.match(formatPreviewLine(eventsEntry), /SKIP/);
});

test("previewRestore: task 스코프 테이블은 스냅샷의 task_id로만 조회한다", async () => {
  const store = createFakeStore({
    huai_artifacts: [{ artifact_id: "art-1", task_id: "task-1" }]
  });
  const snapshot = buildSnapshot({
    tasks: [{ task_id: "task-1" }],
    artifacts: [{ artifact_id: "art-1", task_id: "task-1" }]
  });

  const preview = await previewRestore(store.request, snapshot, new Set());
  const artifactsEntry = preview.find((entry) => entry.table === "huai_artifacts");
  assert.equal(artifactsEntry.existing, 1);
  assert.equal(artifactsEntry.new, 0);
});

// ---- 기본값 = dry-run -------------------------------------------------------

test("runRestoreRoomBackup: apply 를 안 주면 아무 것도 쓰지 않는다(POST 없음)", async () => {
  const store = createFakeStore();
  const snapshot = buildSnapshot({ aiActors: [{ actor_id: "a1", room_id: "room-1" }] });

  const result = await runRestoreRoomBackup({
    snapshotPath: "fake.json",
    request: store.request,
    readFile: fakeReadFile(snapshot),
    verify: alwaysOkVerify(),
    log: () => {},
    logError: () => {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.ok(!store.calls.some((call) => call.method === "POST"));
});

// ---- 무결성 게이트 ----------------------------------------------------------

test("runRestoreRoomBackup: 검증에 실패하면 request 를 한 번도 호출하지 않는다", async () => {
  const store = createFakeStore();
  const result = await runRestoreRoomBackup({
    snapshotPath: "fake.json",
    request: store.request,
    readFile: fakeReadFile(buildSnapshot()),
    verify: async () => ({ ok: false, error: "checksum-mismatch:expected=a:actual=b" }),
    log: () => {},
    logError: () => {}
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /verification-failed/);
  assert.equal(store.calls.length, 0);
});

// ---- 불완전 스냅샷 -----------------------------------------------------------

test("runRestoreRoomBackup: 불완전 스냅샷은 --allow-incomplete 없이 apply 를 거부한다", async () => {
  const store = createFakeStore();
  const snapshot = buildSnapshot({ missingTables: [{ table: "huai_events", reason: "supabase-rest-error:500" }] });

  const result = await runRestoreRoomBackup({
    snapshotPath: "fake.json",
    apply: true,
    request: store.request,
    readFile: fakeReadFile(snapshot),
    verify: alwaysOkVerify(),
    log: () => {},
    logError: () => {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "incomplete-snapshot-requires-allow-incomplete");
  assert.ok(!store.calls.some((call) => call.method === "POST"));
});

test("runRestoreRoomBackup: --allow-incomplete 를 주면 있는 테이블만 복원하고 빠진 테이블은 SKIP한다", async () => {
  const store = createFakeStore();
  const snapshot = buildSnapshot({
    aiActors: [{ actor_id: "a1", room_id: "room-1" }],
    missingTables: [{ table: "huai_events", reason: "supabase-rest-error:500" }]
  });

  const result = await runRestoreRoomBackup({
    snapshotPath: "fake.json",
    apply: true,
    allowIncomplete: true,
    request: store.request,
    readFile: fakeReadFile(snapshot),
    verify: alwaysOkVerify(),
    log: () => {},
    logError: () => {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(store.tables.get("huai_ai_actors"), [{ actor_id: "a1", room_id: "room-1" }]);
  assert.ok(!store.calls.some((call) => call.path.startsWith("/huai_events")));
  const skippedEvents = result.results.find((r) => r.table === "huai_events");
  assert.equal(skippedEvents.skipped, true);
});

// ---- 멱등성 -----------------------------------------------------------------

test("runRestoreRoomBackup: 같은 스냅샷을 두 번 apply 해도 행이 중복되지 않는다", async () => {
  const store = createFakeStore();
  const snapshot = buildSnapshot({
    aiActors: [{ actor_id: "a1", room_id: "room-1", role: "leader" }],
    roomMembers: [{ room_id: "room-1", telegram_user_id: 111, role: "owner" }]
  });

  for (let i = 0; i < 2; i += 1) {
    const result = await runRestoreRoomBackup({
      snapshotPath: "fake.json",
      apply: true,
      request: store.request,
      readFile: fakeReadFile(snapshot),
      verify: alwaysOkVerify(),
      log: () => {},
      logError: () => {}
    });
    assert.equal(result.ok, true);
  }

  assert.equal(store.tables.get("huai_ai_actors").length, 1);
  assert.equal(store.tables.get("huai_room_members").length, 1);
});

// ---- huai_tasks ↔ huai_approvals 순환 FK 2-pass ------------------------------

test("buildWriteOperations: huai_tasks 를 두 번(1차 null, 2차 원복) 나눠 쓰고 그 사이에 huai_approvals 를 끼운다", () => {
  const snapshot = buildSnapshot({
    tasks: [{ task_id: "task-1", room_id: "room-1", status: "completed", approved_by_approval_id: "appr-1" }],
    approvals: [{ approval_id: "appr-1", task_id: "task-1", room_id: "room-1" }]
  });

  const ops = buildWriteOperations(snapshot, new Set());
  const taskOpIndexes = ops.map((op, index) => (op.step.table === "huai_tasks" ? index : -1)).filter((i) => i >= 0);
  const approvalOpIndex = ops.findIndex((op) => op.step.table === "huai_approvals");

  assert.equal(taskOpIndexes.length, 2);
  assert.ok(taskOpIndexes[0] < approvalOpIndex, "1차 huai_tasks 는 huai_approvals 보다 먼저");
  assert.ok(approvalOpIndex < taskOpIndexes[1], "huai_approvals 는 2차 huai_tasks 보다 먼저");

  assert.equal(ops[taskOpIndexes[0]].rows[0].approved_by_approval_id, null);
  assert.equal(ops[taskOpIndexes[1]].rows[0].approved_by_approval_id, "appr-1");
});

test("runRestoreRoomBackup: huai_approvals/huai_events 는 ignore-duplicates 로만 쓴다(append-only 트리거 대응)", async () => {
  const store = createFakeStore();
  const snapshot = buildSnapshot({
    tasks: [{ task_id: "task-1", room_id: "room-1", status: "completed", approved_by_approval_id: "appr-1" }],
    approvals: [{ approval_id: "appr-1", task_id: "task-1", room_id: "room-1" }],
    events: [{ event_id: "evt-1", room_id: "room-1", idempotency_key: "k1" }]
  });

  await runRestoreRoomBackup({
    snapshotPath: "fake.json",
    apply: true,
    request: store.request,
    readFile: fakeReadFile(snapshot),
    verify: alwaysOkVerify(),
    log: () => {},
    logError: () => {}
  });

  const approvalsCall = store.calls.find((call) => call.path.startsWith("/huai_approvals"));
  const eventsCall = store.calls.find((call) => call.path.startsWith("/huai_events"));
  assert.match(approvalsCall.prefer, /ignore-duplicates/);
  assert.match(eventsCall.prefer, /ignore-duplicates/);
});

// ---- 부분 실패 보고 ----------------------------------------------------------

test("runRestoreRoomBackup: 한 테이블이 실패해도 나머지는 계속 진행하고 어디까지 됐는지 보고한다", async () => {
  const failingRequest = async (method, path, options) => {
    if (method === "POST" && path.startsWith("/huai_ai_actors")) {
      throw new Error("supabase-rest-error:500:boom");
    }
    return store.request(method, path, options);
  };
  const store = createFakeStore();

  const snapshot = buildSnapshot({
    aiActors: [{ actor_id: "a1", room_id: "room-1" }],
    roomMembers: [{ room_id: "room-1", telegram_user_id: 111, role: "owner" }]
  });

  const result = await runRestoreRoomBackup({
    snapshotPath: "fake.json",
    apply: true,
    request: failingRequest,
    readFile: fakeReadFile(snapshot),
    verify: alwaysOkVerify(),
    log: () => {},
    logError: () => {}
  });

  assert.equal(result.ok, false);
  const actorsResult = result.results.find((r) => r.table === "huai_ai_actors");
  const membersResult = result.results.find((r) => r.table === "huai_room_members");
  assert.equal(actorsResult.ok, false);
  assert.match(actorsResult.reason, /boom/);
  assert.equal(membersResult.ok, true, "다른 테이블은 실패와 무관하게 계속 진행돼야 한다");
});

test("fetchExistingKeys: 복합 PK(room_id, telegram_user_id) 를 올바르게 조합한다", async () => {
  const store = createFakeStore({
    huai_room_members: [{ room_id: "room-1", telegram_user_id: 111 }]
  });
  const step = RESTORE_STEPS.find((entry) => entry.table === "huai_room_members");
  const keys = await fetchExistingKeys(store.request, step, "room-1", []);
  assert.ok(keys.has("room-1|111"));
});
