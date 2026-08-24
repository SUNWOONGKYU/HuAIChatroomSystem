import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const botPid = Number(readFileSync("C:\\tmp\\huai-bot-service.pid", "utf8").trim());
const env = { ...process.env, ...await readWindowsProcessEnv(botPid) };
applyOperationEnvAliases(env);

const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BOT_SERVICE_LEADER_BOT_USERNAME",
  "BOT_SERVICE_LEADER_WEBHOOK_SECRET",
  "BOT_SERVICE_TELEGRAM_CHAT_ID"
];
for (const key of required) if (!env[key]) throw new Error(`missing-live-env:${key}`);

const stamp = Date.now();
const prompt = `formal smoke OK ${stamp}`;
const botUsername = String(env.BOT_SERVICE_LEADER_BOT_USERNAME).replace(/^@/, "");
const roomInfo = await loadRoomInfo();
const chatId = Number(env.BOT_SERVICE_TELEGRAM_CHAT_ID ?? roomInfo.telegramChatId);
const ownerId = Number(env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID ?? roomInfo.ownerTelegramUserId);
const secret = env.BOT_SERVICE_LEADER_WEBHOOK_SECRET;

const commandAck = await postWebhook(botUsername, secret, {
  update_id: stamp,
  message: {
    message_id: stamp % 1000000000,
    chat: { id: chatId },
    from: { id: ownerId, is_bot: false, username: "owner" },
    text: `/newtask@${botUsername} ${prompt}`
  }
});
console.log(`command_ack=${JSON.stringify(commandAck)}`);

const proposal = await waitForProposal(prompt, 15000);
console.log(`proposal_id=${proposal.proposalId}`);

const callbackAck = await postWebhook(botUsername, secret, {
  update_id: stamp + 1,
  callback_query: {
    id: `smoke-callback-${stamp}`,
    from: { id: ownerId, username: "owner" },
    message: {
      message_id: (stamp + 1) % 1000000000,
      chat: { id: chatId }
    },
    data: `proposal:${proposal.proposalId}:approve`
  }
});
console.log(`callback_ack=${JSON.stringify(callbackAck)}`);

const approved = await waitForApproval(proposal.proposalId, 15000);
console.log(`approval_event=${approved ? "found" : "missing"}`);
const outbox = await waitForOutbox(proposal.proposalId, 180000);
console.log(`local_gateway_outbox=${outbox.status}`);
console.log("formal_smoke_done");

async function loadRoomInfo() {
  const roomSelector = env.BOT_SERVICE_ROOM_ID
    ? `room_id=eq.${encodeURIComponent(env.BOT_SERVICE_ROOM_ID)}`
    : `telegram_chat_id=eq.${encodeURIComponent(env.BOT_SERVICE_TELEGRAM_CHAT_ID)}`;
  const rooms = await supabaseGet(`/huai_rooms?${roomSelector}&select=room_id,telegram_chat_id,owner_telegram_user_id&limit=1`);
  const room = rooms[0];
  if (!room) throw new Error("smoke-room-not-found");
  let ownerTelegramUserId = room.owner_telegram_user_id;
  if (!ownerTelegramUserId) {
    const members = await supabaseGet(`/huai_room_members?room_id=eq.${encodeURIComponent(room.room_id)}&role=eq.owner&status=eq.active&select=telegram_user_id&limit=1`);
    ownerTelegramUserId = members[0]?.telegram_user_id;
  }
  if (!ownerTelegramUserId) throw new Error("smoke-owner-not-found");
  return { telegramChatId: room.telegram_chat_id, ownerTelegramUserId };
}

async function postWebhook(username, webhookSecret, payload) {
  const response = await fetch(`http://127.0.0.1:8787/telegram/webhook/${encodeURIComponent(username)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": webhookSecret
    },
    body: JSON.stringify(payload)
  });
  return response.json();
}

async function waitForProposal(rawText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await supabaseGet("/huai_events?event_type=eq.proposal_created&select=payload,created_at&order=created_at.desc&limit=50");
    const found = rows.find((row) => row.payload?.rawText === rawText && typeof row.payload?.proposalId === "string");
    if (found) return { proposalId: found.payload.proposalId };
    await sleep(500);
  }
  throw new Error("proposal-not-found");
}

async function waitForApproval(proposalId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await supabaseGet("/huai_events?event_type=eq.owner_task_approved&select=payload,created_at&order=created_at.desc&limit=100");
    const found = rows.find((row) => row.payload?.targetId === proposalId || row.payload?.taskId === proposalId || row.payload?.entityId === proposalId);
    if (found) return true;
    await sleep(500);
  }
  return false;
}

async function waitForOutbox(proposalId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await supabaseGet("/huai_outbox?target_kind=eq.local_gateway&select=idempotency_key,status,last_error,payload,created_at&order=created_at.desc&limit=50");
    const found = rows.find((row) => row.payload?.executionRequest?.taskId === proposalId);
    if (found && ["sent", "dead", "failed", "retry_pending"].includes(found.status)) return found;
    await sleep(1000);
  }
  throw new Error("local-gateway-outbox-timeout");
}

async function supabaseGet(path) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!response.ok) throw new Error(`supabase-get-failed:${response.status}`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readWindowsProcessEnv(pid) {
  const script = resolve(ROOT, "scripts", "read-windows-process-env.ps1");
  const output = await runPwsh(script, String(pid));
  return JSON.parse(output || "{}");
}

function runPwsh(script, pid) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, pid], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => code === 0 ? resolveRun(stdout) : rejectRun(new Error(`process-env-read-failed:${code}:${stderr}`)));
  });
}
