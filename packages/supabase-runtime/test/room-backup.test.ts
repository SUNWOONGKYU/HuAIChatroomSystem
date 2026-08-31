import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_ROOM_BACKUP_TABLES,
  buildRoomBackupSnapshot,
  filesToPrune,
  maxSnapshotsPerRoomFromEnv,
  pruneRoomBackupSnapshotRows,
  pruneRoomBackupSnapshots,
  sha256Hex,
  recordRoomBackupSnapshot,
  recoverySnapshotRowsToPrune,
  serializeRoomBackupSnapshot,
  writeRoomBackupSnapshotToDisk,
  type RoomBackupRestRequest,
  type RoomBackupSnapshot
} from "../src/room-backup.js";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID_1 = "22222222-2222-4222-8222-222222222222";
const TASK_ID_2 = "33333333-3333-4333-8333-333333333333";

// room_id 로 직접 스코프되는 10개 테이블. 응답은 테스트마다 달라서 여기선 목록만 둔다.
const ROOM_SCOPED_PATHS = [
  "/huai_tasks?",
  "/huai_events?",
  "/huai_approvals?",
  "/huai_room_members?",
  "/huai_ai_actors?",
  "/huai_task_proposals?",
  "/huai_task_dependencies?",
  "/huai_message_bindings?",
  "/huai_agent_personas?",
  "/huai_task_reports?"
];
const TASK_SCOPED_PATHS = ["/huai_artifacts?", "/huai_reports?", "/huai_revision_requests?"];

test("buildRoomBackupSnapshot queries every room-scoped and task-scoped table with the right filters", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request = fakeRequestReturningEmptyExcept(calls, {
    "/huai_tasks?": [{ task_id: TASK_ID_1 }, { task_id: TASK_ID_2 }],
    "/huai_events?": [{ event_id: "e1" }],
    "/huai_approvals?": [{ approval_id: "a1" }],
    "/huai_artifacts?": [{ artifact_id: "art1" }],
    "/huai_room_members?": [{ telegram_user_id: "u1" }],
    "/huai_ai_actors?": [{ actor_id: "actor1" }],
    "/huai_task_proposals?": [{ proposal_id: "p1" }],
    "/huai_task_dependencies?": [{ dependency_id: "d1" }],
    "/huai_message_bindings?": [{ binding_id: "b1" }],
    "/huai_agent_personas?": [{ persona_id: "persona1" }],
    "/huai_task_reports?": [{ report_id: "tr1" }],
    "/huai_reports?": [{ report_id: "r1" }],
    "/huai_revision_requests?": [{ revision_request_id: "rr1" }]
  });

  const snapshot = await buildRoomBackupSnapshot(
    { request, now: () => new Date("2026-08-29T00:00:00.000Z") },
    ROOM_ID
  );

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.roomId, ROOM_ID);
  assert.equal(snapshot.capturedAt, "2026-08-29T00:00:00.000Z");
  assert.deepEqual(snapshot.missingTables, []);

  assert.deepEqual(snapshot.tasks, [{ task_id: TASK_ID_1 }, { task_id: TASK_ID_2 }]);
  assert.deepEqual(snapshot.events, [{ event_id: "e1" }]);
  assert.deepEqual(snapshot.approvals, [{ approval_id: "a1" }]);
  assert.deepEqual(snapshot.artifacts, [{ artifact_id: "art1" }]);
  assert.deepEqual(snapshot.roomMembers, [{ telegram_user_id: "u1" }]);
  assert.deepEqual(snapshot.aiActors, [{ actor_id: "actor1" }]);
  assert.deepEqual(snapshot.taskProposals, [{ proposal_id: "p1" }]);
  assert.deepEqual(snapshot.taskDependencies, [{ dependency_id: "d1" }]);
  assert.deepEqual(snapshot.messageBindings, [{ binding_id: "b1" }]);
  assert.deepEqual(snapshot.agentPersonas, [{ persona_id: "persona1" }]);
  assert.deepEqual(snapshot.taskReports, [{ report_id: "tr1" }]);
  assert.deepEqual(snapshot.reports, [{ report_id: "r1" }]);
  assert.deepEqual(snapshot.revisionRequests, [{ revision_request_id: "rr1" }]);

  for (const prefix of ROOM_SCOPED_PATHS) {
    const call = calls.find((entry) => entry.path.startsWith(prefix));
    assert.ok(call, `expected a call for ${prefix}`);
    assert.equal(call?.path, `${prefix}room_id=eq.${ROOM_ID}&select=*&order=created_at.asc`);
  }

  for (const prefix of TASK_SCOPED_PATHS) {
    const call = calls.find((entry) => entry.path.startsWith(prefix));
    assert.ok(call, `expected a call for ${prefix}`);
    assert.equal(call?.path, `${prefix}task_id=in.(${TASK_ID_1},${TASK_ID_2})&select=*&order=created_at.asc`);
  }
});

test("buildRoomBackupSnapshot skips task-scoped queries when the room has zero tasks", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request = fakeRequestReturningEmptyExcept(calls, {});

  const snapshot = await buildRoomBackupSnapshot({ request, now: () => new Date("2026-08-29T00:00:00.000Z") }, ROOM_ID);

  assert.deepEqual(snapshot.artifacts, []);
  assert.deepEqual(snapshot.reports, []);
  assert.deepEqual(snapshot.revisionRequests, []);
  assert.deepEqual(snapshot.missingTables, []);
  for (const prefix of TASK_SCOPED_PATHS) {
    assert.equal(calls.some((call) => call.path.startsWith(prefix)), false, `did not expect a call for ${prefix}`);
  }
});

test("buildRoomBackupSnapshot tolerates a single table's failure and records it in missingTables", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    calls.push({ method, path });
    if (path.startsWith("/huai_message_bindings?")) {
      throw new Error("supabase-rest-error:500:internal");
    }
    return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
  };

  const snapshot = await buildRoomBackupSnapshot({ request, now: () => new Date("2026-08-29T00:00:00.000Z") }, ROOM_ID);

  assert.deepEqual(snapshot.messageBindings, []);
  assert.equal(snapshot.missingTables.length, 1);
  assert.equal(snapshot.missingTables[0]?.table, "huai_message_bindings");
  assert.match(snapshot.missingTables[0]?.reason ?? "", /supabase-rest-error/);
  // 다른 테이블들은 정상 조회됐다 — 한 테이블의 실패가 나머지를 막지 않는다.
  assert.deepEqual(snapshot.tasks, []);
  assert.deepEqual(snapshot.approvals, []);
});

test("buildRoomBackupSnapshot marks task-scoped tables as missing (not empty) when huai_tasks itself fails", async () => {
  const request: RoomBackupRestRequest = async (method, path) => {
    if (path.startsWith("/huai_tasks?")) throw new Error("network-down");
    return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
  };

  const snapshot = await buildRoomBackupSnapshot({ request, now: () => new Date("2026-08-29T00:00:00.000Z") }, ROOM_ID);

  const missingTableNames = snapshot.missingTables.map((entry) => entry.table).sort();
  assert.deepEqual(missingTableNames, ["huai_artifacts", "huai_reports", "huai_revision_requests", "huai_tasks"].sort());
  const dependentEntry = snapshot.missingTables.find((entry) => entry.table === "huai_artifacts");
  assert.match(dependentEntry?.reason ?? "", /dependent-on-huai_tasks-which-failed/);
});

test("ALL_ROOM_BACKUP_TABLES lists every table this snapshot covers", () => {
  assert.equal(ALL_ROOM_BACKUP_TABLES.length, 13);
  assert.ok(ALL_ROOM_BACKUP_TABLES.includes("huai_tasks"));
  assert.ok(ALL_ROOM_BACKUP_TABLES.includes("huai_revision_requests"));
});

test("serializeRoomBackupSnapshot is deterministic: same snapshot in, same checksum out", () => {
  const snapshot = fullEmptySnapshot();

  const first = serializeRoomBackupSnapshot(snapshot);
  const second = serializeRoomBackupSnapshot(structuredClone(snapshot));

  assert.equal(first.checksum, second.checksum);
  assert.equal(first.content, second.content);
  assert.match(first.checksum, /^[0-9a-f]{64}$/);
});

test("writeRoomBackupSnapshotToDisk writes the serialized content unchanged under <rootDir>/<roomId>/<capturedAt>.json", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const dirsCreated: string[] = [];

  const snapshot: RoomBackupSnapshot = { ...fullEmptySnapshot(), capturedAt: "2026-08-29T01:02:03.456Z" };
  const content = JSON.stringify(snapshot);

  const { storageUri } = await writeRoomBackupSnapshotToDisk({
    snapshot,
    content,
    rootDir: "fake-root",
    mkdir: async (path) => {
      dirsCreated.push(path);
    },
    writeFile: async (path, writtenContent) => {
      writes.push({ path, content: writtenContent });
    }
  });

  assert.equal(dirsCreated.length, 1);
  assert.match(dirsCreated[0], /fake-root[\\/]11111111-1111-4111-8111-111111111111$/);
  // 스냅샷 본문 + 체크섬 사이드카, 2개를 쓴다.
  assert.equal(writes.length, 2);
  assert.equal(writes[0].content, content);
  assert.match(writes[0].path, /2026-08-29T01-02-03-456Z\.json$/);
  assert.equal(storageUri, writes[0].path);
  assert.equal(writes[1].path, `${writes[0].path}.sha256`);
  assert.equal(writes[1].content, sha256Hex(content));
});

test("recordRoomBackupSnapshot posts a huai_recovery_snapshots row matching the table columns", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const request: RoomBackupRestRequest = async (method, path, options) => {
    calls.push({ method, path, body: options?.body });
    if (method === "GET") {
      return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    }
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const result = await recordRoomBackupSnapshot(
    {
      request,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      mkdir: async () => undefined,
      writeFile: async () => undefined
    },
    ROOM_ID,
    { createdBy: "operator-test" }
  );

  assert.equal(result.ok, true);
  const insert = calls.find((call) => call.method === "POST" && call.path === "/huai_recovery_snapshots");
  assert.ok(insert, "expected a POST to /huai_recovery_snapshots");
  assert.deepEqual(insert!.body, {
    room_id: ROOM_ID,
    task_id: null,
    snapshot_type: "room",
    storage_uri: result.ok ? result.snapshotStorageUri : undefined,
    checksum: result.ok ? result.checksum : undefined,
    created_by: "operator-test"
  });
});

test("recordRoomBackupSnapshot treats a 409 duplicate insert as success", async () => {
  const request: RoomBackupRestRequest = async (method) => {
    if (method === "GET") {
      return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    }
    return {
      status: 409,
      async expectOk() {
        throw new Error("should not be called for 409");
      },
      async json<T>() {
        return undefined as T;
      }
    };
  };

  const result = await recordRoomBackupSnapshot(
    { request, mkdir: async () => undefined, writeFile: async () => undefined },
    ROOM_ID
  );

  assert.equal(result.ok, true);
});

test("recordRoomBackupSnapshot returns { ok: false } instead of throwing when every table is unreachable", async () => {
  const request: RoomBackupRestRequest = async () => {
    throw new Error("network-down");
  };

  const result = await recordRoomBackupSnapshot(
    { request, mkdir: async () => undefined, writeFile: async () => undefined },
    ROOM_ID
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /network-down/);
});

test("recordRoomBackupSnapshot still writes a partial backup when only some tables fail", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    if (method === "GET" && path.startsWith("/huai_agent_personas?")) throw new Error("temporary-outage");
    if (method === "GET") return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const result = await recordRoomBackupSnapshot(
    {
      request,
      mkdir: async () => undefined,
      writeFile: async (path, content) => {
        writes.push({ path, content });
      }
    },
    ROOM_ID
  );

  assert.equal(result.ok, true);
  // 본문 + 사이드카.
  assert.equal(writes.length, 2);
  const written = JSON.parse(writes[0].content) as RoomBackupSnapshot;
  assert.equal(written.missingTables.length, 1);
  assert.equal(written.missingTables[0]?.table, "huai_agent_personas");
});

// 결함(3차 감사) 대응 — room-backup-scheduler.ts 가 6시간마다 스냅샷을 쓰기만 하고
// 지우는 로직이 없어 sessions/rooms/recovery/<방>/ 아래 파일이 무한히 쌓였다
// (1년이면 방당 1,460개). filesToPrune 는 그 판단을 담당하는 순수 함수다.

test("filesToPrune: 상한 이하면 아무 것도 지우지 않는다", () => {
  const files = ["2026-08-01T00-00-00-000Z.json", "2026-08-02T00-00-00-000Z.json"];
  assert.deepEqual(filesToPrune(files, 5), []);
});

test("filesToPrune: 상한을 넘으면 사전순(=시간순)으로 가장 오래된 것부터 지운다", () => {
  const files = [
    "2026-08-03T00-00-00-000Z.json",
    "2026-08-01T00-00-00-000Z.json",
    "2026-08-02T00-00-00-000Z.json"
  ];
  assert.deepEqual(filesToPrune(files, 1), [
    "2026-08-01T00-00-00-000Z.json",
    "2026-08-02T00-00-00-000Z.json"
  ]);
});

test("filesToPrune: .json 이 아닌 파일(디렉터리 등)은 대상에서 제외한다", () => {
  const files = ["2026-08-01T00-00-00-000Z.json", ".gitkeep"];
  assert.deepEqual(filesToPrune(files, 0), ["2026-08-01T00-00-00-000Z.json"]);
});

test("maxSnapshotsPerRoomFromEnv: 값이 없거나 잘못돼도 기본값(240)으로 조용히 떨어진다", () => {
  assert.equal(maxSnapshotsPerRoomFromEnv({}), 240);
  assert.equal(maxSnapshotsPerRoomFromEnv({ HUAI_ROOM_BACKUP_MAX_SNAPSHOTS: "not-a-number" }), 240);
  assert.equal(maxSnapshotsPerRoomFromEnv({ HUAI_ROOM_BACKUP_MAX_SNAPSHOTS: "-5" }), 240);
  assert.equal(maxSnapshotsPerRoomFromEnv({ HUAI_ROOM_BACKUP_MAX_SNAPSHOTS: "10" }), 10);
});

test("pruneRoomBackupSnapshots: 상한을 넘는 오래된 파일을 실제로 지우고 지운 이름을 돌려준다", async () => {
  const unlinked: string[] = [];
  const deleted = await pruneRoomBackupSnapshots("some/dir", 1, {
    readdir: async (path) => {
      assert.equal(path, "some/dir");
      return ["2026-08-02T00-00-00-000Z.json", "2026-08-01T00-00-00-000Z.json"];
    },
    unlink: async (path) => {
      unlinked.push(path);
    }
  });

  assert.deepEqual(deleted, ["2026-08-01T00-00-00-000Z.json"]);
  // 스냅샷과 짝인 체크섬 사이드카까지 지우므로 unlink 는 2회다.
  assert.equal(unlinked.length, 2);
  assert.match(unlinked[0]!, /2026-08-01T00-00-00-000Z\.json$/);
  assert.match(unlinked[1]!, /2026-08-01T00-00-00-000Z\.json\.sha256$/);
});

test("pruneRoomBackupSnapshots: 디렉터리가 아직 없어도(첫 백업) 예외를 던지지 않는다", async () => {
  const deleted = await pruneRoomBackupSnapshots("no/such/dir", 10, {
    readdir: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });
  assert.deepEqual(deleted, []);
});

test("pruneRoomBackupSnapshots: 개별 파일 삭제 실패가 나머지 삭제를 막지 않는다", async () => {
  const attempted: string[] = [];
  const deleted = await pruneRoomBackupSnapshots("some/dir", 0, {
    readdir: async () => ["a.json", "b.json"],
    unlink: async (path) => {
      attempted.push(path);
      if (path.endsWith("a.json")) throw new Error("permission-denied");
    }
  });

  // 스냅샷 2개 × (본문 + 사이드카) = 4회 시도.
  assert.equal(attempted.length, 4, "둘 다 시도는 됐어야 한다(각각 본문 + 사이드카)");
  assert.deepEqual(
    attempted.map((path) => path.split("\\").join("/")),
    ["some/dir/a.json", "some/dir/a.json.sha256", "some/dir/b.json", "some/dir/b.json.sha256"]
  );
  assert.deepEqual(deleted, ["b.json"], "실패한 a.json 은 결과에서 빠지지만 예외로 전체가 죽지는 않는다");
});

test("recordRoomBackupSnapshot: 새 스냅샷을 쓴 뒤 같은 방 디렉터리에서 상한 초과분을 정리한다", async () => {
  const request: RoomBackupRestRequest = async (method) => {
    if (method === "GET") return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  let readdirCalledWith: string | undefined;
  const unlinked: string[] = [];

  const result = await recordRoomBackupSnapshot(
    {
      request,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      maxSnapshotsPerRoom: 1,
      readdir: async (path) => {
        readdirCalledWith = path;
        return ["2026-08-01T00-00-00-000Z.json", "2026-08-02T00-00-00-000Z.json"];
      },
      unlink: async (path) => {
        unlinked.push(path);
      }
    },
    ROOM_ID
  );

  assert.equal(result.ok, true);
  assert.ok(readdirCalledWith?.includes(ROOM_ID), "방 전용 디렉터리를 조회해야 한다");
  // 스냅샷 + 사이드카.
  assert.equal(unlinked.length, 2);
  assert.match(unlinked[0]!, /2026-08-01T00-00-00-000Z\.json$/);
  assert.match(unlinked[1]!, /2026-08-01T00-00-00-000Z\.json\.sha256$/);
});

test("recordRoomBackupSnapshot: 정리(readdir) 실패는 백업 자체의 성공 결과에 영향을 주지 않는다", async () => {
  const request: RoomBackupRestRequest = async (method) => {
    if (method === "GET") return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const result = await recordRoomBackupSnapshot(
    {
      request,
      mkdir: async () => undefined,
      writeFile: async () => undefined,
      readdir: async () => {
        throw new Error("disk-unreadable");
      }
    },
    ROOM_ID
  );

  assert.equal(result.ok, true, "정리 실패가 백업 성공 여부를 뒤집으면 안 된다");
});

// 결함(4차 감사) 대응 — 파일은 방당 240개로 정리되는데 huai_recovery_snapshots 의
// 장부 행은 아무도 지우지 않아 무한히 쌓였다. recoverySnapshotRowsToPrune 는 그
// 판단을 담당하는 순수 함수다(filesToPrune 과 같은 원칙, 대상이 created_at 문자열).

test("recoverySnapshotRowsToPrune: 상한 이하면 아무 것도 지우지 않는다", () => {
  const rows = [
    { snapshot_id: "s1", created_at: "2026-08-01T00:00:00.000Z" },
    { snapshot_id: "s2", created_at: "2026-08-02T00:00:00.000Z" }
  ];
  assert.deepEqual(recoverySnapshotRowsToPrune(rows, 5), []);
});

test("recoverySnapshotRowsToPrune: 상한을 넘으면 created_at 이 오래된 것부터 지운다", () => {
  const rows = [
    { snapshot_id: "s3", created_at: "2026-08-03T00:00:00.000Z" },
    { snapshot_id: "s1", created_at: "2026-08-01T00:00:00.000Z" },
    { snapshot_id: "s2", created_at: "2026-08-02T00:00:00.000Z" }
  ];
  assert.deepEqual(recoverySnapshotRowsToPrune(rows, 1), ["s1", "s2"]);
});

test("pruneRoomBackupSnapshotRows: 상한 초과분을 GET 후 DELETE 로 실제로 지운다", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    calls.push({ method, path });
    if (method === "GET") {
      return {
        status: 200,
        async expectOk() {},
        async json<T>() {
          return [
            { snapshot_id: "s2", created_at: "2026-08-02T00:00:00.000Z" },
            { snapshot_id: "s1", created_at: "2026-08-01T00:00:00.000Z" }
          ] as unknown as T;
        }
      };
    }
    return { status: 200, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const deleted = await pruneRoomBackupSnapshotRows({ request }, ROOM_ID, 1);

  assert.deepEqual(deleted, ["s1"]);
  const getCall = calls.find((call) => call.method === "GET");
  assert.equal(
    getCall?.path,
    `/huai_recovery_snapshots?room_id=eq.${ROOM_ID}&snapshot_type=eq.room&select=snapshot_id,created_at`
  );
  const deleteCall = calls.find((call) => call.method === "DELETE");
  assert.equal(deleteCall?.path, "/huai_recovery_snapshots?snapshot_id=in.(s1)");
});

// 결함(6차 감사) 대응 — snapshotType 이 'room' 고정이라 'artifact' 행을 지우는
// 경로가 코드 전체에 없어 무한 누적됐다(6차 평가관 발견). snapshotType 매개변수화
// 뒤, 실제로 쿼리의 snapshot_type 조건이 바뀌는지 확인한다.
test("pruneRoomBackupSnapshotRows: snapshotType 을 넘기면 그 타입만 조회·정리한다", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    calls.push({ method, path });
    if (method === "GET") {
      return {
        status: 200,
        async expectOk() {},
        async json<T>() {
          return [
            { snapshot_id: "a2", created_at: "2026-08-02T00:00:00.000Z" },
            { snapshot_id: "a1", created_at: "2026-08-01T00:00:00.000Z" }
          ] as unknown as T;
        }
      };
    }
    return { status: 200, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const deleted = await pruneRoomBackupSnapshotRows({ request }, ROOM_ID, 1, "artifact");

  assert.deepEqual(deleted, ["a1"]);
  const getCall = calls.find((call) => call.method === "GET");
  assert.equal(
    getCall?.path,
    `/huai_recovery_snapshots?room_id=eq.${ROOM_ID}&snapshot_type=eq.artifact&select=snapshot_id,created_at`
  );
});

test("pruneRoomBackupSnapshotRows: snapshotType 을 안 넘기면 여전히 'room' 이 기본값이다(기존 호출부 하위호환)", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    calls.push({ method, path });
    return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
  };

  await pruneRoomBackupSnapshotRows({ request }, ROOM_ID, 240);

  const getCall = calls.find((call) => call.method === "GET");
  assert.match(getCall?.path ?? "", /snapshot_type=eq\.room\b/);
});

test("pruneRoomBackupSnapshotRows: 지울 게 없으면 DELETE 를 호출하지 않는다", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    calls.push({ method, path });
    return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
  };

  const deleted = await pruneRoomBackupSnapshotRows({ request }, ROOM_ID, 240);

  assert.deepEqual(deleted, []);
  assert.equal(calls.some((call) => call.method === "DELETE"), false);
});

test("pruneRoomBackupSnapshotRows: 조회/삭제 실패는 예외를 던지지 않고 빈 배열을 돌려준다", async () => {
  const request: RoomBackupRestRequest = async () => {
    throw new Error("network-down");
  };

  const deleted = await pruneRoomBackupSnapshotRows({ request }, ROOM_ID, 1);
  assert.deepEqual(deleted, []);
});

test("recordRoomBackupSnapshot: 새 장부 행을 쓴 뒤 같은 방의 상한 초과 장부 행을 정리한다", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: RoomBackupRestRequest = async (method, path) => {
    calls.push({ method, path });
    if (method === "GET" && path.startsWith("/huai_recovery_snapshots")) {
      return {
        status: 200,
        async expectOk() {},
        async json<T>() {
          return [
            { snapshot_id: "old1", created_at: "2026-08-01T00:00:00.000Z" },
            { snapshot_id: "old2", created_at: "2026-08-02T00:00:00.000Z" }
          ] as unknown as T;
        }
      };
    }
    if (method === "GET") return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const result = await recordRoomBackupSnapshot(
    { request, mkdir: async () => undefined, writeFile: async () => undefined, maxSnapshotsPerRoom: 1 },
    ROOM_ID
  );

  assert.equal(result.ok, true);
  const deleteCall = calls.find((call) => call.method === "DELETE" && call.path.startsWith("/huai_recovery_snapshots"));
  assert.ok(deleteCall, "장부 행 정리 DELETE 가 호출됐어야 한다");
  // 가짜 request 는 GET 을 호출 시점과 무관하게 항상 old1(2026-08-01)/old2(2026-08-02)
  // 두 행을 돌려준다(새로 POST 한 행은 이 인메모리 목록에 반영되지 않는다). 상한이 1이므로
  // 그 중 더 오래된 old1 만 초과분으로 지워진다.
  assert.match(deleteCall!.path, /snapshot_id=in\.\(old1\)/);
});

test("recordRoomBackupSnapshot: 장부 행 정리 실패는 백업 자체의 성공 결과에 영향을 주지 않는다", async () => {
  const request: RoomBackupRestRequest = async (method, path) => {
    if (method === "GET" && path.startsWith("/huai_recovery_snapshots")) {
      throw new Error("list-failed");
    }
    if (method === "GET") return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const result = await recordRoomBackupSnapshot(
    { request, mkdir: async () => undefined, writeFile: async () => undefined },
    ROOM_ID
  );

  assert.equal(result.ok, true, "장부 정리 실패가 백업 성공 여부를 뒤집으면 안 된다");
});

function fullEmptySnapshot(): RoomBackupSnapshot {
  return {
    schemaVersion: 2,
    roomId: ROOM_ID,
    capturedAt: "2026-08-29T00:00:00.000Z",
    tasks: [{ task_id: TASK_ID_1 }],
    events: [],
    artifacts: [],
    approvals: [],
    roomMembers: [],
    aiActors: [],
    taskProposals: [],
    taskDependencies: [],
    messageBindings: [],
    agentPersonas: [],
    taskReports: [],
    reports: [],
    revisionRequests: [],
    missingTables: []
  };
}

function fakeRequestReturningEmptyExcept(
  calls: Array<{ method: string; path: string }>,
  responsesByPrefix: Record<string, unknown[]>
): RoomBackupRestRequest {
  return async (method, path) => {
    calls.push({ method, path });
    const prefix = Object.keys(responsesByPrefix).find((candidate) => path.startsWith(candidate));
    const body = prefix ? responsesByPrefix[prefix] : [];
    return {
      status: 200,
      async expectOk() {},
      async json<T>(): Promise<T> {
        return body as T;
      }
    };
  };
}

// 체크섬 사이드카 — 라이브 복구 검증에서 발견한 결함 대응.
// 체크섬이 DB(huai_recovery_snapshots.checksum)에만 있으면, 정작 복구가 필요한
// 상황(DB 손상·접근 불가)에서 restore-room-backup.mjs 가 요구하는 체크섬을 못 꺼낸다.
test("writeRoomBackupSnapshotToDisk 는 스냅샷 옆에 .sha256 사이드카를 함께 쓴다", async () => {
  const written = new Map<string, string>();
  const snapshot = { schemaVersion: 2, roomId: "room-1", capturedAt: "2026-08-31T00:00:00.000Z" } as never;
  const content = JSON.stringify({ hello: "world" });

  const result = await writeRoomBackupSnapshotToDisk({
    snapshot,
    content,
    rootDir: "fake-root",
    mkdir: async () => undefined,
    writeFile: async (path, body) => { written.set(path, body); }
  });

  const sidecarPath = `${result.storageUri}.sha256`;
  assert.equal(written.has(result.storageUri), true, "스냅샷 본문이 쓰여야 한다");
  assert.equal(written.has(sidecarPath), true, "사이드카가 함께 쓰여야 한다");
  // 사이드카 값은 serializeRoomBackupSnapshot 이 DB 에 넣는 체크섬과 같은 방식이어야 한다.
  assert.equal(written.get(sidecarPath), sha256Hex(content));
});

test("정리할 때 스냅샷과 사이드카를 짝지어 지운다", async () => {
  // filesToPrune 는 .json 만 세므로 사이드카는 정리 대상에 안 들어온다 —
  // 짝을 맞춰 지우지 않으면 .sha256 만 남아 무한히 쌓인다.
  const unlinked: string[] = [];
  const deleted = await pruneRoomBackupSnapshots("dir", 1, {
    readdir: async () => ["a.json", "a.json.sha256", "b.json", "b.json.sha256"],
    unlink: async (path) => { unlinked.push(path.split("\\").join("/")); }
  });

  assert.deepEqual(deleted, ["a.json"]);
  assert.equal(unlinked.includes("dir/a.json"), true);
  assert.equal(unlinked.includes("dir/a.json.sha256"), true, "사이드카도 같이 지워야 한다");
  assert.equal(unlinked.includes("dir/b.json"), false, "상한 안쪽 스냅샷은 남아야 한다");
});
