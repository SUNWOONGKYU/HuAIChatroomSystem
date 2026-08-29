import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { applyOperationEnvFile } from "./operation-env-loader.mjs";
import { applyTelegramWebhooks, formatWebhookApplyResults } from "./apply-telegram-webhooks.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";
import { fileURLToPath as __fileURLToPath } from "node:url";
// 이 저장소의 루트. 개발자 PC 의 절대경로를 박아 두면 다른 PC·다른 체크아웃에서 조용히
// 엉뚱한 곳을 가리킨다 — 스크립트 위치(scripts/)에서 한 단계 올라간 곳이 루트다.
const REPO_ROOT = __fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");

const ROOT = REPO_ROOT;
const BOT_PID = "C:\\tmp\\huai-bot-service.pid";
const GATEWAY_PID = "C:\\tmp\\huai-local-gateway.pid";

const loadedEnv = applyOperationEnvFile(process.env, process.env.OPERATION_ENV_FILE);
if (loadedEnv.loaded) console.log(`operation_env_file_loaded keys=${loadedEnv.keys.length}`);

for (const role of ["LEADER", "CLAUDE", "CODEX", "AUDITOR"]) {
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