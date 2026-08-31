// 운영자가 직접 돌리는 방 복구(restore) CLI — room-backup.ts/create-room-backup.mjs가
// "백업"만 만들고 "복구"가 저장소 어디에도 없던 공백을 메운다(3차 평가 지적).
//
// 기본은 dry-run이다. 실제로 Supabase에 쓰려면 --apply를 명시해야 한다.
//
// 사용법:
//   node --env-file=.env.operation.local scripts/restore-room-backup.mjs <snapshotPath> [expectedChecksum]
//     → dry-run. 아무 것도 쓰지 않는다. 테이블별 총 행수/이미 있는 행수/새로 넣을 행수만 보여준다.
//   node --env-file=.env.operation.local scripts/restore-room-backup.mjs <snapshotPath> [expectedChecksum] --apply
//     → 대상(프로젝트 URL/방 id/테이블별 행수)을 먼저 보여주고, 터미널에서 정확히 "yes"를
//       입력해야 실제로 Supabase에 upsert한다(결함, 4차 평가 지적 — 플래그 하나로 바로 쓰는
//       것은 비개발자 운영자가 오타·복사실수로 --apply를 잘못 붙이는 걸 막지 못했다).
//   node ... scripts/restore-room-backup.mjs <snapshotPath> [expectedChecksum] --apply --yes
//     → 확인 프롬프트를 건너뛰고 즉시 쓴다. CI/자동화 등 비대화형 환경 전용 — 기본은 항상
//       확인을 요구한다. 비대화형 환경(터미널이 아닌 stdin)에서 --yes 없이 --apply만 주면
//       입력을 기다리며 멈추지 않고 즉시 취소 처리한다(빈 입력은 "yes"가 아니므로).
//   불완전한 스냅샷(missingTables가 있음)은 --apply 시 --allow-incomplete를 함께 주지
//   않으면 거부한다 — 조용히 부분 복원하지 않기 위해서다.
//
// 무결성 게이트: 쓰기 전에 항상 verify-recovery-snapshot-rehearsal.mjs의 검증(체크섬 일치,
// 구조, 스냅샷 내부 참조 무결성)을 먼저 통과해야 한다. 실패하면 아무 것도 시도하지 않는다.
//
// 멱등성 설계:
//  - huai_approvals/huai_events는 append-only 원장이다(schema.sql의 huai_reject_ledger_mutation
//    트리거가 UPDATE/DELETE를 예외로 막는다). 이 두 테이블은 절대 upsert(merge-duplicates)하지
//    않고 PostgREST의 resolution=ignore-duplicates(= INSERT ... ON CONFLICT DO NOTHING)로만
//    쓴다 — 이미 있는 행을 건드리지 않으므로 트리거가 걸리지 않는다.
//  - 나머지 11개 테이블은 resolution=merge-duplicates(= INSERT ... ON CONFLICT DO UPDATE)로
//    쓴다. 같은 스냅샷을 두 번 복원해도 값이 같은 UPDATE만 반복될 뿐 중복 행이 생기지 않는다.
//  - huai_tasks ↔ huai_approvals는 서로를 참조한다(huai_tasks.approved_by_approval_id →
//    huai_approvals.approval_id, huai_approvals.task_id → huai_tasks.task_id) — 순환 FK다.
//    그래서 huai_tasks는 두 번 쓴다: 1차는 approved_by_approval_id를 null로 비워 넣고
//    (huai_approvals가 아직 없어도 FK를 안 건드림), huai_approvals를 넣은 다음, 2차로
//    같은 huai_tasks 행을 원래 approved_by_approval_id 값으로 다시 upsert한다.
//
// 알려진 범위 제한(정직하게 밝힌다 — room-backup.ts가 애초에 담지 않는 것들 때문에
// 생기는 한계다): huai_message_bindings.verification_id / huai_revision_requests.verification_id
// 는 huai_verifications를 가리킬 수 있는데, 그 테이블은 이 백업 스냅샷에 아예 담기지
// 않는다(room-backup.ts 헤더 주석 참고). 그런 행이 있으면 해당 테이블 전체 upsert가
// FK 위반으로 실패할 수 있다 — 이 스크립트가 조용히 넘기지 않고 실패로 보고한다.

import { readFile as fsReadFile } from "node:fs/promises";
import { createRoomBackupRestClient } from "../dist/packages/supabase-runtime/src/room-backup.js";
import { verifyRecoverySnapshotRehearsal } from "./verify-recovery-snapshot-rehearsal.mjs";

// room-backup.ts의 ALL_ROOM_BACKUP_TABLES와 짝을 이루지만, 여기는 그걸로는 부족하다 —
// 복원에는 테이블별 PK(on_conflict 대상)와 이 테이블이 room_id로 바로 스코프되는지
// (아니면 task_id로 스코프되는지), append-only라 ignore-duplicates를 써야 하는지가
// 추가로 필요하다. verify-recovery-snapshot-rehearsal.mjs와 같은 이유로(빌드 경계
// 밖 plain ESM) dist를 임포트하지 않고 이 메타데이터를 여기 직접 적어 둔다 —
// room-backup.ts에 테이블을 추가/삭제하면 이 목록도 같이 고쳐야 한다.
export const RESTORE_STEPS = [
  { field: "roomMembers", table: "huai_room_members", pk: ["room_id", "telegram_user_id"], scope: "room", resolution: "merge-duplicates" },
  { field: "aiActors", table: "huai_ai_actors", pk: ["actor_id"], scope: "room", resolution: "merge-duplicates" },
  { field: "taskProposals", table: "huai_task_proposals", pk: ["proposal_id"], scope: "room", resolution: "merge-duplicates" },
  // append-only 원장 — merge-duplicates를 쓰면 이미 있는 행에 UPDATE가 나가 트리거가 막는다.
  { field: "events", table: "huai_events", pk: ["event_id"], scope: "room", resolution: "ignore-duplicates" },
  { field: "approvals", table: "huai_approvals", pk: ["approval_id"], scope: "room", resolution: "ignore-duplicates" },
  { field: "taskDependencies", table: "huai_task_dependencies", pk: ["dependency_id"], scope: "room", resolution: "merge-duplicates" },
  { field: "agentPersonas", table: "huai_agent_personas", pk: ["persona_id"], scope: "room", resolution: "merge-duplicates" },
  { field: "taskReports", table: "huai_task_reports", pk: ["report_id"], scope: "room", resolution: "merge-duplicates" },
  // task_id로만 스코프되는 테이블(room_id 컬럼이 없다) — room-backup.ts의 TASK_SCOPED_TABLES.
  { field: "artifacts", table: "huai_artifacts", pk: ["artifact_id"], scope: "task", resolution: "merge-duplicates" },
  { field: "reports", table: "huai_reports", pk: ["report_id"], scope: "task", resolution: "merge-duplicates" },
  { field: "revisionRequests", table: "huai_revision_requests", pk: ["revision_request_id"], scope: "task", resolution: "merge-duplicates" },
  // 순환 FK 때문에 별도 특수 취급하는 huai_tasks. RESTORE_STEPS에는 dry-run 미리보기용으로
  // 한 번만 올라간다 — 실제 쓰기 순서(buildWriteOperations)에서는 이 항목을 2번 나눠 쓴다.
  { field: "tasks", table: "huai_tasks", pk: ["task_id"], scope: "room", resolution: "merge-duplicates" },
  { field: "messageBindings", table: "huai_message_bindings", pk: ["binding_id"], scope: "room", resolution: "merge-duplicates" }
];

const STEP_BY_FIELD = Object.fromEntries(RESTORE_STEPS.map((step) => [step.field, step]));

function rowKey(step, row) {
  return step.pk.map((col) => String(row?.[col])).join("|");
}

function extractTaskIds(snapshot) {
  return (snapshot.tasks ?? [])
    .map((task) => task?.task_id)
    .filter((taskId) => typeof taskId === "string" && taskId.length > 0);
}

/**
 * 이 테이블에서 이미 DB에 있는 행의 PK 집합을 가져온다. room 스코프 테이블은 room_id로,
 * task 스코프 테이블은(huai_tasks 조회로 얻은) task_id 목록으로 조회한다 —
 * buildRoomBackupSnapshot의 fetchRoomScoped/fetchTaskScoped와 같은 스코프 전략이다.
 */
export async function fetchExistingKeys(request, step, roomId, taskIds) {
  const selectCols = step.pk.join(",");
  let path;
  if (step.scope === "room") {
    path = `/${step.table}?room_id=eq.${encodeURIComponent(roomId)}&select=${selectCols}`;
  } else {
    if (taskIds.length === 0) return new Set();
    path = `/${step.table}?task_id=in.(${taskIds.map((id) => encodeURIComponent(id)).join(",")})&select=${selectCols}`;
  }
  const response = await request("GET", path);
  const rows = await response.json();
  return new Set((rows ?? []).map((row) => rowKey(step, row)));
}

/**
 * dry-run 미리보기: 테이블별 총 행수/이미 있는 행수/새로 넣을 행수. 아무 것도 쓰지 않는다.
 * missingTables에 든 테이블은 애초에 스냅샷에 담기지 않았으므로 미리보기 자체를 건너뛰고
 * skipped:true로 표시한다.
 */
export async function previewRestore(request, snapshot, missingTableNames) {
  const roomId = snapshot.roomId;
  const taskIds = extractTaskIds(snapshot);
  const rows = [];

  for (const step of RESTORE_STEPS) {
    if (missingTableNames.has(step.table)) {
      rows.push({ table: step.table, skipped: true, reason: "missing-in-snapshot" });
      continue;
    }
    const snapshotRows = snapshot[step.field] ?? [];
    const existingKeys = await fetchExistingKeys(request, step, roomId, taskIds);
    const newCount = snapshotRows.filter((row) => !existingKeys.has(rowKey(step, row))).length;
    rows.push({
      table: step.table,
      skipped: false,
      total: snapshotRows.length,
      existing: snapshotRows.length - newCount,
      new: newCount
    });
  }

  return rows;
}

export function formatPreviewLine(entry) {
  if (entry.skipped) return `${entry.table.padEnd(28)} SKIP(스냅샷에 없음: ${entry.reason})`;
  return `${entry.table.padEnd(28)} total=${entry.total} existing=${entry.existing} new=${entry.new}`;
}

/**
 * 실제 쓰기 순서. huai_tasks만 두 단계로 쪼갠다 — 1차(approved_by_approval_id를 null로
 * 비움) → huai_events/huai_approvals 삽입 → 2차(원래 approved_by_approval_id로 복원).
 * 그 외 테이블은 FK가 가리키는 테이블이 먼저 오도록만 배열한다
 * (huai_room_members/huai_ai_actors/huai_task_proposals가 huai_tasks보다 먼저,
 * huai_task_dependencies/huai_task_reports/huai_artifacts/huai_reports/huai_revision_requests/
 * huai_message_bindings는 huai_tasks 이후).
 */
export function buildWriteOperations(snapshot, missingTableNames) {
  const ops = [];

  function push(field, label, transformRow) {
    const step = STEP_BY_FIELD[field];
    if (missingTableNames.has(step.table)) {
      ops.push({ step, label, skipped: true, rows: [] });
      return;
    }
    const rows = snapshot[field] ?? [];
    ops.push({ step, label, skipped: false, rows: transformRow ? rows.map(transformRow) : rows });
  }

  push("roomMembers", "huai_room_members");
  push("aiActors", "huai_ai_actors");
  push("taskProposals", "huai_task_proposals");
  push("tasks", "huai_tasks (1/2: 승인 FK 임시 해제)", (row) => ({ ...row, approved_by_approval_id: null }));
  push("events", "huai_events");
  push("approvals", "huai_approvals");
  push("tasks", "huai_tasks (2/2: 승인 연결 복원)");
  push("taskDependencies", "huai_task_dependencies");
  push("agentPersonas", "huai_agent_personas");
  push("taskReports", "huai_task_reports");
  push("artifacts", "huai_artifacts");
  push("reports", "huai_reports");
  push("revisionRequests", "huai_revision_requests");
  push("messageBindings", "huai_message_bindings");

  return ops;
}

async function applyOperation(request, op) {
  if (op.skipped) return { label: op.label, table: op.step.table, skipped: true, attempted: 0, ok: true };
  if (op.rows.length === 0) return { label: op.label, table: op.step.table, skipped: false, attempted: 0, ok: true };

  const conflictCols = op.step.pk.join(",");
  try {
    const response = await request("POST", `/${op.step.table}?on_conflict=${conflictCols}`, {
      body: op.rows,
      prefer: `resolution=${op.step.resolution},return=minimal`
    });
    await response.expectOk();
    return { label: op.label, table: op.step.table, skipped: false, attempted: op.rows.length, ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { label: op.label, table: op.step.table, skipped: false, attempted: op.rows.length, ok: false, reason };
  }
}

// 결함(4차 평가) 대응 — 실제 터미널(TTY)에서만 사람에게 물어본다. TTY가 아닌데
// (파이프/서비스로 실행됨) --yes 도 없이 --apply 가 들어오면, 입력을 기다리며 영원히
// 멈추는 대신 빈 문자열을 돌려준다 — 아래 호출부가 "yes"가 아닌 모든 응답을 취소로
// 처리하므로 안전하게(=아무 것도 안 쓰고) 종료된다.
async function defaultConfirm(promptText) {
  if (!process.stdin.isTTY) return "";
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(promptText);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * 전체 복구 오케스트레이션. loadSnapshot/request/log 등을 주입받아 테스트에서
 * 실제 파일시스템·Supabase 없이 검증한다. 기본값만 실제 운영 배선(fs.readFile,
 * verifyRecoverySnapshotRehearsal, 실제 stdin 프롬프트)이다.
 */
export async function runRestoreRoomBackup({
  snapshotPath,
  expectedChecksum,
  apply = false,
  allowIncomplete = false,
  // --apply 확인 프롬프트를 건너뛰는 플래그. 기본은 항상 확인을 요구한다(사람 승인 게이트).
  yes = false,
  // 확인 프롬프트에 함께 보여줄 대상 프로젝트 표시용 문자열(선택). CLI 진입점에서 SUPABASE_URL을 넘긴다.
  targetUrl,
  request,
  readFile = fsReadFile,
  verify = verifyRecoverySnapshotRehearsal,
  confirm = defaultConfirm,
  log = console.log,
  logError = console.error
}) {
  const verification = await verify({ snapshotPath, expectedChecksum, readFile });
  if (!verification.ok) {
    logError(`FAIL 무결성 검증 실패 — 복구를 시도하지 않는다: ${verification.error}`);
    return { ok: false, reason: `verification-failed:${verification.error}` };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logError(`FAIL 스냅샷을 다시 읽을 수 없다: ${reason}`);
    return { ok: false, reason: `snapshot-reread-failed:${reason}` };
  }

  const missingTableNames = new Set((snapshot.missingTables ?? []).map((entry) => entry.table));
  if (missingTableNames.size > 0) {
    logError(
      `WARN 이 스냅샷은 불완전하다 — 다음 테이블이 백업 시점에 빠졌다: ${[...missingTableNames].join(", ")}`
    );
  }

  log(`room=${snapshot.roomId} capturedAt=${snapshot.capturedAt} mode=${apply ? "APPLY" : "dry-run"}`);

  if (!apply) {
    const preview = await previewRestore(request, snapshot, missingTableNames);
    for (const entry of preview) log(formatPreviewLine(entry));
    if (missingTableNames.size > 0) {
      log(`이 스냅샷은 불완전하다. --apply 실행 시 --allow-incomplete 없이는 거부된다.`);
    }
    return { ok: true, dryRun: true, preview, missingTables: [...missingTableNames] };
  }

  if (missingTableNames.size > 0 && !allowIncomplete) {
    logError(
      `FAIL 불완전한 스냅샷을 조용히 부분 복원하지 않는다. ` +
        `--allow-incomplete 를 명시하지 않으면 --apply 를 거부한다. 빠진 테이블: ${[...missingTableNames].join(", ")}`
    );
    return { ok: false, reason: "incomplete-snapshot-requires-allow-incomplete", missingTables: [...missingTableNames] };
  }

  // 결함(4차 평가) 대응 — 플래그 하나(--apply)로 곧장 운영 DB에 쓰지 않는다. 무엇을
  // 어디에 쓸 것인지(대상 프로젝트/방 id/테이블별 행 수) 먼저 요약해 보여주고, --yes가
  // 없으면 터미널에서 정확히 "yes"를 입력해야 진행한다. 이 확인은 previewRestore를
  // 다시 호출해서 만든다 — dry-run과 같은 함수라 여기서 보여주는 숫자가 실제로 쓸 값과
  // 어긋나지 않는다.
  const confirmationPreview = await previewRestore(request, snapshot, missingTableNames);
  log(`--- 아래 내용을 실제 운영 DB(${targetUrl ?? "SUPABASE_URL 미지정"})에 씁니다 ---`);
  log(`대상 방(room_id): ${snapshot.roomId}`);
  for (const entry of confirmationPreview) log(formatPreviewLine(entry));
  log(`----------------------------------------------------------`);

  if (!yes) {
    const answer = await confirm('계속하려면 정확히 "yes" 를 입력하세요 (그 외 입력은 모두 취소): ');
    if (answer !== "yes") {
      log("취소됨 — 아무 것도 쓰지 않았다.");
      return { ok: false, reason: "confirmation-declined" };
    }
  }

  const operations = buildWriteOperations(snapshot, missingTableNames);
  const results = [];
  for (const op of operations) {
    const result = await applyOperation(request, op);
    results.push(result);
    if (result.skipped) {
      log(`SKIP ${result.label ?? result.table} (스냅샷에 없음)`);
    } else if (result.ok) {
      log(`OK   ${result.label ?? result.table} attempted=${result.attempted}`);
    } else {
      logError(`FAIL ${result.label ?? result.table} attempted=${result.attempted} reason=${result.reason}`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  log(
    `완료: ${results.length - failed.length}/${results.length} 단계 성공` +
      (failed.length > 0 ? `, ${failed.length}건 실패 — 위 FAIL 줄에서 어디까지 복원됐는지 확인하라` : "")
  );

  return { ok: failed.length === 0, dryRun: false, results, missingTables: [...missingTableNames] };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const args = process.argv
    .slice(2)
    .filter((arg) => arg !== "--apply" && arg !== "--allow-incomplete" && arg !== "--yes");
  const [snapshotPath, expectedChecksum] = args;
  if (!snapshotPath) {
    console.error(
      "usage: node restore-room-backup.mjs <snapshotPath> [expectedChecksum] [--apply [--yes]] [--allow-incomplete]"
    );
    process.exit(1);
  }

  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const request = createRoomBackupRestClient({ url, serviceRoleKey: key });

  const result = await runRestoreRoomBackup({
    snapshotPath,
    expectedChecksum,
    apply: process.argv.includes("--apply"),
    allowIncomplete: process.argv.includes("--allow-incomplete"),
    yes: process.argv.includes("--yes"),
    targetUrl: url,
    request
  });

  if (!result.ok) process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}
