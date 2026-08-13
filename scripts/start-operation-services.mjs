import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { applyOperationEnvFile } from "./operation-env-loader.mjs";
import { applyTelegramWebhooks, formatWebhookApplyResults } from "./apply-telegram-webhooks.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const BOT_PID = "C:\\tmp\\huai-bot-service.pid";
const GATEWAY_PID = "C:\\tmp\\huai-local-gateway.pid";

const loadedEnv = applyOperationEnvFile(process.env, process.env.OPERATION_ENV_FILE);
if (loadedEnv.loaded) console.log(`operation_env_file_loaded keys=${loadedEnv.keys.length}`);

for (const role of ["PLATOON", "CLAUDE", "CODEX", "AUDITOR"]) {
  const key = `BOT_SERVICE_${role}_WEBHOOK_SECRET`;
  if (!process.env[key]) process.env[key] = randomBytes(48).toString("hex");
}

const errors = validateOperationEnv(process.env, "all");
if (errors.length > 0) {
  console.error("operation-start-blocked");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

stopExistingOperationProcesses();

const webhookResults = await applyTelegramWebhooks(process.env);
console.log(formatWebhookApplyResults(webhookResults));
if (webhookResults.some((item) => !item.ok)) process.exit(1);

for (const path of [BOT_PID, GATEWAY_PID]) {
  rmSync(path, { force: true });
}

const bot = spawn("node", ["dist/apps/bot-service/src/cli.js"], {
  cwd: ROOT,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: process.env
});
bot.unref();
writeFileSync(BOT_PID, String(bot.pid));

const gateway = spawn("node", ["dist/apps/local-gateway/src/cli.js"], {
  cwd: ROOT,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: process.env
});
gateway.unref();
writeFileSync(GATEWAY_PID, String(gateway.pid));

console.log(`bot_service_pid=${bot.pid}`);
console.log(`local_gateway_pid=${gateway.pid}`);

function stopExistingOperationProcesses() {
  for (const pidPath of [BOT_PID, GATEWAY_PID]) {
    if (!existsSync(pidPath)) continue;
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch {}
    }
  }
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dist/apps/(bot-service|local-gateway)/src/cli.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { cwd: ROOT, windowsHide: true, stdio: "ignore" });
  }
}