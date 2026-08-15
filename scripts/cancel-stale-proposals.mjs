// 결정되지 않고 쌓인 제안을 일괄 취소한다.
//
// 왜 필요한가: 방장이 말할 때마다 제안이 하나씩 생기는데 승인은 그만큼 눌리지 않는다.
// 라이브에서 한 방의 제안 150건 중 결정된 것이 9건뿐이었고, 나머지가 5일치 재고로
// 쌓여 작업판 첫 화면을 122건으로 채웠다. Telegram 은 메시지가 흘러가서 이게 안
// 보였다 — 작업판이 목록으로 쌓아 보여주면서 처음 드러났다.
//
// 왜 삭제가 아니라 취소 기록인가: huai_events 는 append-only 다(huai_events_append_only).
// 제안이 있었다는 사실 자체는 지우면 안 되고, "결정됐다"를 승인 원장에 남기는 것이
// 이 시스템이 이미 쓰는 방식이다.
//
// stage 를 'cancellation' 이 아니라 'task_approval' 로 넣는 이유: 작업판이 미결을
// 가리는 기준이 supabase/functions/miniapp-proposals/deps.ts:35-42 의
// `stage = 'task_approval'` 단일 조건이다. 'cancellation' 으로 넣으면 원장에는
// 남는데 화면에서는 안 사라진다. decision 값은 그 조회가 보지 않으므로 'cancelled'
// 로 남겨 나중에 사람이 읽었을 때 승인과 구분된다.
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const BACKUP_PATH = argValue("--backup");
const REASON = argValue("--reason") ?? "재고 일괄 정리 — 결정되지 않고 누적된 제안";

export function selectStaleProposals(events, decidedEntityRefs) {
  const decided = new Set(decidedEntityRefs);
  const seen = new Set();
  const stale = [];

  for (const row of events) {
    const payload = row.payload;
    if (!payload || typeof payload !== "object") continue;

    // proposalId 가 없는 이벤트는 소대장 기획 요청이다(payload.stage =
    // 'leader_planning_requested'). 작업판이 애초에 안 보여주므로 재고가 아니다.
    const proposalId = typeof payload.proposalId === "string" ? payload.proposalId : undefined;
    if (!proposalId) continue;

    if (decided.has(proposalId)) continue;
    if (seen.has(proposalId)) continue;
    seen.add(proposalId);

    stale.push({
      proposalId,
      roomId: row.room_id,
      title: typeof payload.title === "string" ? payload.title : undefined,
      createdAt: row.created_at
    });
  }

  return stale;
}

export function buildCancellationRows(stale, ownerByRoom, reason) {
  return stale.map((item) => {
    const decider = ownerByRoom.get(item.roomId);
    if (!decider) throw new Error(`owner-not-found:${item.roomId}`);
    return {
      room_id: item.roomId,
      task_id: null,
      stage: "task_approval",
      decision: "cancelled",
      decider_telegram_user_id: decider,
      reason,
      entity_ref: item.proposalId,
      // 재실행해도 같은 제안에 두 번 들어가지 않는다.
      idempotency_key: `bulk-cancel:${item.proposalId}`
    };
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

  const events = await getAll(`${base}/rest/v1/huai_events?select=room_id,payload,created_at&event_type=eq.proposal_created&order=created_at.asc`, headers);
  const approvals = await getAll(`${base}/rest/v1/huai_approvals?select=entity_ref&stage=eq.task_approval`, headers);
  const owners = await getAll(`${base}/rest/v1/huai_room_members?select=room_id,telegram_user_id&role=eq.owner&status=eq.active`, headers);

  const ownerByRoom = new Map(owners.map((row) => [row.room_id, row.telegram_user_id]));
  const stale = selectStaleProposals(events, approvals.map((row) => row.entity_ref).filter(Boolean));

  const byRoom = new Map();
  for (const item of stale) byRoom.set(item.roomId, (byRoom.get(item.roomId) ?? 0) + 1);

  console.log(`proposal_created 이벤트: ${events.length}`);
  console.log(`이미 결정됨: ${approvals.length}`);
  console.log(`정리 대상(미결): ${stale.length}`);
  for (const [roomId, count] of [...byRoom].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${roomId}  ${count}건`);
  }

  if (BACKUP_PATH) {
    writeFileSync(BACKUP_PATH, JSON.stringify(stale, null, 2), "utf8");
    console.log(`백업 기록: ${BACKUP_PATH}`);
  }

  if (!APPLY) {
    console.log("dry-run — 아무것도 쓰지 않았다. 실제로 정리하려면 --apply 를 붙인다.");
    process.exit(0);
  }

  const rows = buildCancellationRows(stale, ownerByRoom, REASON);
  let written = 0;
  for (const chunk of chunks(rows, 200)) {
    const res = await fetch(`${base}/rest/v1/huai_approvals`, {
      method: "POST",
      headers: { ...headers, prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) throw new Error(`insert-failed:${res.status}:${(await res.text()).slice(0, 300)}`);
    written += chunk.length;
    console.log(`  기록 ${written}/${rows.length}`);
  }
  console.log(`정리 완료: ${written}건`);
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

function* chunks(items, size) {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

// PostgREST 는 기본 상한이 있어 한 번에 전부 오지 않는다. 재고를 세는 스크립트가
// 조용히 일부만 보고 "정리 끝"이라고 말하면 안 되므로 끝까지 페이지를 넘긴다.
async function getAll(url, headers, pageSize = 1000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(url, {
      headers: { ...headers, range: `${offset}-${offset + pageSize - 1}`, "range-unit": "items" }
    });
    if (!res.ok) throw new Error(`query-failed:${res.status}:${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}
