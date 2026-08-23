import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkTelegramWebhooks } from "./check-telegram-webhooks.mjs";
import { applyTelegramWebhooks, formatWebhookApplyResults } from "./apply-telegram-webhooks.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const ENV_FILE = resolve(ROOT, ".env.operation.local");
const TUNNEL_PID_FILE = "C:\\tmp\\huai-cloudflared-tunnel.pid";
const LOG_DIR = "C:\\tmp\\huai-logs";
const LOG_FILE = LOG_DIR + "\\webhook-watchdog.log";
const TUNNEL_LOG_FILE = LOG_DIR + "\\cloudflared-tunnel.log";
const CLOUDFLARED_EXE = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";

// 2026-08-23 사고: trycloudflare.com 퀵터널이 5일간 좀비 상태(프로세스는 살아있는데
// 연결만 끊김)로 방치돼 텔레그램 웹훅 4개가 전부 죽었었다. 아무도 감시하지 않아서
// PO가 방에서 버튼을 눌러도 반응이 없어질 때까지 아무도 몰랐다. 이 스크립트는
// 그 상태를 주기 실행(Windows 작업 스케줄러)으로 조기 발견해 스스로 복구한다.
async function runWatchdogCycle() {
  const env = { ...process.env, ...readOperationEnvFile() };
  const publicBaseUrl = env.BOT_SERVICE_PUBLIC_BASE_URL;
  const port = env.BOT_SERVICE_PORT || "8787";

  const tunnelReachable = publicBaseUrl ? await verifyReachable(`${trimSlash(publicBaseUrl)}/healthz`) : false;
  let checks = await checkTelegramWebhooks(env);
  if (tunnelReachable && checks.every((item) => item.ok)) {
    log("healthy — no action");
    return { healed: false, alreadyHealthy: true };
  }

  if (!tunnelReachable) {
    log(`tunnel unreachable (${publicBaseUrl || "unset"}) — restarting cloudflared`);
    stopTrackedTunnel();
    const newUrl = await startTunnel(port);
    log(`new tunnel url=${newUrl}`);
    updatePublicBaseUrl(newUrl);
    env.BOT_SERVICE_PUBLIC_BASE_URL = newUrl;
  } else {
    log("tunnel reachable but webhook registration mismatched — re-applying only");
  }

  const results = await applyTelegramWebhooks(env);
  log(formatWebhookApplyResults(results).replace(/\n/g, " | "));

  checks = await checkTelegramWebhooks(env);
  const ok = checks.every((item) => item.ok);
  log(ok ? "recovered" : `recovery-failed: ${JSON.stringify(checks.filter((item) => !item.ok))}`);
  return { healed: ok, alreadyHealthy: false };
}

export async function verifyReachable(url, timeoutMs = 8000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

// 우리가 띄운 터널만 죽인다 — 이 기계에 다른 목적의 cloudflared(예: 다른 프로젝트 대시보드
// 프록시)가 떠 있을 수 있어서, PID 파일에 없는 프로세스는 절대 건드리지 않는다.
function stopTrackedTunnel() {
  if (!existsSync(TUNNEL_PID_FILE)) return;
  const pid = Number(readFileSync(TUNNEL_PID_FILE, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid);
    log(`stopped previous tracked tunnel pid=${pid}`);
  } catch {
    // 이미 죽어있으면 상관없다.
  }
}

function startTunnel(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    mkdirSync(LOG_DIR, { recursive: true });
    const tunnelLog = openSync(TUNNEL_LOG_FILE, "a");
    const child = spawn(CLOUDFLARED_EXE, ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    writeFileSync(TUNNEL_PID_FILE, String(child.pid));

    let buffer = "";
    let settled = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      buffer += text;
      appendFileSync(tunnelLog, text);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.unref();
        resolvePromise(match[0]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => { if (!settled) { settled = true; rejectPromise(error); } });

    setTimeout(() => {
      if (!settled) { settled = true; rejectPromise(new Error("tunnel-url-timeout")); }
    }, 20000);
  });
}

export function replacePublicBaseUrlLine(text, newUrl) {
  const lines = text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith("BOT_SERVICE_PUBLIC_BASE_URL=")) {
      found = true;
      return `BOT_SERVICE_PUBLIC_BASE_URL=${newUrl}`;
    }
    return line;
  });
  if (!found) next.push(`BOT_SERVICE_PUBLIC_BASE_URL=${newUrl}`);
  return next.join("\n");
}

function updatePublicBaseUrl(newUrl) {
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  writeFileSync(ENV_FILE, replacePublicBaseUrlLine(current, newUrl));
}

function readOperationEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const parsed = {};
  for (const rawLine of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    parsed[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return parsed;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function log(message) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  await runWatchdogCycle();
}
