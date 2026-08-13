import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const botPid = Number(readFileSync("C:\\tmp\\huai-bot-service.pid", "utf8").trim());
const env = { ...process.env, ...(await readWindowsProcessEnv(botPid)) };
applyOperationEnvAliases(env);

const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const rows = await get(
  "/huai_outbox?target_kind=eq.telegram_bot&select=idempotency_key,status,last_error,payload,created_at&order=created_at.desc&limit=80"
);

for (const row of rows.filter(isAuditorReport).slice(0, 20)) {
  console.log(
    JSON.stringify({
      at: row.created_at,
      key: row.idempotency_key,
      status: row.status,
      err: row.last_error,
      botRole: row.payload?.sendMessage?.botRole,
      text: String(row.payload?.sendMessage?.text || row.payload?.text || "").replace(/\s+/g, " ").slice(0, 700)
    })
  );
}

function isAuditorReport(row) {
  return row.payload?.sendMessage?.botRole === "auditor" || String(row.idempotency_key).includes("telegram-report:");
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
