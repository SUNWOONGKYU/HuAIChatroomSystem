import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const BOT_PID = "C:\\tmp\\huai-bot-service.pid";
const GATEWAY_PID = "C:\\tmp\\huai-local-gateway.pid";

const currentBotPid = readPid(BOT_PID);
const currentGatewayPid = readPid(GATEWAY_PID);
const mergedEnv = {
  ...process.env,
  ...await readWindowsProcessEnv(currentBotPid),
  ...await readWindowsProcessEnv(currentGatewayPid)
};
applyOperationEnvAliases(mergedEnv);
setOperationRuntimeTimeout(mergedEnv);

const errors = validateOperationEnv(mergedEnv, "all");
if (errors.length > 0) {
  console.error("operation-live-env-restart-blocked");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

stopPid(currentBotPid);
stopPid(currentGatewayPid);
rmSync(BOT_PID, { force: true });
rmSync(GATEWAY_PID, { force: true });

const bot = spawn("node", ["dist/apps/bot-service/src/cli.js"], {
  cwd: ROOT,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: mergedEnv
});
bot.unref();
writeFileSync(BOT_PID, String(bot.pid));

const gateway = spawn("node", ["dist/apps/local-gateway/src/cli.js"], {
  cwd: ROOT,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: mergedEnv
});
gateway.unref();
writeFileSync(GATEWAY_PID, String(gateway.pid));

console.log(`bot_service_pid=${bot.pid}`);
console.log(`local_gateway_pid=${gateway.pid}`);

function setOperationRuntimeTimeout(env) {
  const requestedMs = positiveInteger(env.HUAI_OPERATION_RUNTIME_MS) ?? 900000;
  env.BOT_SERVICE_EXECUTION_TIMEOUT_MS = String(requestedMs);
  env.LOCAL_GATEWAY_MAX_RUNTIME_MS = String(requestedMs);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function readPid(path) {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function stopPid(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch {}
}

async function readWindowsProcessEnv(pid) {
  if (!pid || process.platform !== "win32") return {};
  const script = resolve(ROOT, "scripts", "read-windows-process-env.ps1");
  const output = await runPwsh(script, String(pid));
  if (!output.trim()) return {};
  return JSON.parse(output);
}

function runPwsh(script, pid) {
  return new Promise((resolvePromise, rejectPromise) => {
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
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`process-env-read-failed:${code}:${stderr}`));
    });
  });
}
