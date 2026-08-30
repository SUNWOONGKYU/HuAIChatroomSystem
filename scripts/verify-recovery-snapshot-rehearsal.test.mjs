import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dryRunRestoreIntoFakeStore, verifyRecoverySnapshotRehearsal } from "./verify-recovery-snapshot-rehearsal.mjs";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOM_ID = "99999999-9999-4999-8999-999999999999";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

function fullEmptySnapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    roomId: ROOM_ID,
    capturedAt: "2026-08-29T00:00:00.000Z",
    tasks: [],
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
    missingTables: [],
    ...overrides
  };
}

const VALID_SNAPSHOT = fullEmptySnapshot({
  tasks: [{ task_id: TASK_ID, room_id: ROOM_ID }],
  events: [{ event_id: "e1", room_id: ROOM_ID }, { event_id: "e2", room_id: ROOM_ID }],
  artifacts: [{ artifact_id: "art1", task_id: TASK_ID }],
  approvals: [{ approval_id: "a1", room_id: ROOM_ID }]
});

async function writeSnapshot(dir, snapshot) {
  const content = JSON.stringify(snapshot, null, 2);
  const checksum = createHash("sha256").update(content, "utf8").digest("hex");
  const filePath = path.join(dir, "snapshot.json");
  await writeFile(filePath, content, "utf8");
  return { filePath, checksum };
}

test("reports success for an intact, structurally valid, referentially sound snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const { filePath, checksum } = await writeSnapshot(dir, VALID_SNAPSHOT);

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, true);
    assert.equal(result.summary.roomId, VALID_SNAPSHOT.roomId);
    assert.equal(result.summary.capturedAt, VALID_SNAPSHOT.capturedAt);
    assert.equal(result.summary.schemaVersion, 2);
    assert.equal(result.summary.counts.tasks, 1);
    assert.equal(result.summary.counts.events, 2);
    assert.equal(result.summary.counts.artifacts, 1);
    assert.equal(result.summary.counts.approvals, 1);
    assert.deepEqual(result.summary.missingTables, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads the checksum from a .sha256 sidecar file when no expected checksum is given", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const content = JSON.stringify(VALID_SNAPSHOT, null, 2);
    const checksum = createHash("sha256").update(content, "utf8").digest("hex");
    const filePath = path.join(dir, "snapshot.json");
    await writeFile(filePath, content, "utf8");
    await writeFile(`${filePath}.sha256`, `${checksum}\n`, "utf8");

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath });

    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails clearly when the file content does not match the expected checksum (corruption)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const content = JSON.stringify(VALID_SNAPSHOT, null, 2);
    const filePath = path.join(dir, "snapshot.json");
    await writeFile(filePath, content, "utf8");

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: "deadbeef" });

    assert.equal(result.ok, false);
    assert.match(result.error, /checksum-mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails clearly when the snapshot is structurally invalid (missing tasks array)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const broken = { ...VALID_SNAPSHOT };
    delete broken.tasks;
    const content = JSON.stringify(broken, null, 2);
    const checksum = createHash("sha256").update(content, "utf8").digest("hex");
    const filePath = path.join(dir, "snapshot.json");
    await writeFile(filePath, content, "utf8");

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, false);
    assert.match(result.error, /invalid-structure/);
    assert.match(result.error, /tasks:not-an-array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails clearly on schemaVersion 1 (superseded) snapshots — the shape no longer matches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const v1 = { schemaVersion: 1, roomId: ROOM_ID, capturedAt: "x", tasks: [], events: [], artifacts: [], approvals: [] };
    const content = JSON.stringify(v1, null, 2);
    const checksum = createHash("sha256").update(content, "utf8").digest("hex");
    const filePath = path.join(dir, "snapshot.json");
    await writeFile(filePath, content, "utf8");

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, false);
    assert.match(result.error, /invalid-structure/);
    assert.match(result.error, /schemaVersion:expected=2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails clearly when the snapshot file does not exist", async () => {
  const result = await verifyRecoverySnapshotRehearsal({
    snapshotPath: path.join(tmpdir(), "does-not-exist-recovery-snapshot.json"),
    expectedChecksum: "irrelevant"
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /snapshot-not-readable/);
});

test("fails referential integrity when an artifact points at a task_id that is not in the snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const broken = fullEmptySnapshot({
      tasks: [{ task_id: TASK_ID, room_id: ROOM_ID }],
      artifacts: [{ artifact_id: "art1", task_id: "does-not-exist" }]
    });
    const { filePath, checksum } = await writeSnapshot(dir, broken);

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, false);
    assert.match(result.error, /referential-integrity-violation/);
    assert.match(result.error, /huai_artifacts:orphan-task-id:does-not-exist/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails referential integrity when a room-scoped row belongs to a different room", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const broken = fullEmptySnapshot({
      roomMembers: [{ telegram_user_id: "u1", room_id: OTHER_ROOM_ID }]
    });
    const { filePath, checksum } = await writeSnapshot(dir, broken);

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, false);
    assert.match(result.error, /huai_room_members:room-id-mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails referential integrity when a task dependency points at an unknown predecessor/successor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    const broken = fullEmptySnapshot({
      tasks: [{ task_id: TASK_ID, room_id: ROOM_ID }],
      taskDependencies: [{ dependency_id: "d1", predecessor_task_id: TASK_ID, successor_task_id: "ghost-task" }]
    });
    const { filePath, checksum } = await writeSnapshot(dir, broken);

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, false);
    assert.match(result.error, /orphan-successor-task-id:ghost-task/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not flag orphan task_id references for a table that is honestly recorded as missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "recovery-rehearsal-"));
  try {
    // huai_artifacts 조회가 이번 실행에서 실패해 missingTables 에 실렸다고 하자 —
    // 그 상태에서 (조회에 실패했으니 당연히 비어 있는) artifacts=[] 를 "정상적으로
    // 텅 빈 것"과 똑같이 취급해 원래 있어야 했을 참조를 억지로 검사하면 안 된다.
    // 여기서는 그 반대 — 부분 실패가 실제로 남아 있어도 리허설이 통과해야 함을 본다.
    const snapshot = fullEmptySnapshot({
      tasks: [{ task_id: TASK_ID, room_id: ROOM_ID }],
      artifacts: [],
      missingTables: [{ table: "huai_artifacts", reason: "supabase-rest-error:500:internal" }]
    });
    const { filePath, checksum } = await writeSnapshot(dir, snapshot);

    const result = await verifyRecoverySnapshotRehearsal({ snapshotPath: filePath, expectedChecksum: checksum });

    assert.equal(result.ok, true);
    assert.deepEqual(result.summary.missingTables, ["huai_artifacts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dryRunRestoreIntoFakeStore never writes anywhere — it only returns violations and an in-memory reconstruction", () => {
  const restore = dryRunRestoreIntoFakeStore(VALID_SNAPSHOT);
  assert.equal(restore.ok, true);
  assert.deepEqual(restore.violations, []);
  assert.equal(restore.fakeStore.tasks.length, 1);
  assert.equal(restore.fakeStore.artifacts.length, 1);
});
