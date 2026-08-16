import { applyOperationEnvFile } from "./operation-env-loader.mjs";

// huai_room_members 에 비오너 인간 멤버 행을 upsert 한다.
// on_conflict=room_id,telegram_user_id 로 이미 있으면 permissions/status 만 갱신.
//
// 사용법:
//   node scripts/add-room-member.mjs <room_id> <telegram_user_id> [--dry-run] [--json]
//
// 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (또는 .env.operation)

function required(env, key) {
  const val = env[key];
  if (!val) throw new Error(`환경변수 미설정: ${key}`);
  return val;
}

function authHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json"
  };
}

function sanitize(value) {
  return String(value)
    .replace(/service_role_[A-Za-z0-9_-]+/g, "service_role_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

async function getJson(url, serviceRoleKey) {
  const res = await fetch(url, { method: "GET", headers: authHeaders(serviceRoleKey) });
  if (!res.ok) throw new Error(`supabase-rest-error:${res.status}:${sanitize(await res.text())}`);
  return res.json();
}

async function postUpsert(url, serviceRoleKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(serviceRoleKey), prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`supabase-rest-error:${res.status}:${sanitize(await res.text())}`);
}

export async function addRoomMember(env, argv = []) {
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((a) => !a.startsWith("--"));

  if (args.length < 2) {
    return { ok: false, error: "인자 부족 — 사용법: node scripts/add-room-member.mjs <room_id> <telegram_user_id> [--dry-run] [--json]" };
  }

  const roomId = args[0];
  const telegramUserId = args[1];

  if (!/^[0-9a-f-]{36}$/.test(roomId)) {
    return { ok: false, error: `room_id 형식 오류 (UUID 필요): ${roomId}` };
  }
  if (!/^\d+$/.test(telegramUserId)) {
    return { ok: false, error: `telegram_user_id 형식 오류 (숫자 ID 필요): ${telegramUserId}` };
  }

  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");

  const steps = [];

  // step: precheck-room
  try {
    const rows = await getJson(
      `${baseUrl}/rest/v1/huai_rooms?room_id=eq.${encodeURIComponent(roomId)}&select=room_id,status`,
      serviceRoleKey
    );
    if (rows.length === 0) {
      steps.push({ id: "precheck-room", status: "failed", detail: `room_id 없음: ${roomId}` });
      return { ok: false, dryRun, stoppedAtStep: "precheck-room", steps };
    }
    if (rows[0].status !== "active") {
      steps.push({ id: "precheck-room", status: "failed", detail: `room status=${rows[0].status} (active 아님)` });
      return { ok: false, dryRun, stoppedAtStep: "precheck-room", steps };
    }
    steps.push({ id: "precheck-room", status: "ok" });
  } catch (err) {
    steps.push({ id: "precheck-room", status: "failed", detail: sanitize(err.message) });
    return { ok: false, dryRun, stoppedAtStep: "precheck-room", steps };
  }

  // step: check-existing-member (owner 로 이미 등록된 경우 경고)
  try {
    const rows = await getJson(
      `${baseUrl}/rest/v1/huai_room_members?room_id=eq.${encodeURIComponent(roomId)}&telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&select=role,status`,
      serviceRoleKey
    );
    if (rows.length > 0 && rows[0].role === "owner") {
      steps.push({ id: "check-existing-member", status: "failed", detail: `telegram_user_id ${telegramUserId} 는 이미 owner 로 등록됨 — human_member 덮어쓰기 금지` });
      return { ok: false, dryRun, stoppedAtStep: "check-existing-member", steps };
    }
    const existing = rows.length > 0 ? `role=${rows[0].role},status=${rows[0].status}` : "없음";
    steps.push({ id: "check-existing-member", status: "ok", detail: `기존 행: ${existing}` });
  } catch (err) {
    steps.push({ id: "check-existing-member", status: "failed", detail: sanitize(err.message) });
    return { ok: false, dryRun, stoppedAtStep: "check-existing-member", steps };
  }

  // step: upsert-member
  if (dryRun) {
    steps.push({ id: "upsert-member", status: "would-apply", detail: `room_id=${roomId} telegram_user_id=${telegramUserId} role=human_member status=active` });
  } else {
    try {
      await postUpsert(
        `${baseUrl}/rest/v1/huai_room_members?on_conflict=room_id,telegram_user_id`,
        serviceRoleKey,
        {
          room_id: roomId,
          telegram_user_id: telegramUserId,
          role: "human_member",
          permissions: { approve: false, final_approve: false, manage_ai_actors: false },
          status: "active"
        }
      );
      steps.push({ id: "upsert-member", status: "ok" });
    } catch (err) {
      steps.push({ id: "upsert-member", status: "failed", detail: sanitize(err.message) });
      return { ok: false, dryRun, stoppedAtStep: "upsert-member", steps };
    }
  }

  // step: postverify
  if (dryRun) {
    steps.push({ id: "postverify", status: "skipped", detail: "dry-run: nothing was written" });
  } else {
    try {
      const rows = await getJson(
        `${baseUrl}/rest/v1/huai_room_members?room_id=eq.${encodeURIComponent(roomId)}&telegram_user_id=eq.${encodeURIComponent(telegramUserId)}&select=role,status`,
        serviceRoleKey
      );
      const ok = rows.length === 1 && rows[0].role === "human_member" && rows[0].status === "active";
      if (ok) {
        steps.push({ id: "postverify", status: "ok" });
      } else {
        steps.push({ id: "postverify", status: "failed", detail: `예상: role=human_member,status=active / 실제: ${JSON.stringify(rows[0] ?? {})}` });
        return { ok: false, dryRun, stoppedAtStep: "postverify", steps };
      }
    } catch (err) {
      steps.push({ id: "postverify", status: "failed", detail: sanitize(err.message) });
      return { ok: false, dryRun, stoppedAtStep: "postverify", steps };
    }
  }

  return { ok: true, dryRun, stoppedAtStep: null, steps, roomId, telegramUserId };
}

export function formatAddMemberResult(result, asJson) {
  if (asJson) return JSON.stringify(result, null, 2);
  const lines = [];
  for (const step of result.steps ?? []) {
    const detail = step.detail ? ` detail=${step.detail}` : "";
    lines.push(`step id=${step.id} status=${step.status}${detail}`);
  }
  if (result.error) {
    lines.push(`error=${result.error}`);
  } else {
    lines.push(`summary: ok=${result.ok} dry_run=${result.dryRun} stopped_at=${result.stoppedAtStep ?? "none"}`);
    if (result.ok && !result.dryRun) {
      lines.push(`등록 완료 — room_id=${result.roomId} telegram_user_id=${result.telegramUserId} role=human_member status=active`);
      lines.push("next: 미니앱에서 해당 계정으로 접근 재시도");
    }
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  applyOperationEnvFile(process.env);
  const asJson = process.argv.includes("--json");
  const result = await addRoomMember(process.env, process.argv.slice(2));
  console.log(formatAddMemberResult(result, asJson));
  if (!result.ok) process.exit(1);
}
