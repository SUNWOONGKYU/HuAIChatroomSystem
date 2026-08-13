import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const botPid = Number(readFileSync("C:\\tmp\\huai-bot-service.pid", "utf8").trim());
const env = { ...process.env, ...await readWindowsProcessEnv(botPid) };
applyOperationEnvAliases(env);

const rows = await supabaseGet("/huai_outbox?target_kind=eq.local_gateway&select=idempotency_key,status,last_error,payload,created_at&order=created_at.desc&limit=5");
for (const row of rows) {
  console.log(JSON.stringify({
    status: row.status,
    last_error: row.last_error,
    taskId: row.payload?.executionRequest?.taskId,
    created_at: row.created_at
  }));
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
