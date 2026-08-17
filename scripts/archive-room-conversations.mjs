// 방 대화를 하루 단위로 내보내 보관한다.
//
// 왜 필요한가: 텔레그램 봇 API 에는 "채팅 기록 가져오기"가 없다. 봇은 실시간으로 받은 것만
// 알고, DB 에서 지운 대화는 어디서도 되가져올 수 없다 — 사람 눈에는 텔레그램 앱에 그대로
// 보이는데도 그렇다. 그래서 지우기 전에 반드시 내보내 둔다.
//
// 왜 결정적인가(LLM 없음): 요약은 손실 압축이고 조용히 실패할 수 있다. 백업은 그러면 안
// 된다. 이 스크립트는 DB 행을 그대로 jsonl 로 옮기고 끝낸다 — 요약은 별도 단계가 맡고,
// 그쪽이 실패해도 이 결과에는 영향이 없다.
//
// 왜 Supabase Storage 인가: 작업 PC 한 대에만 사본을 두면 그 디스크가 죽는 순간 끝이다.
// Storage 는 DB 용량(500MB)과 별도로 1GB 를 준다.
//
// 멱등: "아직 안 내보낸 날짜 전부"를 찾아 따라잡는다. PC 가 며칠 꺼져 있었어도 다음 실행이
// 밀린 날짜를 모두 처리한다 — 그래서 스케줄이 정확할 필요가 없다.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCES = [
  {
    name: "telegram_updates",
    table: "huai_telegram_updates",
    // 방 식별은 chat_id 로 한다 — 이 표에는 room_id 가 없다.
    select: "telegram_bot_id,update_id,telegram_chat_id,received_at,status,raw_update",
    timeColumn: "received_at"
  },
  {
    name: "events",
    table: "huai_events",
    select: "event_id,room_id,task_id,event_type,idempotency_key,payload,created_at",
    timeColumn: "created_at"
  }
];

// 하루의 경계는 KST 로 자른다. UTC 로 자르면 한국 시간 자정 전후가 다른 날로 갈린다.
const KST_OFFSET_MINUTES = 9 * 60;

export function kstDateString(instant) {
  const shifted = new Date(instant.getTime() + KST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function kstDayRange(dateString) {
  const start = new Date(`${dateString}T00:00:00.000Z`).getTime() - KST_OFFSET_MINUTES * 60_000;
  return { fromIso: new Date(start).toISOString(), toIso: new Date(start + 24 * 60 * 60_000).toISOString() };
}

// 오늘은 아직 끝나지 않았다. 내보내면 반쪽짜리 하루가 장부에 등재되고, 그 등재를 근거로
// 나중에 나머지 절반이 백업 없이 지워진다.
export function pendingDates(rowDates, archivedDates, todayKst) {
  const archived = new Set(archivedDates);
  return [...new Set(rowDates)]
    .filter((date) => date < todayKst && !archived.has(date))
    .sort();
}

function checksumOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

class SupabaseArchiveClient {
  constructor(url, serviceRoleKey, fetchImpl = fetch) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.key = serviceRoleKey;
    this.fetchImpl = fetchImpl;
  }

  headers(extra = {}) {
    return { apikey: this.key, authorization: `Bearer ${this.key}`, ...extra };
  }

  async rest(pathAndQuery) {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${pathAndQuery}`, {
      headers: this.headers({ "content-type": "application/json" }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`rest-failed:${response.status}:${(await response.text()).slice(0, 200)}`);
    return await response.json();
  }

  async insertManifest(row) {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/huai_archive_manifest`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", prefer: "return=minimal" }),
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(30_000)
    });
    // 409 = 같은 (방, 날짜, 표) 가 이미 등재됨. 멱등하게 넘어간다.
    if (response.status === 409) return "duplicate";
    if (!response.ok) throw new Error(`manifest-failed:${response.status}:${(await response.text()).slice(0, 200)}`);
    return "inserted";
  }

  async upload(objectPath, body) {
    const response = await this.fetchImpl(`${this.baseUrl}/storage/v1/object/huai-archive/${objectPath}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/x-ndjson", "x-upsert": "true" }),
      body,
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`upload-failed:${response.status}:${(await response.text()).slice(0, 200)}`);
  }
}

async function fetchRoomRows(client, source, room, fromIso, toIso) {
  const filter = source.name === "telegram_updates"
    ? `telegram_chat_id=eq.${encodeURIComponent(room.telegram_chat_id)}`
    : `room_id=eq.${encodeURIComponent(room.room_id)}`;
  const query =
    `/${source.table}?${filter}` +
    `&${source.timeColumn}=gte.${encodeURIComponent(fromIso)}` +
    `&${source.timeColumn}=lt.${encodeURIComponent(toIso)}` +
    `&select=${encodeURIComponent(source.select)}&order=${source.timeColumn}.asc&limit=5000`;
  return await client.rest(query);
}

async function archiveRoomDay(client, room, source, date, options) {
  const { fromIso, toIso } = kstDayRange(date);
  const rows = await fetchRoomRows(client, source, room, fromIso, toIso);
  if (rows.length === 0) return { skipped: true };

  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const objectPath = `${room.room_id}/${date}_${source.name}.jsonl`;

  if (options.localDir) {
    const dir = path.join(options.localDir, safeRoomFolder(room), date);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${source.name}.jsonl`), body, "utf8");
  }

  if (!options.apply) return { rows: rows.length, objectPath, dryRun: true };

  await client.upload(objectPath, body);
  const result = await client.insertManifest({
    room_id: room.room_id,
    archive_date: date,
    source: source.name,
    row_count: rows.length,
    checksum: checksumOf(body),
    object_path: objectPath,
    byte_size: Buffer.byteLength(body, "utf8")
  });
  return { rows: rows.length, objectPath, manifest: result };
}

// 폴더 이름은 사람이 찾을 수 있어야 한다. uuid 만 있으면 어느 방인지 알 수 없다.
export function safeRoomFolder(room) {
  const label = String(room.purpose ?? "").trim() || room.room_id;
  return label.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing-env:SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const client = new SupabaseArchiveClient(url, key);
  const localDir = process.env.HUAI_ARCHIVE_LOCAL_DIR ?? path.join("sessions", "rooms");
  const todayKst = kstDateString(new Date());

  const rooms = await client.rest("/huai_rooms?status=eq.active&select=room_id,telegram_chat_id,purpose");
  let archived = 0;
  let skipped = 0;

  for (const room of rooms) {
    for (const source of SOURCES) {
      // 이 방·이 표에서 아직 안 내보낸 날짜를 찾는다. 오늘은 제외 — 아직 안 끝난 하루다.
      const filter = source.name === "telegram_updates"
        ? `telegram_chat_id=eq.${encodeURIComponent(room.telegram_chat_id)}`
        : `room_id=eq.${encodeURIComponent(room.room_id)}`;
      const rows = await client.rest(
        `/${source.table}?${filter}&select=${source.timeColumn}&order=${source.timeColumn}.asc&limit=5000`
      );
      const manifests = await client.rest(
        `/huai_archive_manifest?room_id=eq.${encodeURIComponent(room.room_id)}&source=eq.${source.name}&select=archive_date`
      );

      const dates = pendingDates(
        rows.map((row) => kstDateString(new Date(row[source.timeColumn]))),
        manifests.map((row) => row.archive_date),
        todayKst
      );

      for (const date of dates) {
        const result = await archiveRoomDay(client, room, source, date, { apply, localDir });
        if (result.skipped) {
          skipped += 1;
          continue;
        }
        archived += 1;
        console.log(
          `${apply ? "archived" : "would-archive"} room=${safeRoomFolder(room)} date=${date} source=${source.name} rows=${result.rows}`
        );
      }
    }
  }

  console.log(`done apply=${apply} archived=${archived} skipped=${skipped}`);
  if (!apply) console.log("dry-run 입니다. 실제로 올리려면 --apply 를 붙이세요.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  await main();
}
