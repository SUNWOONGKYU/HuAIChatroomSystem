import assert from "node:assert/strict";
import test from "node:test";
import { listAllRoomIds, runCreateRoomBackup } from "./create-room-backup.mjs";

// 결함 회귀 — room-backup.ts 는 조회/직렬화/저장 로직을 갖추고도 어떤 실행 경로에도
// 연결돼 있지 않아 실제로는 한 방도 백업되지 않았다(2차 평가 공통 지적). 이 스크립트가
// 운영자가 직접 돌리는 수동 창구다. 여기서는 실제 Supabase/디스크 없이 가짜 함수를
// 주입해 오케스트레이션(여러 방 순회, dry-run 분기, 성공/실패 집계)만 검증한다.

test("dry-run 은 아무것도 기록하지 않고 각 방의 미리보기만 로그로 남긴다", async () => {
  const logs = [];
  const built = [];

  const result = await runCreateRoomBackup({
    roomIds: ["room-1", "room-2"],
    dryRun: true,
    request: async () => {
      throw new Error("dry-run 은 request 를 직접 쓰지 않고 buildSnapshot 을 통해서만 써야 한다");
    },
    buildSnapshot: async (_deps, roomId) => {
      built.push(roomId);
      return {
        roomId,
        tasks: [{}],
        events: [],
        artifacts: [],
        approvals: [],
        missingTables: []
      };
    },
    serialize: () => ({ checksum: "fake-checksum" }),
    recordSnapshot: async () => {
      throw new Error("dry-run 은 recordSnapshot 을 호출하면 안 된다 — 아무 것도 쓰지 않아야 한다");
    },
    log: (line) => logs.push(line)
  });

  assert.deepEqual(built, ["room-1", "room-2"]);
  assert.equal(result.total, 2);
  assert.ok(logs.some((line) => line.includes("dry-run")));
  assert.ok(logs.some((line) => line.includes("room=room-1")));
  assert.ok(logs.some((line) => line.includes("room=room-2")));
  assert.ok(logs.some((line) => line.includes("fake-checksum")));
});

test("실제 실행은 방마다 recordSnapshot 을 호출하고 성공/실패를 집계한다", async () => {
  const logs = [];
  const errors = [];
  const recordedRooms = [];

  const result = await runCreateRoomBackup({
    roomIds: ["room-ok", "room-fail"],
    dryRun: false,
    request: async () => ({ status: 200, async expectOk() {}, async json() { return []; } }),
    recordSnapshot: async (_deps, roomId) => {
      recordedRooms.push(roomId);
      if (roomId === "room-fail") return { ok: false, reason: "network-down" };
      return { ok: true, snapshotStorageUri: "sessions/rooms/recovery/room-ok/x.json", checksum: "abc" };
    },
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line)
  });

  assert.deepEqual(recordedRooms, ["room-ok", "room-fail"]);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.total, 2);
  assert.ok(logs.some((line) => line.includes("OK room=room-ok")));
  assert.ok(errors.some((line) => line.includes("FAIL room=room-fail") && line.includes("network-down")));
  assert.ok(logs.some((line) => line.includes("성공 1건, 실패 1건")));
});

test("빈 방 목록이면 아무 것도 호출하지 않고 0건으로 끝난다", async () => {
  let calls = 0;
  const result = await runCreateRoomBackup({
    roomIds: [],
    dryRun: false,
    request: async () => ({ status: 200, async expectOk() {}, async json() { return []; } }),
    recordSnapshot: async () => {
      calls += 1;
      return { ok: true, snapshotStorageUri: "x", checksum: "y" };
    },
    log: () => {}
  });

  assert.equal(calls, 0);
  assert.equal(result.total, 0);
});

// listAllRoomIds 는 huai_rooms 를 REST 로 조회한다 — fetch 를 흉내내어 URL/헤더/응답
// 파싱만 확인한다(실제 네트워크 호출 없음).
test("listAllRoomIds는 huai_rooms 를 조회해 room_id 배열로 변환한다", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return [{ room_id: "r1" }, { room_id: "r2" }];
      }
    };
  };

  try {
    const roomIds = await listAllRoomIds("https://example.supabase.co/", "service-role-key");
    assert.deepEqual(roomIds, ["r1", "r2"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/huai_rooms?select=room_id");
    assert.equal(calls[0].options.headers.apikey, "service-role-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listAllRoomIds는 실패 응답을 명확한 에러로 던진다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      return "internal error";
    }
  });

  try {
    await assert.rejects(() => listAllRoomIds("https://example.supabase.co", "key"), /list-rooms-failed:500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
