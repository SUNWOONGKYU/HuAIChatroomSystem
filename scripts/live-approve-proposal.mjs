import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const proposalId = process.argv[2];
if (!proposalId) throw new Error("usage: node scripts/live-approve-proposal.mjs <proposal_id>");

const botPid = Number(readFileSync("C:\\tmp\\huai-bot-service.pid", "utf8").trim());
const env = { ...process.env, ...(await readWindowsProcessEnv(botPid)) };
applyOperationEnvAliases(env);

const botUsername = env.BOT_SERVICE_PLATOON_BOT_USERNAME.replace(/^@/, "");
const stamp = Date.now();
const response = await fetch(`http://127.0.0.1:8787/telegram/webhook/${encodeURIComponent(botUsername)}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-telegram-bot-api-secret-token": env.BOT_SERVICE_PLATOON_WEBHOOK_SECRET
  },
  body: JSON.stringify({
    update_id: stamp,
    callback_query: {
      id: `approve-${stamp}`,
      from: { id: Number(env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID || "52485734"), username: "owner" },
      message: {
        message_id: stamp % 1000000000,
        chat: { id: Number(env.BOT_SERVICE_TELEGRAM_CHAT_ID) }
      },
      data: `proposal:${proposalId}:approve`
    }
  })
});

console.log(await response.text());

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
