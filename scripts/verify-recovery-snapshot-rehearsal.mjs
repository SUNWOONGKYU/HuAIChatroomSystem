// 복구 리허설(dry-run): 방 백업 스냅샷 파일이 손상되지 않았고(체크섬 일치) 구조적으로
// 온전하며(schemaVersion/roomId/13개 테이블 배열 필드), 그 안의 참조가 서로 앞뒤가
// 맞는지(참조 무결성) 확인한다.
//
// 이 스크립트는 아무 것도 쓰지 않는다 — DB 에도, 디스크에도. "이 스냅샷으로 복구할 수
// 있다"를 실제로 복구하지 않고 증명하는 순수 읽기 전용 도구다. 운영자가 백업 직후 또는
// 정기적으로 돌려서 스냅샷이 썩지 않았는지 확인하는 용도다.
//
// 체크섬 인자: 두 번째 CLI 인자로 직접 주거나(권장: recordRoomBackupSnapshot 이 돌려준
// checksum), 생략하면 "<snapshotPath>.sha256" 사이드카 파일(내용은 hex 다이제스트
// 한 줄)을 대신 읽는다. 둘 다 없으면 실패로 처리한다.
//
// 참조 무결성 dry-run 복원: 실제 DB 에 쓰지 않고 스냅샷 안의 각 테이블을 메모리
// Map 으로 재구성해(dryRunRestoreIntoFakeStore) huai_tasks/huai_artifacts 등의 FK
// 가 스냅샷 내부에서 전부 해소되는지 확인한다. missingTables 로 표시된 테이블은
// "원래 비었다"가 아니라 "이번엔 못 담았다"는 뜻이므로 그 테이블이 관여하는 참조는
// 검사에서 제외한다(스냅샷을 만든 시점의 부분 실패를 리허설이 다시 오탐으로 벌하면
// 안 된다).
//
// 의도적으로 하지 않는 것: 각 행의 컬럼 하나하나까지 스키마 검증. 그건 이 드라이런
// 도구에는 과설계다 — 배열 존재/타입, room_id 일치, FK 해소까지만 본다.

import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";

// room-backup.ts 의 ALL_ROOM_BACKUP_TABLES 와 짝을 이룬다. 이 스크립트는 scripts/ 아래
// 빌드 경계 밖 plain ESM 이라(cancel-stale-proposals.mjs/stale-proposal-cleanup.ts 의
// 주석 참고) dist 산출물을 임포트하지 않고 목록을 그대로 복제해 둔다 — room-backup.ts
// 에 테이블을 추가/삭제하면 이 목록도 같이 고쳐야 한다.
const ROOM_SCOPED_FIELDS = [
  { field: "tasks", table: "huai_tasks" },
  { field: "events", table: "huai_events" },
  { field: "approvals", table: "huai_approvals" },
  { field: "roomMembers", table: "huai_room_members" },
  { field: "aiActors", table: "huai_ai_actors" },
  { field: "taskProposals", table: "huai_task_proposals" },
  { field: "taskDependencies", table: "huai_task_dependencies" },
  { field: "messageBindings", table: "huai_message_bindings" },
  { field: "agentPersonas", table: "huai_agent_personas" },
  { field: "taskReports", table: "huai_task_reports" }
];
const TASK_SCOPED_FIELDS = [
  { field: "artifacts", table: "huai_artifacts" },
  { field: "reports", table: "huai_reports" },
  { field: "revisionRequests", table: "huai_revision_requests" }
];
const ALL_FIELDS = [...ROOM_SCOPED_FIELDS, ...TASK_SCOPED_FIELDS];

export async function verifyRecoverySnapshotRehearsal(input) {
  const { snapshotPath, expectedChecksum, readFile = fsReadFile } = input;

  let raw;
  try {
    raw = await readFile(snapshotPath, "utf8");
  } catch (error) {
    return { ok: false, error: `snapshot-not-readable:${snapshotPath}:${error.message}` };
  }

  const actualChecksum = createHash("sha256").update(raw, "utf8").digest("hex");

  let checksum = expectedChecksum;
  if (!checksum) {
    try {
      checksum = (await readFile(`${snapshotPath}.sha256`, "utf8")).trim();
    } catch (error) {
      return {
        ok: false,
        error: `no-checksum-provided-and-no-sidecar:${snapshotPath}.sha256:${error.message}`
      };
    }
  }

  if (actualChecksum !== checksum) {
    return { ok: false, error: `checksum-mismatch:expected=${checksum}:actual=${actualChecksum}` };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid-json:${error.message}` };
  }

  const structuralErrors = validateSnapshotStructure(snapshot);
  if (structuralErrors.length > 0) {
    return { ok: false, error: `invalid-structure:${structuralErrors.join(",")}` };
  }

  const restore = dryRunRestoreIntoFakeStore(snapshot);
  if (!restore.ok) {
    return { ok: false, error: `referential-integrity-violation:${restore.violations.join(",")}` };
  }

  const missingTableNames = (snapshot.missingTables ?? []).map((entry) => entry.table);

  return {
    ok: true,
    summary: {
      roomId: snapshot.roomId,
      capturedAt: snapshot.capturedAt,
      schemaVersion: snapshot.schemaVersion,
      counts: Object.fromEntries(ALL_FIELDS.map(({ field }) => [field, snapshot[field].length])),
      missingTables: missingTableNames
    }
  };
}

function validateSnapshotStructure(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") return ["snapshot-not-an-object"];
  if (snapshot.schemaVersion !== 2) errors.push(`schemaVersion:expected=2:actual=${snapshot.schemaVersion}`);
  if (typeof snapshot.roomId !== "string" || snapshot.roomId.length === 0) errors.push("roomId:missing-or-empty");
  for (const { field } of ALL_FIELDS) {
    if (!Array.isArray(snapshot[field])) errors.push(`${field}:not-an-array`);
  }
  if (!Array.isArray(snapshot.missingTables)) errors.push("missingTables:not-an-array");
  return errors;
}

function isTableMissing(snapshot, table) {
  return (snapshot.missingTables ?? []).some((entry) => entry.table === table);
}

/**
 * 스냅샷 안의 각 테이블을 실제 DB 에 쓰지 않고 메모리 Map 으로 재구성해, 참조가
 * 스냅샷 내부에서 전부 해소되는지 확인한다("dry-run restore"). 실패해도(violations
 * 가 남아도) 아무 것도 쓰지 않은 채로 끝난다.
 *
 * 확인하는 것:
 *  - room_id 를 직접 갖는 테이블의 각 행이 실제로 이 방(snapshot.roomId) 소속인가.
 *  - huai_artifacts/huai_reports/huai_revision_requests/huai_task_dependencies 의
 *    task_id(예측·후속 포함)가 스냅샷의 huai_tasks 안에 실제로 존재하는가.
 *  - huai_events/huai_approvals/huai_message_bindings 의 (nullable) task_id 참조도
 *    있다면 마찬가지로 존재하는가.
 * missingTables 로 표시된 테이블이 관여하는 검사는 건너뛴다 — 이미 알려진 부분
 * 실패를 리허설이 다시 벌하면 "부분 실패 허용" 원칙과 모순된다.
 */
export function dryRunRestoreIntoFakeStore(snapshot) {
  const violations = [];
  const fakeStore = {};

  for (const { field, table } of ALL_FIELDS) {
    fakeStore[field] = Array.isArray(snapshot[field]) ? snapshot[field] : [];
  }

  for (const { field, table } of ROOM_SCOPED_FIELDS) {
    if (isTableMissing(snapshot, table)) continue;
    for (const row of fakeStore[field]) {
      if (row && typeof row === "object" && "room_id" in row && row.room_id !== snapshot.roomId) {
        violations.push(`${table}:room-id-mismatch:${row.room_id}`);
      }
    }
  }

  const tasksMissing = isTableMissing(snapshot, "huai_tasks");
  const taskIds = new Set(
    fakeStore.tasks
      .map((row) => (row && typeof row === "object" ? row.task_id : undefined))
      .filter((taskId) => typeof taskId === "string" && taskId.length > 0)
  );

  if (!tasksMissing) {
    for (const { field, table } of TASK_SCOPED_FIELDS) {
      if (isTableMissing(snapshot, table)) continue;
      for (const row of fakeStore[field]) {
        if (row && typeof row === "object" && !taskIds.has(row.task_id)) {
          violations.push(`${table}:orphan-task-id:${row.task_id}`);
        }
      }
    }

    if (!isTableMissing(snapshot, "huai_task_dependencies")) {
      for (const row of fakeStore.taskDependencies) {
        if (!row || typeof row !== "object") continue;
        if (!taskIds.has(row.predecessor_task_id)) {
          violations.push(`huai_task_dependencies:orphan-predecessor-task-id:${row.predecessor_task_id}`);
        }
        if (!taskIds.has(row.successor_task_id)) {
          violations.push(`huai_task_dependencies:orphan-successor-task-id:${row.successor_task_id}`);
        }
      }
    }

    // task_id 가 nullable 인 room-scoped 테이블들 — 값이 있을 때만 확인한다.
    for (const [field, table] of [
      ["events", "huai_events"],
      ["approvals", "huai_approvals"],
      ["messageBindings", "huai_message_bindings"]
    ]) {
      if (isTableMissing(snapshot, table)) continue;
      for (const row of fakeStore[field]) {
        if (row && typeof row === "object" && row.task_id != null && !taskIds.has(row.task_id)) {
          violations.push(`${table}:orphan-task-id:${row.task_id}`);
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, fakeStore };
}

export function formatRehearsalSummary(summary) {
  const countsText = Object.entries(summary.counts)
    .map(([field, count]) => `${field}=${count}`)
    .join(" ");
  const missingText = summary.missingTables.length > 0 ? summary.missingTables.join(",") : "none";
  return [
    `room=${summary.roomId}`,
    `capturedAt=${summary.capturedAt}`,
    `schemaVersion=${summary.schemaVersion}`,
    countsText,
    `missingTables=${missingText}`
  ].join(" ");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const [, , snapshotPath, expectedChecksum] = process.argv;
  if (!snapshotPath) {
    console.error("usage: node verify-recovery-snapshot-rehearsal.mjs <snapshotPath> [expectedChecksum]");
    process.exit(1);
  }
  const result = await verifyRecoverySnapshotRehearsal({ snapshotPath, expectedChecksum });
  if (!result.ok) {
    console.error(`FAIL ${result.error}`);
    process.exit(1);
  }
  console.log(`OK ${formatRehearsalSummary(result.summary)}`);
  if (result.summary.missingTables.length > 0) {
    console.error(`WARN 이 스냅샷은 일부 테이블을 담지 못했다: ${result.summary.missingTables.join(",")}`);
  }
}
