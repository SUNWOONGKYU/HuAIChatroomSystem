import { existsSync, statSync } from "node:fs";
import { applyOperationEnvFile } from "./operation-env-loader.mjs";
import {
  BOT_ROLES,
  deriveActors,
  deriveBots,
  deriveGateway,
  required,
  resolveRoomSeedConfig
} from "./room-seed-derivation.mjs";

// 20개 room 을 손으로 SQL 붙여넣기 하지 않고 온보딩하기 위한 실행기다.
// uuid 파생/CLI 인자 해석은 room-seed-derivation.mjs 를 그대로 쓴다 — 여기서
// 다시 계산하면 generate-supabase-room-seed.mjs 가 만드는 SQL 과 값이
// 어긋날 수 있다. PostgREST 의 merge-duplicates 는 컬럼을 통째로 덮어써서
// SQL 의 "do update set <일부 컬럼>" 을 그대로 못 흉내내므로, 봇/게이트웨이는
// 존재 여부를 먼저 조회한 뒤 PATCH(안전한 컬럼만)/POST(신규 전체) 로 나눠 처리한다.
export async function onboardTelegramRoom(env, argv = [], fetchImpl = fetch, fsOps = { existsSync, statSync }) {
  const dryRun = argv.includes("--dry-run");
  const remainingArgv = argv.filter((arg) => arg !== "--dry-run" && arg !== "--json");
  const config = resolveRoomSeedConfig(env, remainingArgv);
  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");

  const steps = [];
  const actors = deriveActors(config.roomId);
  const gateway = deriveGateway(config);
  // 봇은 room 과 무관하게 공유되므로, 다른 room 이 먼저 온보딩한 봇 행은 그 room 의
  // actor_id 를 그대로 갖고 있다(우리가 절대 덮어쓰지 않으므로). 그래서 postverify 는
  // "이 room 이 방금 만든 actor_id" 가 아니라 username 으로 봇을 찾아야 한다 — actor_id 로
  // 찾으면 두 번째 이후 room 은 항상 "bots: expected 4 rows, found 0" 으로 잘못 실패한다.
  const derivedBots = deriveBots(actors, config.env);
  let botsSummary = [];

  // step: validate-project-path (로컬 fs 체크라 dry-run 여부와 무관하게 항상 실행)
  const projectPath = config.projectPath;
  const pathOk = Boolean(projectPath) && fsOps.existsSync(projectPath) && fsOps.statSync(projectPath).isDirectory();
  if (!pathOk) {
    steps.push({
      id: "validate-project-path",
      status: "failed",
      detail: `project path does not exist or is not a directory: ${projectPath || "(not set)"}`
    });
    return { ok: false, dryRun, stoppedAtStep: "validate-project-path", steps, summary: null };
  }
  steps.push({ id: "validate-project-path", status: "ok" });

  // step: precheck-room (읽기 전용이라 dry-run 에서도 실행)
  try {
    const rows = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_rooms?telegram_chat_id=eq.${encodeURIComponent(config.telegramChatId)}&select=room_id`,
      serviceRoleKey
    );
    if (rows.length > 0 && rows[0].room_id !== config.roomId) {
      steps.push({
        id: "precheck-room",
        status: "failed",
        detail: `telegram_chat_id already bound to a different room_id: ${rows[0].room_id}`
      });
      return { ok: false, dryRun, stoppedAtStep: "precheck-room", steps, summary: null };
    }
    steps.push({ id: "precheck-room", status: "ok" });
  } catch (err) {
    steps.push({ id: "precheck-room", status: "failed", detail: sanitize(err.message) });
    return { ok: false, dryRun, stoppedAtStep: "precheck-room", steps, summary: null };
  }

  // step: upsert-room (rooms 는 SQL 의 do update set 에서 제외되는 컬럼이 없으므로
  // merge-duplicates 블라인드 업서트로 충분하다)
  if (dryRun) {
    steps.push({ id: "upsert-room", status: "would-apply" });
  } else {
    try {
      await postUpsert(fetchImpl, `${baseUrl}/rest/v1/huai_rooms?on_conflict=room_id`, serviceRoleKey, {
        room_id: config.roomId,
        telegram_chat_id: config.telegramChatId,
        owner_telegram_user_id: config.ownerTelegramUserId,
        purpose: config.purpose,
        status: "active"
      });
      steps.push({ id: "upsert-room", status: "ok" });
    } catch (err) {
      steps.push({ id: "upsert-room", status: "failed", detail: sanitize(err.message) });
      return { ok: false, dryRun, stoppedAtStep: "upsert-room", steps, summary: buildSummary(config, gateway, botsSummary) };
    }
  }

  // step: upsert-room-member
  if (dryRun) {
    steps.push({ id: "upsert-room-member", status: "would-apply" });
  } else {
    try {
      await postUpsert(
        fetchImpl,
        `${baseUrl}/rest/v1/huai_room_members?on_conflict=room_id,telegram_user_id`,
        serviceRoleKey,
        {
          room_id: config.roomId,
          telegram_user_id: config.ownerTelegramUserId,
          role: "owner",
          permissions: { approve: true, final_approve: true, manage_ai_actors: true },
          status: "active"
        }
      );
      steps.push({ id: "upsert-room-member", status: "ok" });
    } catch (err) {
      steps.push({ id: "upsert-room-member", status: "failed", detail: sanitize(err.message) });
      return {
        ok: false,
        dryRun,
        stoppedAtStep: "upsert-room-member",
        steps,
        summary: buildSummary(config, gateway, botsSummary)
      };
    }
  }

  // step: upsert-actors (actors 도 do update set 제외 컬럼이 없어 블라인드 업서트 가능)
  if (dryRun) {
    steps.push({ id: "upsert-actors", status: "would-apply" });
  } else {
    try {
      // huai_ai_actors 에는 config 컬럼이 없다(schema.sql/라이브 DB 둘 다 없음) — 예전에
      // 여기서 그 컬럼에 값을 실었다가 라이브 온보딩 3건이 upsert-actors 단계에서
      // PGRST204("Could not find the 'config' column")로 전부 실패했다.
      const actorsBody = actors.map((actor) => ({
        actor_id: actor.actorId,
        room_id: config.roomId,
        role: actor.role,
        adapter_type: actor.adapterType,
        status: "active"
      }));
      await postUpsert(fetchImpl, `${baseUrl}/rest/v1/huai_ai_actors?on_conflict=actor_id`, serviceRoleKey, actorsBody);
      steps.push({ id: "upsert-actors", status: "ok" });
    } catch (err) {
      steps.push({ id: "upsert-actors", status: "failed", detail: sanitize(err.message) });
      return { ok: false, dryRun, stoppedAtStep: "upsert-actors", steps, summary: buildSummary(config, gateway, botsSummary) };
    }
  }

  // step: upsert-bots (봇은 room 과 무관하게 공유되므로 actor_id/telegram_bot_id 를
  // 절대 덮어쓰지 않는다 — 존재하면 안전한 컬럼만 PATCH, 없으면 전체 POST)
  try {
    if (dryRun) {
      botsSummary = derivedBots.map((bot) => ({ role: bot.role, username: bot.username, status: "would-apply" }));
      steps.push({ id: "upsert-bots", status: "would-apply" });
    } else {
      for (const bot of derivedBots) {
        const existing = await getJson(
          fetchImpl,
          `${baseUrl}/rest/v1/huai_telegram_bots?bot_username=eq.${encodeURIComponent(bot.username)}&select=telegram_bot_id`,
          serviceRoleKey
        );
        if (existing.length > 0) {
          await patchJson(
            fetchImpl,
            `${baseUrl}/rest/v1/huai_telegram_bots?telegram_bot_id=eq.${encodeURIComponent(existing[0].telegram_bot_id)}`,
            serviceRoleKey,
            {
              role: bot.role,
              token_secret_ref: bot.tokenSecretRef,
              webhook_secret_ref: bot.webhookSecretRef,
              status: "active"
            }
          );
          botsSummary.push({ role: bot.role, username: bot.username, status: "updated" });
        } else {
          await postInsert(fetchImpl, `${baseUrl}/rest/v1/huai_telegram_bots`, serviceRoleKey, {
            telegram_bot_id: bot.botId,
            bot_username: bot.username,
            role: bot.role,
            actor_id: bot.actorId,
            token_secret_ref: bot.tokenSecretRef,
            webhook_secret_ref: bot.webhookSecretRef,
            status: "active"
          });
          botsSummary.push({ role: bot.role, username: bot.username, status: "created" });
        }
      }
      steps.push({ id: "upsert-bots", status: "ok" });
    }
  } catch (err) {
    steps.push({ id: "upsert-bots", status: "failed", detail: sanitize(err.message) });
    return { ok: false, dryRun, stoppedAtStep: "upsert-bots", steps, summary: buildSummary(config, gateway, botsSummary) };
  }

  // step: upsert-gateway (재온보딩이 이미 online 인 게이트웨이를 offline 으로
  // 되돌리면 안 되므로 status 는 PATCH 대상에서 뺀다)
  if (dryRun) {
    steps.push({ id: "upsert-gateway", status: "would-apply" });
  } else {
    try {
      const existing = await getJson(
        fetchImpl,
        `${baseUrl}/rest/v1/huai_gateway_instances?gateway_id=eq.${encodeURIComponent(gateway.gatewayInstanceId)}&select=gateway_id`,
        serviceRoleKey
      );
      if (existing.length > 0) {
        await patchJson(
          fetchImpl,
          `${baseUrl}/rest/v1/huai_gateway_instances?gateway_id=eq.${encodeURIComponent(gateway.gatewayInstanceId)}`,
          serviceRoleKey,
          {
            machine_label: gateway.machineLabel,
            allowed_project_roots: gateway.allowedProjectRoots,
            allowed_adapters: gateway.allowedAdapters
          }
        );
      } else {
        await postInsert(fetchImpl, `${baseUrl}/rest/v1/huai_gateway_instances`, serviceRoleKey, {
          gateway_id: gateway.gatewayInstanceId,
          room_id: config.roomId,
          machine_label: gateway.machineLabel,
          allowed_project_roots: gateway.allowedProjectRoots,
          allowed_adapters: gateway.allowedAdapters,
          status: "offline"
        });
      }
      steps.push({ id: "upsert-gateway", status: "ok" });
    } catch (err) {
      steps.push({ id: "upsert-gateway", status: "failed", detail: sanitize(err.message) });
      return { ok: false, dryRun, stoppedAtStep: "upsert-gateway", steps, summary: buildSummary(config, gateway, botsSummary) };
    }
  }

  // step: postverify
  if (dryRun) {
    steps.push({ id: "postverify", status: "skipped", detail: "dry-run: nothing was written" });
    return { ok: true, dryRun, stoppedAtStep: null, steps, summary: buildSummary(config, gateway, botsSummary) };
  }

  try {
    const roomRows = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_rooms?room_id=eq.${encodeURIComponent(config.roomId)}&select=room_id,telegram_chat_id,owner_telegram_user_id`,
      serviceRoleKey
    );
    const roomOk =
      roomRows.length === 1 &&
      String(roomRows[0].telegram_chat_id) === String(config.telegramChatId) &&
      String(roomRows[0].owner_telegram_user_id) === String(config.ownerTelegramUserId);

    const actorRows = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_ai_actors?room_id=eq.${encodeURIComponent(config.roomId)}&select=actor_id,role`,
      serviceRoleKey
    );
    const expectedRoles = new Set(BOT_ROLES.map(([role]) => role));
    const actorRoles = new Set(actorRows.map((row) => row.role));
    const actorsOk = actorRows.length === 4 && [...expectedRoles].every((role) => actorRoles.has(role));

    // bot_username 으로 조회한다 — actor_id 가 아니다. 봇은 room 과 무관하게 공유되므로,
    // 다른 room 이 먼저 온보딩했다면 이 봇 행은 그 room 의 actor_id 를 여전히 갖고 있다
    // (upsert-bots 가 그걸 절대 덮어쓰지 않으므로). actor_id 로 조회하면 두 번째 이후
    // room 은 항상 못 찾는다.
    const usernameList = derivedBots.map((bot) => bot.username).join(",");
    const botRows = usernameList
      ? await getJson(
          fetchImpl,
          `${baseUrl}/rest/v1/huai_telegram_bots?bot_username=in.(${usernameList})&select=telegram_bot_id,role,bot_username`,
          serviceRoleKey
        )
      : [];
    const botsOk = botRows.length === 4;

    const gatewayRows = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_gateway_instances?room_id=eq.${encodeURIComponent(config.roomId)}&select=gateway_id,status`,
      serviceRoleKey
    );
    const gatewayOk = gatewayRows.length >= 1;

    const summary = buildSummary(config, gateway, botsSummary);

    if (roomOk && actorsOk && botsOk && gatewayOk) {
      steps.push({ id: "postverify", status: "ok" });
      return { ok: true, dryRun, stoppedAtStep: null, steps, summary };
    }

    const problems = [];
    if (!roomOk) problems.push(`room: expected 1 matching row, found ${roomRows.length}`);
    if (!actorsOk) {
      problems.push(
        `actors: expected 4 rows covering roles [${[...expectedRoles].join(",")}], found ${actorRows.length} row(s) with roles [${[...actorRoles].join(",")}]`
      );
    }
    if (!botsOk) problems.push(`bots: expected 4 rows, found ${botRows.length}`);
    if (!gatewayOk) problems.push(`gateway: expected at least 1 row, found ${gatewayRows.length}`);
    steps.push({ id: "postverify", status: "failed", detail: problems.join("; ") });
    return { ok: false, dryRun, stoppedAtStep: "postverify", steps, summary };
  } catch (err) {
    steps.push({ id: "postverify", status: "failed", detail: sanitize(err.message) });
    return {
      ok: false,
      dryRun,
      stoppedAtStep: "postverify",
      steps,
      summary: buildSummary(config, gateway, botsSummary)
    };
  }
}

function buildSummary(config, gateway, bots) {
  return {
    roomId: config.roomId,
    telegramChatId: config.telegramChatId,
    ownerTelegramUserId: config.ownerTelegramUserId,
    projectPath: config.projectPath,
    gatewayId: gateway.gatewayInstanceId,
    bots
  };
}

export function formatOnboardResult(result, asJson) {
  if (asJson) return JSON.stringify(result, null, 2);

  const lines = [];
  for (const step of result.steps) {
    const detail = step.detail ? ` detail=${step.detail}` : "";
    lines.push(`step id=${step.id} status=${step.status}${detail}`);
  }
  lines.push(`summary: ok=${result.ok} dry_run=${result.dryRun} stopped_at=${result.stoppedAtStep ?? "none"}`);
  if (result.summary) {
    const s = result.summary;
    lines.push(`room_id=${s.roomId}`);
    lines.push(`telegram_chat_id=${s.telegramChatId}`);
    lines.push(`owner_telegram_user_id=${s.ownerTelegramUserId}`);
    lines.push(`project_path=${s.projectPath}`);
    lines.push(`gateway_id=${s.gatewayId}`);
    for (const bot of s.bots) {
      lines.push(`bot role=${bot.role} username=${bot.username} status=${bot.status}`);
    }
  }
  if (result.error) lines.push(`error=${result.error}`);
  lines.push("next: node scripts/telegram-connection-sequence.mjs");
  return lines.join("\n");
}

async function getJson(fetchImpl, url, serviceRoleKey) {
  const response = await fetchImpl(url, { method: "GET", headers: authHeaders(serviceRoleKey) });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
  return response.json();
}

async function patchJson(fetchImpl, url, serviceRoleKey, body) {
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: { ...authHeaders(serviceRoleKey), prefer: "return=minimal" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
}

// on_conflict 대상 테이블(rooms/room_members/actors) 전용 — merge-duplicates 는
// 요청 본문에 있는 컬럼을 전부 덮어쓴다. 봇/게이트웨이처럼 일부 컬럼을 보호해야
// 하면 이 함수를 쓰지 말고 존재 조회 후 postInsert/patchJson 으로 나눠 처리한다.
async function postUpsert(fetchImpl, url, serviceRoleKey, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { ...authHeaders(serviceRoleKey), prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
}

async function postInsert(fetchImpl, url, serviceRoleKey, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { ...authHeaders(serviceRoleKey), prefer: "return=minimal" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
}

function authHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json"
  };
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function sanitize(value) {
  return String(value)
    .replace(/service_role_[A-Za-z0-9_-]+/g, "service_role_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  applyOperationEnvFile(process.env);
  const asJson = process.argv.includes("--json");
  const result = await onboardTelegramRoom(process.env, process.argv.slice(2));
  console.log(formatOnboardResult(result, asJson));
  if (!result.ok) process.exit(1);
}
