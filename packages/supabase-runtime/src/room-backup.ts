import { createHash } from "node:crypto";
import { mkdir as fsMkdir, readdir as fsReaddir, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import nodePath from "node:path";

// 방(room) 단위 백업/복구 스냅샷. 오늘은 'artifact' 타입만 huai_recovery_snapshots
// 에 기록되고 있고(packages/supabase-runtime/src/index.ts 의 persistCollectedArtifacts),
// 방 전체를 한 번에 되살릴 수 있는 'room' 스냅샷은 없었다. 이 파일은 그 공백을 메운다.
//
// 범위 고지(정확한 것만 적는다 — 이전 버전 주석은 "방 전체"라고 과장해 실제보다 넓게
// 읽혔다): schemaVersion 2 는 room_id 로 스코프되는 아래 13개 테이블을 담는다 —
// huai_tasks/huai_events/huai_approvals/huai_artifacts(schemaVersion 1 부터)
// + huai_room_members/huai_ai_actors/huai_task_proposals/huai_task_dependencies/
// huai_message_bindings/huai_agent_personas/huai_task_reports(room_id 직접 스코프)
// + huai_reports/huai_revision_requests(task_id 경유로 스코프). 여전히 담지 않는 것:
// huai_rooms 행 자체(방 껍데기 — 온보딩 스크립트가 따로 만든다), huai_telegram_bots·
// huai_gateway_instances(방 전용이 아니라 공유 인프라), huai_verifications·
// huai_hook_attempts·huai_execution_attempts·huai_outbox·huai_telegram_updates·
// huai_audit_logs(처리 중 상태거나 30일 롤링으로 별도 보관되는 것들 — 이 스냅샷의
// 목적인 "방의 결정·산출물"에 해당하지 않는다). 'task'·'full_project' 타입은
// 아직 구현하지 않았다 — 필요해지면 별도 작업으로 추가한다.
//
// 부분 실패 원칙: 테이블 하나의 조회가 실패해도 나머지는 담는다. 대신 무엇이
// 빠졌는지 missingTables 에 정직하게 남긴다 — 조용히 빈 배열로 채워 "이 방엔 원래
// 그 테이블에 행이 없었다"처럼 보이게 하는 것이 가장 나쁜 실패 모드다.

export type MissingTableEntry = { table: string; reason: string };

export type RoomBackupSnapshot = {
  schemaVersion: 2;
  roomId: string;
  capturedAt: string; // ISO
  tasks: unknown[];
  events: unknown[];
  artifacts: unknown[];
  approvals: unknown[];
  roomMembers: unknown[];
  aiActors: unknown[];
  taskProposals: unknown[];
  taskDependencies: unknown[];
  messageBindings: unknown[];
  agentPersonas: unknown[];
  taskReports: unknown[];
  reports: unknown[];
  revisionRequests: unknown[];
  missingTables: MissingTableEntry[];
};

export type RoomBackupRestResponse = {
  status: number;
  expectOk(): Promise<void>;
  json<T>(): Promise<T>;
};

// SupabaseOutboxStore(index.ts)의 SupabaseRestClient 는 단일 ExecutionRequest 기준
// 부기용으로 만들어져 있어 방 전체 벌크 조회에는 맞지 않는다. 이 포트는 방 백업
// 전용으로 최소한만 필요하다 — 실제 호출부(운영 코드)는 아래 createRoomBackupRestClient
// 로 만들거나, 테스트에서는 가짜 request 함수를 주입한다.
export type RoomBackupRestRequest = (
  method: string,
  path: string,
  options?: { body?: unknown; prefer?: string }
) => Promise<RoomBackupRestResponse>;

export type RoomBackupSupabaseClientConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
};

/**
 * 실제 운영 배선용 최소 REST 클라이언트. apps/bot-service/src/supabase-store.ts
 * 의 SupabaseRestClient 와 같은 모양(request(method, path, {body, prefer}))이지만,
 * 여기서는 apps/bot-service 를 import 하지 않기 위해(순환 의존 방지) 필요한 부분만
 * 이 파일 안에 복제해 둔다.
 */
export function createRoomBackupRestClient(config: RoomBackupSupabaseClientConfig): RoomBackupRestRequest {
  const baseUrl = config.url.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;

  return async (method, path, options = {}) => {
    const response = await fetchImpl(`${baseUrl}/rest/v1${path}`, {
      method,
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json",
        ...(options.prefer ? { prefer: options.prefer } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    return {
      status: response.status,
      async expectOk() {
        if (!response.ok) {
          throw new Error(`supabase-rest-error:${response.status}:${await safeResponseText(response)}`);
        }
      },
      async json<T>(): Promise<T> {
        if (!response.ok) {
          throw new Error(`supabase-rest-error:${response.status}:${await safeResponseText(response)}`);
        }
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }
    };
  };
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export type RoomBackupDeps = {
  request: RoomBackupRestRequest;
  // 테스트에서 capturedAt 을 고정하기 위한 시계 주입. 기본은 실제 현재 시각.
  now?: () => Date;
  // writeRoomBackupSnapshotToDisk 로 그대로 전달되는 선택적 오버라이드.
  rootDir?: string;
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  // pruneRoomBackupSnapshots 로 그대로 전달되는 선택적 오버라이드(테스트 전용 — 실제
  // 운영은 비워 두면 real fs 를 쓴다). 방당 최대 보관 개수도 여기서 오버라이드할 수
  // 있다(기본은 maxSnapshotsPerRoomFromEnv()).
  readdir?: (path: string) => Promise<string[]>;
  unlink?: (path: string) => Promise<void>;
  maxSnapshotsPerRoom?: number;
};

type TaskRow = { task_id?: unknown } & Record<string, unknown>;

// room_id 컬럼을 직접 갖는 테이블 — room_id=eq.(...) 로 바로 조회한다.
// field 는 RoomBackupSnapshot 위 어느 배열 자리에 담기는지를 가리킨다.
const ROOM_SCOPED_TABLES: ReadonlyArray<{ table: string; field: keyof RoomBackupSnapshot }> = [
  { table: "huai_tasks", field: "tasks" },
  { table: "huai_events", field: "events" },
  { table: "huai_approvals", field: "approvals" },
  { table: "huai_room_members", field: "roomMembers" },
  { table: "huai_ai_actors", field: "aiActors" },
  { table: "huai_task_proposals", field: "taskProposals" },
  { table: "huai_task_dependencies", field: "taskDependencies" },
  { table: "huai_message_bindings", field: "messageBindings" },
  { table: "huai_agent_personas", field: "agentPersonas" },
  { table: "huai_task_reports", field: "taskReports" }
];

// room_id 컬럼이 없고 task_id 만 있는 테이블 — huai_tasks 조회로 얻은 task_id 들로
// in.(...) 조회한다(huai_artifacts 가 원래부터 이 방식이었다).
const TASK_SCOPED_TABLES: ReadonlyArray<{ table: string; field: keyof RoomBackupSnapshot }> = [
  { table: "huai_artifacts", field: "artifacts" },
  { table: "huai_reports", field: "reports" },
  { table: "huai_revision_requests", field: "revisionRequests" }
];

export const ALL_ROOM_BACKUP_TABLES: readonly string[] = [
  ...ROOM_SCOPED_TABLES.map((entry) => entry.table),
  ...TASK_SCOPED_TABLES.map((entry) => entry.table)
];

async function fetchRoomScoped(
  deps: RoomBackupDeps,
  table: string,
  roomId: string,
  missingTables: MissingTableEntry[]
): Promise<unknown[]> {
  try {
    const response = await deps.request(
      "GET",
      `/${table}?room_id=eq.${encodeURIComponent(roomId)}&select=*&order=created_at.asc`
    );
    return await response.json<unknown[]>();
  } catch (error) {
    recordMissingTable(missingTables, table, error);
    return [];
  }
}

async function fetchTaskScoped(
  deps: RoomBackupDeps,
  table: string,
  taskIds: readonly string[],
  missingTables: MissingTableEntry[]
): Promise<unknown[]> {
  try {
    const response = await deps.request(
      "GET",
      `/${table}?task_id=in.(${taskIds.map((id) => encodeURIComponent(id)).join(",")})&select=*&order=created_at.asc`
    );
    return await response.json<unknown[]>();
  } catch (error) {
    recordMissingTable(missingTables, table, error);
    return [];
  }
}

function recordMissingTable(missingTables: MissingTableEntry[], table: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  missingTables.push({ table, reason });
  console.error(JSON.stringify({ type: "room_backup_table_fetch_failed", table, reason }));
}

/**
 * 방 하나의 room_id/task_id 스코프 테이블들을 REST 로 모아 스냅샷으로 조립한다.
 * 테이블 하나의 조회가 실패해도 예외를 던지지 않는다 — 실패한 테이블은 missingTables 에
 * 기록하고 그 배열은 빈 값으로 둔다. huai_artifacts/huai_reports/huai_revision_requests
 * 는 huai_tasks 조회로 얻은 task_id 들에 의존하므로, huai_tasks 조회 자체가 실패하면
 * (task_id 범위를 알 수 없으므로) 이 세 테이블도 실제 조회 없이 곧장 missingTables 에
 * 넣는다 — "작업이 없어서 0건"과 "작업 목록을 몰라서 0건"을 섞으면 안 되기 때문이다.
 */
export async function buildRoomBackupSnapshot(deps: RoomBackupDeps, roomId: string): Promise<RoomBackupSnapshot> {
  const missingTables: MissingTableEntry[] = [];
  const collected: Partial<Record<keyof RoomBackupSnapshot, unknown[]>> = {};

  for (const { table, field } of ROOM_SCOPED_TABLES) {
    collected[field] = await fetchRoomScoped(deps, table, roomId, missingTables);
  }

  const tasks = (collected.tasks ?? []) as TaskRow[];
  const tasksAvailable = !missingTables.some((entry) => entry.table === "huai_tasks");
  const taskIds = tasks
    .map((task) => task.task_id)
    .filter((taskId): taskId is string => typeof taskId === "string" && taskId.length > 0);

  for (const { table, field } of TASK_SCOPED_TABLES) {
    if (!tasksAvailable) {
      missingTables.push({ table, reason: "dependent-on-huai_tasks-which-failed" });
      collected[field] = [];
      continue;
    }
    collected[field] = taskIds.length === 0 ? [] : await fetchTaskScoped(deps, table, taskIds, missingTables);
  }

  const capturedAt = (deps.now ? deps.now() : new Date()).toISOString();

  return {
    schemaVersion: 2,
    roomId,
    capturedAt,
    tasks: collected.tasks ?? [],
    events: collected.events ?? [],
    approvals: collected.approvals ?? [],
    artifacts: collected.artifacts ?? [],
    roomMembers: collected.roomMembers ?? [],
    aiActors: collected.aiActors ?? [],
    taskProposals: collected.taskProposals ?? [],
    taskDependencies: collected.taskDependencies ?? [],
    messageBindings: collected.messageBindings ?? [],
    agentPersonas: collected.agentPersonas ?? [],
    taskReports: collected.taskReports ?? [],
    reports: collected.reports ?? [],
    revisionRequests: collected.revisionRequests ?? [],
    missingTables
  };
}

/**
 * 스냅샷을 결정적으로 직렬화하고 SHA-256 체크섬을 계산한다. 같은 스냅샷 객체를
 * 두 번 넣으면 항상 같은 content/checksum 을 낸다(키 순서를 뒤섞지 않으므로).
 */
export function serializeRoomBackupSnapshot(snapshot: RoomBackupSnapshot): { content: string; checksum: string } {
  const content = JSON.stringify(snapshot, null, 2);
  const checksum = createHash("sha256").update(content, "utf8").digest("hex");
  return { content, checksum };
}

export type WriteRoomBackupSnapshotInput = {
  snapshot: RoomBackupSnapshot;
  content: string;
  // 기본값은 이 저장소의 기존 관례(archiveRootDir: sessions/rooms/...)를 따라
  // sessions/rooms/recovery 아래에 방별 폴더를 둔다.
  rootDir?: string;
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
};

/**
 * 스냅샷 JSON 을 로컬 디스크에 쓴다. 이 프로젝트는 단일 운영자 PC에서 전부 돌아가므로
 * storageUri 는 http URL 이 아니라 상대 파일 경로 문자열이다(index.ts 의
 * archiveRootDir 관례와 동일).
 */
export async function writeRoomBackupSnapshotToDisk(
  input: WriteRoomBackupSnapshotInput
): Promise<{ storageUri: string; dir: string }> {
  const rootDir = input.rootDir ?? nodePath.join("sessions", "rooms", "recovery");
  const dir = nodePath.join(rootDir, input.snapshot.roomId);
  const fileName = `${sanitizeForFilename(input.snapshot.capturedAt)}.json`;
  const filePath = nodePath.join(dir, fileName);

  const mkdirImpl = input.mkdir ?? ((path: string) => fsMkdir(path, { recursive: true }).then(() => undefined));
  const writeFileImpl = input.writeFile ?? ((path: string, content: string) => fsWriteFile(path, content, "utf8"));

  await mkdirImpl(dir);
  await writeFileImpl(filePath, input.content);

  return { storageUri: filePath, dir };
}

function sanitizeForFilename(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

// 결함(3차 감사) 대응 — room-backup-scheduler.ts 가 6시간마다 방마다 스냅샷을 새로
// 쓰기만 하고 지우는 로직이 없어, 1년이면 방 하나에 파일이 1,460개(6시간 x 4/일 x 365일)
// 쌓인다. 기본값 240 은 이 저장소의 다른 보존 정책(prune-archived-rows.mjs 의
// HUAI_RETENTION_DAYS 기본 60일)과 맞춘 것이다 — 6시간 간격 x 하루 4회 x 60일 = 240.
// 오래된 대화(outbox/events)와 달리 스냅샷은 "지우면 텔레그램에서 되가져올 수 없는
// 유일한 사본"이 아니라 그보다 새로운 스냅샷이 항상 뒤이어 남으므로, 로그 회전처럼
// 사람 승인 없이(--apply 게이트 없이) 자동으로 정리해도 안전하다.
const DEFAULT_MAX_SNAPSHOTS_PER_ROOM = 240;

export function maxSnapshotsPerRoomFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.HUAI_ROOM_BACKUP_MAX_SNAPSHOTS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SNAPSHOTS_PER_ROOM;
}

// 순수 함수 — 파일명 목록만 보고 지울 대상을 고른다. writeRoomBackupSnapshotToDisk 가
// 파일명을 sanitizeForFilename(capturedAt) 로 짓기 때문에(예: "2026-08-29T00-00-00-000Z.json")
// ISO 8601 문자열의 사전순 정렬이 곧 시간순 정렬과 같다 — 파일을 열어 capturedAt 을
// 다시 파싱할 필요가 없다.
export function filesToPrune(fileNames: readonly string[], maxCount: number): string[] {
  const sorted = [...fileNames].filter((name) => name.endsWith(".json")).sort();
  if (sorted.length <= maxCount) return [];
  return sorted.slice(0, sorted.length - maxCount);
}

export type RoomBackupPrunePorts = {
  readdir?: (path: string) => Promise<string[]>;
  unlink?: (path: string) => Promise<void>;
};

/**
 * 방 하나의 스냅샷 디렉터리에서 최근 maxCount 개를 넘는 오래된 파일을 지운다.
 * best-effort — 디렉터리가 아직 없거나(첫 백업) 개별 파일 삭제가 실패해도 예외를
 * 던지지 않는다. 정리 실패가 백업 자체의 성공 여부에 영향을 주면 안 된다(로그
 * 회전과 같은 원칙 — 부가 기능이 본 기능을 막지 않는다).
 */
export async function pruneRoomBackupSnapshots(
  dir: string,
  maxCount: number,
  ports: RoomBackupPrunePorts = {}
): Promise<string[]> {
  const readdirImpl = ports.readdir ?? ((path: string) => fsReaddir(path));
  const unlinkImpl = ports.unlink ?? ((path: string) => fsUnlink(path));

  let entries: string[];
  try {
    entries = await readdirImpl(dir);
  } catch {
    return [];
  }

  const toDelete = filesToPrune(entries, maxCount);
  const deleted: string[] = [];
  for (const name of toDelete) {
    try {
      await unlinkImpl(nodePath.join(dir, name));
      deleted.push(name);
    } catch {
      // 다음 회차(6시간 뒤)에 다시 시도된다.
    }
  }
  return deleted;
}

// 결함(4차 감사) 대응 — 파일은 pruneRoomBackupSnapshots 로 방당 240개로 정리되지만,
// huai_recovery_snapshots 의 장부 행은 아무도 지우지 않아 무한히 쌓인다(방 5개 x 6시간
// 주기면 연 7,300행). 파일 정리와 다른 정책을 쓰면 "파일은 지워졌는데 장부 행만 남는다"
// 또는 그 반대가 되어 서로 어긋나므로, 같은 상한(maxSnapshotsPerRoomFromEnv)으로 같은
// 시점(새 스냅샷을 성공적으로 기록한 직후)에 정리한다. prune-archived-rows.mjs 의
// outbox/events 와 달리 이 행은 "텔레그램에서 되가져올 수 없는 유일한 사본"이 아니라
// 더 새 스냅샷이 항상 뒤이어 남는 로그 회전 성격이므로(파일 정리 쪽 주석과 동일 근거),
// --apply 같은 사람 승인 게이트 없이 자동으로 지운다.
export type RecoverySnapshotRow = { snapshot_id: string; created_at: string };

// 순수 함수 — filesToPrune 와 같은 원칙. 파일명(ISO 문자열)은 사전순=시간순이라 그대로
// 정렬했지만, DB 행은 created_at 컬럼 문자열을 직접 비교해 오래된 것부터 고른다.
export function recoverySnapshotRowsToPrune(rows: readonly RecoverySnapshotRow[], maxCount: number): string[] {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (sorted.length <= maxCount) return [];
  return sorted.slice(0, sorted.length - maxCount).map((row) => row.snapshot_id);
}

/**
 * 방 하나의 huai_recovery_snapshots(snapshot_type='room') 행 중 최근 maxCount 개를
 * 넘는 오래된 행을 지운다. pruneRoomBackupSnapshots(파일)과 같은 best-effort 원칙 —
 * 조회·삭제가 실패해도 예외를 던지지 않고 빈 배열을 돌려준다. 정리 실패가 백업 자체의
 * 성공 여부에 영향을 주면 안 된다.
 */
export async function pruneRoomBackupSnapshotRows(
  deps: Pick<RoomBackupDeps, "request">,
  roomId: string,
  maxCount: number
): Promise<string[]> {
  try {
    const listResponse = await deps.request(
      "GET",
      `/huai_recovery_snapshots?room_id=eq.${encodeURIComponent(roomId)}&snapshot_type=eq.room&select=snapshot_id,created_at`
    );
    const rows = await listResponse.json<RecoverySnapshotRow[]>();
    const idsToDelete = recoverySnapshotRowsToPrune(rows ?? [], maxCount);
    if (idsToDelete.length === 0) return [];

    const deleteResponse = await deps.request(
      "DELETE",
      `/huai_recovery_snapshots?snapshot_id=in.(${idsToDelete.map((id) => encodeURIComponent(id)).join(",")})`
    );
    await deleteResponse.expectOk();
    return idsToDelete;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ type: "room_backup_snapshot_row_prune_failed", roomId, reason }));
    return [];
  }
}

export type RecordRoomBackupSnapshotResult =
  | { ok: true; snapshotStorageUri: string; checksum: string }
  | { ok: false; reason: string };

/**
 * 조회 → 직렬화 → 디스크 저장 → huai_recovery_snapshots 기록까지 한 번에 처리한다.
 * persistCollectedArtifacts(index.ts) 와 같은 원칙: 복구 부기는 부가 기능이다.
 * 메타데이터 기록 실패(또는 그 이전 어떤 단계의 실패)도 이 함수 밖으로 던지지 않고
 * { ok: false } 로 돌려준다 — 호출부가 이 때문에 죽으면 안 된다. 409(중복)는
 * 정상 성공으로 취급한다.
 *
 * buildRoomBackupSnapshot 은 테이블 단위 부분 실패를 허용하지만, 이 함수는 "전부"
 * 실패한 스냅샷(missingTables 가 대상 테이블 전체를 덮는 경우 — 예: Supabase 자체가
 * 응답하지 않음)은 디스크에 쓰지 않는다. 텅 빈 스냅샷을 "성공한 백업"으로 기록해
 * huai_recovery_snapshots 장부를 오염시키는 것보다는 실패로 보고하는 편이 낫다.
 */
export async function recordRoomBackupSnapshot(
  deps: RoomBackupDeps,
  roomId: string,
  options?: { createdBy?: string }
): Promise<RecordRoomBackupSnapshotResult> {
  try {
    const snapshot = await buildRoomBackupSnapshot(deps, roomId);
    if (snapshot.missingTables.length >= ALL_ROOM_BACKUP_TABLES.length) {
      const reasons = snapshot.missingTables.map((entry) => `${entry.table}:${entry.reason}`).join(";");
      throw new Error(`all-tables-unreachable:${reasons}`);
    }
    const { content, checksum } = serializeRoomBackupSnapshot(snapshot);
    const { storageUri, dir } = await writeRoomBackupSnapshotToDisk({
      snapshot,
      content,
      rootDir: deps.rootDir,
      writeFile: deps.writeFile,
      mkdir: deps.mkdir
    });

    // 결함(3차 감사) 대응 — 새 스냅샷을 쓴 직후, 같은 방 디렉터리에서 보관 상한을
    // 넘는 오래된 파일을 지운다. 쓰기가 성공한 뒤에만 지운다 — 새 스냅샷을 못 남긴
    // 상태에서 옛 것부터 지우면 그 사이 창에 방의 백업이 하나도 없는 순간이 생긴다.
    // 정리 실패(권한 문제 등)는 이 함수의 { ok: true } 결과에 영향을 주지 않는다.
    await pruneRoomBackupSnapshots(dir, deps.maxSnapshotsPerRoom ?? maxSnapshotsPerRoomFromEnv(), {
      readdir: deps.readdir,
      unlink: deps.unlink
    });

    const response = await deps.request("POST", "/huai_recovery_snapshots", {
      body: {
        room_id: roomId,
        task_id: null,
        snapshot_type: "room",
        storage_uri: storageUri,
        checksum,
        created_by: options?.createdBy ?? "operator"
      },
      prefer: "return=minimal"
    });
    if (response.status !== 409) {
      await response.expectOk();
    }

    // 결함(4차 감사) 대응 — 새 장부 행을 쓴 직후(위와 같은 이유로 쓰기가 성공한 뒤에만),
    // 파일 정리와 같은 상한으로 오래된 장부 행을 지운다. 실패해도 { ok: true } 에
    // 영향을 주지 않는다(pruneRoomBackupSnapshotRows 자체가 이미 예외를 삼킨다).
    await pruneRoomBackupSnapshotRows(deps, roomId, deps.maxSnapshotsPerRoom ?? maxSnapshotsPerRoomFromEnv());

    return { ok: true, snapshotStorageUri: storageUri, checksum };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ type: "room_backup_snapshot_failed", roomId, reason }));
    return { ok: false, reason };
  }
}
