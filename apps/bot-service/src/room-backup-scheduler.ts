// 방 전체를 주기적으로 자동 백업한다.
//
// 왜 필요한가: room-backup.ts(packages/supabase-runtime)가 조회·직렬화·저장 로직을
// 갖추고도 어떤 실행 경로에도 연결돼 있지 않아 실제로는 한 방도 백업되지 않았다
// (2차 독립 평가 3명이 공통으로 지적). 이 파일은 stale-proposal-cleanup.ts 와 같은
// 원칙으로 bot-service 상주 프로세스에 주기 루프를 붙인다 — bot-service 가 이미 계속
// 떠 있으므로 Windows 작업 스케줄러 같은 별도 인프라 없이 기동만으로 자동으로 돈다.
//
// 왜 nightly-room-archive.cmd 같은 야간 배치가 아닌가: 그쪽(archive/distill/prune)은
// "어제까지 끝난 하루"를 옮기는 하루 1회 작업이라 몇 시간의 지연이 문제되지 않는다.
// 백업은 정반대다 — 장애가 언제 날지 모르므로 마지막 백업과 장애 시점 사이의 손실
// 구간이 짧을수록 좋다. bot-service 는 이미 인바운드 드레인(100ms)·아웃박스 루프
// (250ms)·정체 제안 정리(1시간)를 상주로 돌리고 있어 루프 하나 더 얹는 비용은
// 사실상 0이고, 오프라인/로컬 모드에서는 stale-proposal-cleanup 과 똑같이
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY 가 없으면 조용히 꺼진다.
//
// 왜 scripts/cancel-stale-proposals.mjs 처럼 자식 프로세스로 실행하지 않는가: 그
// 스크립트는 scripts/ 아래 plain ESM 이라 bot-service(tsc 로 dist/ 컴파일)와 빌드
// 경계가 달라 상대경로 import 로 직접 묶을 수 없었다. room-backup.ts 는 반대로
// packages/supabase-runtime/src 에 있는 TS 파일이라 apps/bot-service 의 다른
// 파일들(예: supabase-store.ts)이 이미 packages/supabase-runtime/src/index.js 를
// 상대경로로 직접 import 하는 것과 같은 방식으로 바로 묶을 수 있다 — 자식 프로세스를
// 새로 띄우는 비용과 실패 지점을 늘릴 이유가 없다.
//
// 방 목록은 매 tick 마다 다시 조회한다(부팅 시점 스냅샷을 캐시하지 않는다) — 방이
// 새로 생기거나 없어져도 다음 tick 에 바로 반영된다.

import {
  recordRoomBackupSnapshot,
  type RoomBackupRestRequest,
  type RecordRoomBackupSnapshotResult
} from "../../../packages/supabase-runtime/src/room-backup.js";

export type RoomBackupSchedulerPorts = {
  listRoomIds(): Promise<string[]>;
  request: RoomBackupRestRequest;
  onRoomResult?(roomId: string, result: RecordRoomBackupSnapshotResult): void;
  onError?(error: unknown): void;
  // 실제 운영에서는 비워 둔다 — room-backup.ts 의 기본값(실제 로컬 디스크 쓰기)을
  // 그대로 쓴다. 테스트가 진짜 파일시스템을 건드리지 않도록 가짜로 갈아끼우는 용도다.
  rootDir?: string;
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
};

// 방 목록 조회 자체의 실패(Supabase 전체 접속 불가 등)도 예외를 던지지 않는다 —
// 정리 실패가 bot-service 전체를 죽이면 안 된다는 stale-proposal-cleanup 과 같은 원칙.
// 방 하나의 백업 실패도 나머지 방을 막지 않는다 — recordRoomBackupSnapshot 자체가
// 이미 { ok: false } 로 돌려주지 던지지 않으므로, 여기서는 그 결과를 그대로 보고한다.
export async function runRoomBackupOnce(ports: RoomBackupSchedulerPorts): Promise<void> {
  try {
    const roomIds = await ports.listRoomIds();
    for (const roomId of roomIds) {
      const result = await recordRoomBackupSnapshot(
        { request: ports.request, rootDir: ports.rootDir, writeFile: ports.writeFile, mkdir: ports.mkdir },
        roomId,
        { createdBy: "bot-service-auto" }
      );
      ports.onRoomResult?.(roomId, result);
    }
  } catch (error) {
    ports.onError?.(error);
  }
}

export type RoomBackupSchedulerHandle = { stop(): void };

export function startRoomBackupLoop(
  ports: RoomBackupSchedulerPorts & { intervalMs?: number }
): RoomBackupSchedulerHandle {
  // 6시간 — stale-proposal-cleanup(1시간)보다 느슨하다. 방 하나당 13개 테이블을
  // 조회하므로 너무 잦으면 Supabase 호출량만 늘어난다. 그래도 야간 배치(24시간)보다는
  // 훨씬 촘촘해 장애 시 손실 구간이 최대 6시간으로 줄어든다.
  const intervalMs = ports.intervalMs ?? 6 * 60 * 60 * 1000;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runRoomBackupOnce(ports);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

// huai_rooms 전체의 room_id 를 REST 로 조회하는 기본 구현. room-backup.ts 의
// createRoomBackupRestClient 와 같은 최소 REST 관례(apikey/authorization 헤더)를 쓴다.
export function listRoomIdsFromSupabase(
  url: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch
): () => Promise<string[]> {
  const baseUrl = url.replace(/\/+$/, "");
  return async () => {
    const response = await fetchImpl(`${baseUrl}/rest/v1/huai_rooms?select=room_id`, {
      headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!response.ok) {
      throw new Error(`list-rooms-failed:${response.status}:${(await response.text()).slice(0, 300)}`);
    }
    const rows = (await response.json()) as Array<{ room_id: string }>;
    return rows.map((row) => row.room_id);
  };
}
