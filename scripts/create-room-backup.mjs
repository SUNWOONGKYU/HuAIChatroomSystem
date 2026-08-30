// 운영자가 직접 돌리는 방 백업 CLI.
//
// 왜 필요한가: room-backup.ts(packages/supabase-runtime)가 조회·직렬화·저장 로직을
// 갖추고도 자동 경로(apps/bot-service/src/room-backup-scheduler.ts)로만 연결돼 있어,
// bot-service 없이 운영자가 즉석에서 "지금 당장 이 방(또는 전체 방)을 백업해라"를
// 실행할 수단이 없었다. 이 스크립트가 그 수동 창구다.
//
// 왜 로직을 복제하지 않는가: room-backup.ts 의 조회/직렬화/저장을 여기 다시 옮겨 적으면
// 두 코드가 갈라져(드리프트) 한쪽만 고쳐지는 결함이 난다(stale-proposal-cleanup.ts 의
// 같은 원칙 참고). 대신 dist 빌드 산출물을 그대로 import 한다 — scripts/pin-room-board-
// message.mjs 가 이미 쓰는 관례(../dist/packages/<pkg>/src/....js)와 동일하다. 그래서
// 실행 전에 반드시 `npm run build` 가 먼저 돌아야 한다(package.json 에 추가할 스크립트
// 줄이 그 순서를 강제한다).
//
// 사용법:
//   node --env-file=.env.operation.local scripts/create-room-backup.mjs
//     → huai_rooms 의 모든 방을 백업한다.
//   node --env-file=.env.operation.local scripts/create-room-backup.mjs --room <roomId>
//     → 방 하나만 백업한다.
//   node --env-file=.env.operation.local scripts/create-room-backup.mjs --dry-run
//     → 아무 것도 쓰지 않는다(디스크 파일도, huai_recovery_snapshots 행도). 무엇을
//       백업하게 될지(테이블별 건수·체크섬·missingTables)만 보여준다.
//   --room 과 --dry-run 은 함께 쓸 수 있다.
//
// 필수 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import {
  buildRoomBackupSnapshot,
  createRoomBackupRestClient,
  recordRoomBackupSnapshot,
  serializeRoomBackupSnapshot
} from "../dist/packages/supabase-runtime/src/room-backup.js";

const DRY_RUN = process.argv.includes("--dry-run");
const ROOM_ID = argValue("--room");

/**
 * 방 목록 하나를 실제로 순회하며 백업(또는 dry-run 미리보기)한다. 조회/직렬화/저장
 * 함수를 인자로 받는 이유는 테스트에서 실제 Supabase/디스크 없이 가짜로 갈아끼우기
 * 위해서다 — 기본값은 room-backup.ts(dist 빌드 산출물)의 진짜 구현이다.
 */
export async function runCreateRoomBackup({
  roomIds,
  dryRun,
  request,
  buildSnapshot = buildRoomBackupSnapshot,
  serialize = serializeRoomBackupSnapshot,
  recordSnapshot = recordRoomBackupSnapshot,
  log = console.log,
  logError = console.error
}) {
  log(`대상 방: ${roomIds.length}건${dryRun ? " (dry-run — 아무 것도 쓰지 않는다)" : ""}`);

  let succeeded = 0;
  let failed = 0;

  for (const roomId of roomIds) {
    if (dryRun) {
      const snapshot = await buildSnapshot({ request }, roomId);
      const { checksum } = serialize(snapshot);
      const missing = snapshot.missingTables.map((entry) => entry.table).join(",") || "none";
      log(
        `[dry-run] room=${roomId} tasks=${snapshot.tasks.length} events=${snapshot.events.length} ` +
          `artifacts=${snapshot.artifacts.length} approvals=${snapshot.approvals.length} missingTables=${missing} checksum=${checksum}`
      );
      continue;
    }

    const result = await recordSnapshot({ request }, roomId, { createdBy: "operator-cli" });
    if (result.ok) {
      succeeded += 1;
      log(`OK room=${roomId} storage=${result.snapshotStorageUri} checksum=${result.checksum}`);
    } else {
      failed += 1;
      logError(`FAIL room=${roomId} reason=${result.reason}`);
    }
  }

  if (!dryRun) {
    log(`완료: 성공 ${succeeded}건, 실패 ${failed}건 (총 ${roomIds.length}건)`);
  }

  return { succeeded, failed, total: roomIds.length };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const request = createRoomBackupRestClient({ url, serviceRoleKey: key });

  const roomIds = ROOM_ID ? [ROOM_ID] : await listAllRoomIds(url, key);
  const { failed } = await runCreateRoomBackup({ roomIds, dryRun: DRY_RUN, request });

  if (!DRY_RUN && failed > 0) process.exit(1);
}

export async function listAllRoomIds(url, serviceRoleKey) {
  const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/huai_rooms?select=room_id`, {
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` }
  });
  if (!response.ok) throw new Error(`list-rooms-failed:${response.status}:${(await response.text()).slice(0, 300)}`);
  const rows = await response.json();
  return rows.map((row) => row.room_id);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}
