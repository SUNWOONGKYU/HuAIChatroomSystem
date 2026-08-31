import assert from "node:assert/strict";
import test from "node:test";
import {
  listRoomIdsFromSupabase,
  runRoomBackupOnce,
  startRoomBackupLoop,
  type RoomBackupSchedulerPorts
} from "../src/room-backup-scheduler.js";
import type { RoomBackupRestRequest } from "../../../packages/supabase-runtime/src/room-backup.js";

// 결함 회귀 — room-backup.ts(packages/supabase-runtime)는 조회/직렬화/저장 로직을
// 갖추고도 어떤 실행·스케줄 경로에도 연결돼 있지 않아, 실제로는 한 방도 백업되지
// 않았다(2차 독립 평가 3명 공통 지적). bot-service 가 이걸 주기 실행으로 연결했는지
// 검증한다.

const emptyRequest: RoomBackupRestRequest = async (method) => {
  if (method === "GET") {
    return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
  }
  return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
};

// 실제로 recordRoomBackupSnapshot 까지 도는 테스트는 디스크에 아무 것도 쓰면 안 된다
// (진짜 파일시스템 접근 없이 오케스트레이션만 검증한다) — mkdir/writeFile 을 가짜로
// 갈아끼운다.
const noopFsPorts = { mkdir: async () => undefined, writeFile: async () => undefined };

test("방마다 recordRoomBackupSnapshot 을 호출하고 결과를 onRoomResult 로 보고한다", async () => {
  const results: Array<{ roomId: string; ok: boolean }> = [];
  const ports: RoomBackupSchedulerPorts = {
    async listRoomIds() {
      return ["room-1", "room-2"];
    },
    request: emptyRequest,
    ...noopFsPorts,
    onRoomResult(roomId, result) {
      results.push({ roomId, ok: result.ok });
    }
  };

  await runRoomBackupOnce(ports);

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.roomId), ["room-1", "room-2"]);
  assert.ok(results.every((r) => r.ok), "빈 테이블 응답이면 백업은 성공해야 한다");
});

test("방 목록 조회 자체가 던져도 bot-service 를 죽이지 않고 onError 로 넘긴다", async () => {
  const errors: unknown[] = [];
  const ports: RoomBackupSchedulerPorts = {
    async listRoomIds() {
      throw new Error("supabase-unreachable");
    },
    request: emptyRequest,
    onError(error) {
      errors.push(error);
    }
  };

  await runRoomBackupOnce(ports);

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /supabase-unreachable/);
});

test("한 방의 백업 실패가 다른 방의 백업을 막지 않는다", async () => {
  const results: Array<{ roomId: string; ok: boolean }> = [];
  let calls = 0;
  const failingRequest: RoomBackupRestRequest = async (method, path) => {
    calls += 1;
    if (path.startsWith("/huai_tasks") && calls <= 2) throw new Error("room-1-unreachable");
    if (method === "GET") return { status: 200, async expectOk() {}, async json<T>() { return [] as unknown as T; } };
    return { status: 201, async expectOk() {}, async json<T>() { return undefined as T; } };
  };

  const ports: RoomBackupSchedulerPorts = {
    async listRoomIds() {
      return ["room-1", "room-2"];
    },
    request: failingRequest,
    ...noopFsPorts,
    onRoomResult(roomId, result) {
      results.push({ roomId, ok: result.ok });
    }
  };

  await runRoomBackupOnce(ports);

  assert.equal(results.length, 2, "room-1 이 실패해도 room-2 는 시도됐어야 한다");
});

test("주기적으로 실행하고 stop() 이후에는 더 돌지 않는다", async (t) => {
  let calls = 0;
  const handle = startRoomBackupLoop({
    intervalMs: 5,
    async listRoomIds() {
      calls += 1;
      return [];
    },
    request: emptyRequest
  });
  t.after(() => handle.stop());

  await new Promise((resolve) => setTimeout(resolve, 60));
  const callsBeforeStop = calls;
  assert.ok(callsBeforeStop >= 2, `주기 실행이 안 돈 것으로 보인다: ${callsBeforeStop}회`);

  handle.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, callsBeforeStop, "stop() 이후에는 더 실행되면 안 된다");
});

test("실행 중 겹치면 다음 tick 을 건너뛴다 — 느린 백업이 쌓이지 않는다", async (t) => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const handle = startRoomBackupLoop({
    intervalMs: 5,
    async listRoomIds() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrent -= 1;
      return [];
    },
    request: emptyRequest
  });
  t.after(() => handle.stop());

  await new Promise((resolve) => setTimeout(resolve, 100));
  handle.stop();

  assert.equal(maxConcurrent, 1, "겹쳐 돌면 같은 백업이 동시에 두 번 실행될 수 있다");
});

test("listRoomIdsFromSupabase는 huai_rooms 를 조회해 room_id 배열로 변환한다", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, options?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: options?.headers ?? {} });
    return {
      ok: true,
      async json() {
        return [{ room_id: "r1" }, { room_id: "r2" }];
      }
    } as Response;
  }) as typeof fetch;

  const listRoomIds = listRoomIdsFromSupabase("https://example.supabase.co/", "service-role-key", fetchImpl);
  const roomIds = await listRoomIds();

  assert.deepEqual(roomIds, ["r1", "r2"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/huai_rooms?select=room_id&status=eq.active");
  assert.equal(calls[0].headers.apikey, "service-role-key");
});

test("listRoomIdsFromSupabase는 실패 응답을 명확한 에러로 던진다", async () => {
  const fetchImpl = (async () =>
    ({
      ok: false,
      status: 500,
      async text() {
        return "internal error";
      }
    }) as Response) as typeof fetch;

  const listRoomIds = listRoomIdsFromSupabase("https://example.supabase.co", "key", fetchImpl);

  await assert.rejects(() => listRoomIds(), /list-rooms-failed:500/);
});

// 실측(2026-08-31): 필터가 없어 archived 방까지 6시간마다 백업하고 있었다.
test("listRoomIdsFromSupabase 는 active 방만 조회한다", async () => {
  const requested: string[] = [];
  const listRoomIds = listRoomIdsFromSupabase("https://example.supabase.co", "key", (async (url: string) => {
    requested.push(String(url));
    return { ok: true, async json() { return [{ room_id: "room-1" }]; } } as unknown as Response;
  }) as unknown as typeof fetch);

  assert.deepEqual(await listRoomIds(), ["room-1"]);
  assert.equal(requested.length, 1);
  assert.equal(
    requested[0]?.includes("status=eq.active"),
    true,
    `archived 방까지 백업하면 안 된다 — 실제 요청: ${requested[0]}`
  );
});
