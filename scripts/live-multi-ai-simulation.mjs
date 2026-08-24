import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const BOT_SERVICE_URL = "http://127.0.0.1:8787";
const botPid = Number(readFileSync("C:\\tmp\\huai-bot-service.pid", "utf8").trim());
const env = { ...process.env, ...(await readWindowsProcessEnv(botPid)) };
applyOperationEnvAliases(env);

const baseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const botUsername = required("BOT_SERVICE_LEADER_BOT_USERNAME").replace(/^@/, "");
const webhookSecret = required("BOT_SERVICE_LEADER_WEBHOOK_SECRET");
const chatId = Number(required("BOT_SERVICE_TELEGRAM_CHAT_ID"));
const ownerId = Number(env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID || "52485734");
const stamp = Date.now();
const rawText =
  process.argv.slice(2).join(" ").trim() ||
  `simulation ${stamp}: ClaudeBot and CodexBot each reply exactly OK, then AuditBot verifies both results are OK`;

console.log(`SIM_START ${stamp}`);

const messageAck = await postWebhook({
  update_id: stamp,
  message: {
    message_id: stamp % 1000000000,
    chat: { id: chatId },
    from: { id: ownerId, is_bot: false, username: "owner" },
    text: `@${botUsername} ${rawText}`
  }
});
console.log(`MESSAGE_ACK ${JSON.stringify(messageAck)}`);

const proposal = await waitFor("proposal", async () => {
  const rows = await supabaseGet(
    "/huai_events?event_type=eq.proposal_created&select=payload,created_at&order=created_at.desc&limit=80"
  );
  return rows.find((row) => row.payload?.rawText === rawText)?.payload;
}, 30_000, 500);
console.log(`PROPOSAL ${proposal.proposalId} intent=${proposal.intent}`);

const approvalAck = await postWebhook({
  update_id: stamp + 1,
  callback_query: {
    id: `sim-callback-${stamp}`,
    from: { id: ownerId, username: "owner" },
    message: {
      message_id: (stamp + 1) % 1000000000,
      chat: { id: chatId }
    },
    data: `proposal:${proposal.proposalId}:approve`
  }
});
console.log(`APPROVE_ACK ${JSON.stringify(approvalAck)}`);

await waitFor("approval-event", async () => {
  const rows = await supabaseGet(
    "/huai_events?event_type=eq.owner_task_approved&select=payload,created_at&order=created_at.desc&limit=100"
  );
  return rows.find(
    (row) => row.payload?.taskId === proposal.proposalId || row.payload?.targetId === proposal.proposalId || row.payload?.entityId === proposal.proposalId
  );
}, 30_000, 500);
console.log("APPROVAL_EVENT found");

const workerRows = await waitFor("two-worker-outbox", async () => {
  const rows = await supabaseGet(
    "/huai_outbox?target_kind=eq.local_gateway&select=idempotency_key,status,last_error,payload,created_at&order=created_at.desc&limit=100"
  );
  const hits = rows.filter(
    (row) =>
      row.payload?.executionRequest?.taskId === proposal.proposalId &&
      /:claude$|:codex$/.test(row.idempotency_key)
  );
  return hits.length >= 2 ? hits : null;
}, 30_000, 1000);
console.log(`WORKER_ROWS ${workerRows.map((row) => `${row.idempotency_key.split(":").pop()}:${row.status}`).join(",")}`);

await waitFor("worker-completed-events", async () => {
  const rows = await supabaseGet(
    "/huai_events?event_type=eq.meaningful_intermediate_ready&select=payload,created_at&order=created_at.desc&limit=200"
  );
  const hits = rows.filter((row) => row.payload?.taskId === proposal.proposalId && row.payload?.status === "completed");
  const suffixes = new Set(hits.map((row) => String(row.payload?.attemptId || "").split("-").pop()));
  return suffixes.has("claude") && suffixes.has("codex") ? hits : null;
}, 300_000, 2000);
console.log("WORKERS_COMPLETED");

const auditRow = await waitFor("audit-row", async () => {
  const rows = await supabaseGet(
    "/huai_outbox?target_kind=eq.local_gateway&select=idempotency_key,status,last_error,payload,created_at&order=created_at.desc&limit=100"
  );
  return rows.find(
    (row) =>
      row.payload?.executionRequest?.taskId === proposal.proposalId &&
      String(row.idempotency_key).includes("multi-ai-audit")
  );
}, 120_000, 1000);
console.log(`AUDIT_ROW ${auditRow.status} ${auditRow.idempotency_key}`);

const auditAttemptId = auditRow.payload?.executionRequest?.attemptId;
const auditReport = await waitFor("audit-report", async () => {
  const rows = await supabaseGet(
    "/huai_outbox?target_kind=eq.telegram_bot&select=idempotency_key,status,last_error,payload,created_at&order=created_at.desc&limit=100"
  );
  return rows.find(
    (row) =>
      row.idempotency_key === `telegram-report:${auditAttemptId}:completed` &&
      row.status === "sent"
  );
}, 180_000, 2000);
console.log(
  `AUDIT_REPORT ${auditReport.status} text=${String(auditReport.payload?.sendMessage?.text || auditReport.payload?.text || "")
    .replace(/\s+/g, " ")
    .slice(0, 700)}`
);

const recent = await supabaseGet(
  "/huai_outbox?select=status,last_error,target_kind,idempotency_key,created_at&order=created_at.desc&limit=20"
);
const problems = recent.filter(
  (row) => ["pending", "processing", "retry_pending", "dead", "failed"].includes(row.status) || row.last_error
);
console.log(
  `RECENT_PROBLEMS ${JSON.stringify(
    problems.map((row) => ({
      status: row.status,
      target: row.target_kind,
      key: String(row.idempotency_key).slice(0, 90),
      err: row.last_error
    }))
  )}`
);
console.log(`SIM_DONE ${proposal.proposalId}`);

async function postWebhook(payload) {
  const response = await fetch(`${BOT_SERVICE_URL}/telegram/webhook/${encodeURIComponent(botUsername)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": webhookSecret
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`webhook-failed:${response.status}:${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function supabaseGet(path) {
  const response = await fetch(`${baseUrl}/rest/v1${path}`, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`
    }
  });
  if (!response.ok) throw new Error(`supabase-get-failed:${response.status}:${await response.text()}`);
  return response.json();
}

async function waitFor(name, callback, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error(`timeout:${name}`);
}

function required(key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

async function readWindowsProcessEnv(pid) {
  const script = resolve(ROOT, "scripts", "read-windows-process-env.ps1");
  return new Promise((resolveRead, rejectRead) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, String(pid)], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolveRead(JSON.parse(stdout || "{}"));
      else rejectRead(new Error(`process-env-read-failed:${code}:${stderr}`));
    });
  });
}

