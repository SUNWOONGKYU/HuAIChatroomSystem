import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";
import { fileURLToPath as __fileURLToPath } from "node:url";
// 이 저장소의 루트. 개발자 PC 의 절대경로를 박아 두면 다른 PC·다른 체크아웃에서 조용히
// 엉뚱한 곳을 가리킨다 — 스크립트 위치(scripts/)에서 한 단계 올라간 곳이 루트다.
const REPO_ROOT = __fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");

const ROOT = REPO_ROOT;
const proposalId = process.argv[2];
if (!proposalId) throw new Error("usage: node scripts/inspect-live-proposal.mjs <proposal_id>");

const botPid = Number(readFileSync("C:\\tmp\\huai-bot-service.pid", "utf8").trim());
const env = { ...process.env, ...(await readWindowsProcessEnv(botPid)) };
applyOperationEnvAliases(env);

const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
const key = env.SUPABASE_SERVICE_ROLE_KEY;

const eventFilters = [
  `payload->>proposalId.eq.${encodeURIComponent(proposalId)}`,
  `payload->>entityId.eq.${encodeURIComponent(proposalId)}`,
  `payload->>taskId.eq.${encodeURIComponent(proposalId)}`,
  `payload->>targetId.eq.${encodeURIComponent(proposalId)}`
];
if (isUuid(proposalId)) eventFilters.unshift(`task_id.eq.${encodeURIComponent(proposalId)}`);
const events = await get(
  `/huai_events?select=event_type,idempotency_key,payload,created_at&or=(${eventFilters.join(",")})&order=created_at.asc&limit=100`
);
const outbox = await get(
  "/huai_outbox?select=idempotency_key,target_kind,status,last_error,payload,created_at&order=created_at.desc&limit=150"
);
const relatedOutbox = outbox.filter((row) => JSON.stringify(row).includes(proposalId));
const updates = await get(
  "/huai_telegram_updates?select=update_id,status,error,last_error,processed_at,received_at,raw_update&order=received_at.desc&limit=20"
);

console.log(`PROPOSAL ${proposalId}`);
console.log("EVENTS");
for (const row of events) {
  console.log(JSON.stringify({
    at: row.created_at,
    type: row.event_type,
    key: row.idempotency_key,
    payload: row.payload
  }));
}
console.log("OUTBOX");
for (const row of relatedOutbox) {
  console.log(JSON.stringify({
    at: row.created_at,
    target: row.target_kind,
    status: row.status,
    key: row.idempotency_key,
    err: row.last_error,
    botRole: row.payload?.sendMessage?.botRole,
    execution: row.payload?.executionRequest
      ? {
          adapterType: row.payload.executionRequest.adapterType,
          reportBotRole: row.payload.executionRequest.reportBotRole,
          attemptId: row.payload.executionRequest.attemptId
        }
      : undefined
  }));
}
console.log("RECENT_UPDATES");
for (const row of updates.slice(0, 10)) {
  console.log(JSON.stringify({
    at: row.created_at,
    updateId: row.update_id,
    status: row.status,
    error: row.error,
    lastError: row.last_error,
    callback: row.raw_update?.callback_query?.data,
    text: row.raw_update?.message?.text
  }));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function get(path) {
  const response = await fetch(`${baseUrl}/rest/v1${path}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`
    }
  });
  if (!response.ok) throw new Error(`supabase-get-failed:${response.status}:${await response.text()}`);
  return response.json();
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

