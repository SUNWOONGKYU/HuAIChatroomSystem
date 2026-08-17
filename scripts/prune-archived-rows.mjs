// 보관이 끝난 오래된 행을 DB 에서 지운다.
//
// 지우는 것은 통신 기록뿐이다: 텔레그램 원본(raw_update 본문)·아웃박스·이벤트. 이 셋이
// 용량의 대부분이고, 작업 1건에 십수 행씩 쌓인다.
//
// 지우지 않는 것: huai_tasks(현황판 이력), huai_approvals(승인 증거), huai_artifacts(결과물
// 링크), huai_task_reports(실행 결과·감사 보고 전문). 이건 나이와 무관하게 계속 읽힌다.
//
// 삭제 조건 세 가지를 전부 만족해야 한다.
//   1) 그 방·그 날짜가 장부(huai_archive_manifest)에 등재돼 있다 — 백업 없는 삭제를 막는다.
//      "오늘 파일이 생겼나"로 판정하면 PC 가 꺼져 있던 날이 백업 없이 지워진다(Fable 5 지적).
//   2) 보존 기간(기본 60일)이 지났다.
//   3) 방별 최신 40턴이 아니다 — 소대장이 읽는 창이다. 조용한 방은 그 40턴이 전부 기간 밖일
//      수 있는데, 그걸 비우면 방장 눈에는 텔레그램에 대화가 그대로 보이는데 봇만 기억을
//      잃은 상태가 된다.
//
// 기본은 dry-run. --apply 를 붙여야 실제로 지운다.

const DEFAULT_RETENTION_DAYS = 60;
// 소대장이 판단할 때 읽는 창(supabase-store.ts fetchRecentRoomTurns 의 limit=40).
export const PROTECTED_RECENT_TURNS = 40;
// 한 번에 지울 수 있는 최대 행 수. 설계가 잘못돼도 한 번에 다 날아가지는 않게 한다.
const MAX_DELETE_PER_RUN = 2_000;

export function retentionCutoffIso(now, retentionDays) {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60_000).toISOString();
}

// 지워도 되는 아웃박스 행인가. 아직 보낼 것이 남았으면 나이와 무관하게 남긴다 —
// 나이만 보고 지우면 재시도 대기 중이던 메시지가 조용히 사라진다.
export function isTerminalOutboxStatus(status) {
  return status === "sent" || status === "dead";
}

// 장부에 등재된 날짜만 삭제 대상이다.
export function archivedDates(manifestRows, source) {
  return new Set(manifestRows.filter((row) => row.source === source).map((row) => row.archive_date));
}

function kstDate(iso) {
  return new Date(new Date(iso).getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const retentionDays = Number(process.env.HUAI_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing-env:SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const base = url.replace(/\/+$/, "");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const rest = async (query) => {
    const response = await fetch(`${base}/rest/v1${query}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`rest-failed:${response.status}:${(await response.text()).slice(0, 160)}`);
    return await response.json();
  };
  const mutate = async (query, method, body) => {
    const response = await fetch(`${base}/rest/v1${query}`, {
      method,
      headers: { ...headers, prefer: "return=representation" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`mutate-failed:${response.status}:${(await response.text()).slice(0, 160)}`);
    return await response.json();
  };

  const cutoffIso = retentionCutoffIso(new Date(), retentionDays);
  const rooms = await rest("/huai_rooms?status=eq.active&select=room_id,telegram_chat_id,purpose");
  let cleared = 0;
  let deleted = 0;

  for (const room of rooms) {
    const manifests = await rest(
      `/huai_archive_manifest?room_id=eq.${room.room_id}&select=archive_date,source`
    );
    const updateDates = archivedDates(manifests, "telegram_updates");
    const eventDates = archivedDates(manifests, "events");

    // 1) 텔레그램 원본 — 본문만 비운다. 행과 update_id 는 남긴다(같은 메시지 두 번 처리 방지).
    const protectedIds = new Set(
      (await rest(
        `/huai_telegram_updates?telegram_chat_id=eq.${room.telegram_chat_id}` +
          `&select=telegram_bot_id,update_id&order=received_at.desc&limit=${PROTECTED_RECENT_TURNS}`
      )).map((row) => `${row.telegram_bot_id}:${row.update_id}`)
    );

    const oldUpdates = await rest(
      `/huai_telegram_updates?telegram_chat_id=eq.${room.telegram_chat_id}` +
        `&received_at=lt.${encodeURIComponent(cutoffIso)}` +
        `&raw_update=neq.${encodeURIComponent("{}")}` +
        `&select=telegram_bot_id,update_id,received_at&order=received_at.asc&limit=${MAX_DELETE_PER_RUN}`
    );

    for (const row of oldUpdates) {
      if (protectedIds.has(`${row.telegram_bot_id}:${row.update_id}`)) continue;
      if (!updateDates.has(kstDate(row.received_at))) continue;
      cleared += 1;
      if (!apply) continue;
      await mutate(
        `/huai_telegram_updates?telegram_bot_id=eq.${row.telegram_bot_id}&update_id=eq.${row.update_id}`,
        "PATCH",
        { raw_update: {} }
      );
    }

    // 2) 이벤트 — 행 자체를 지운다. 단 방의 최신 승인 이벤트 하나는 남긴다(작업 재개 커서).
    const cursor = await rest(
      `/huai_events?room_id=eq.${room.room_id}&event_type=eq.owner_task_approved&select=event_id&order=created_at.desc&limit=1`
    );
    const cursorId = cursor[0]?.event_id;
    const oldEvents = await rest(
      `/huai_events?room_id=eq.${room.room_id}&created_at=lt.${encodeURIComponent(cutoffIso)}` +
        `&select=event_id,created_at&order=created_at.asc&limit=${MAX_DELETE_PER_RUN}`
    );
    const deletableEvents = oldEvents
      .filter((row) => row.event_id !== cursorId)
      .filter((row) => eventDates.has(kstDate(row.created_at)));

    // 3) 아웃박스 — 보낼 일이 끝난 것만. 재시도 대기 중인 행은 나이와 무관하게 남긴다.
    const oldOutbox = await rest(
      `/huai_outbox?room_id=eq.${room.room_id}&created_at=lt.${encodeURIComponent(cutoffIso)}` +
        `&select=huai_outbox_id,status,created_at&order=created_at.asc&limit=${MAX_DELETE_PER_RUN}`
    );
    const deletableOutbox = oldOutbox
      .filter((row) => isTerminalOutboxStatus(row.status))
      .filter((row) => eventDates.has(kstDate(row.created_at)));

    deleted += deletableEvents.length + deletableOutbox.length;

    if (apply) {
      for (const row of deletableOutbox) {
        await mutate(`/huai_outbox?huai_outbox_id=eq.${row.huai_outbox_id}`, "DELETE");
      }
      // 이벤트는 아웃박스가 참조하므로 나중에 지운다.
      for (const row of deletableEvents) {
        await mutate(`/huai_events?event_id=eq.${row.event_id}`, "DELETE");
      }
    }

    console.log(
      `${apply ? "pruned" : "would-prune"} room=${room.purpose ?? room.room_id}` +
        ` updates=${oldUpdates.length} events=${deletableEvents.length} outbox=${deletableOutbox.length}`
    );
  }

  console.log(`done apply=${apply} retention=${retentionDays}일 cleared=${cleared} deleted=${deleted}`);
  if (!apply) console.log("dry-run 입니다. 실제로 지우려면 --apply 를 붙이세요.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  await main();
}
