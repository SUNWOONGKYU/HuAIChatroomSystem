import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";

const ROOT = "C:\\Dev\\HuAIChatroomSystem";
const BOT_PID = "C:\\tmp\\huai-bot-service.pid";
const GATEWAY_PID = "C:\\tmp\\huai-local-gateway.pid";
const LOG_DIR = "C:\\tmp\\huai-logs";
const BOT_LOG = LOG_DIR + "\\bot-service.log";
const GATEWAY_LOG = LOG_DIR + "\\local-gateway.log";

// 이 파일은 순수 함수도 함께 내보낸다. 실행부를 top-level 에 두면 테스트가 import 하는
// 순간 라이브 서비스를 죽였다 살린다 — 그래서 CLI 로 직접 부를 때만 돌게 가둔다.
async function restartOperationServices() {
  // PID 파일은 단서지 진실이 아니다.
  //
  // 라이브에서 파일에는 41020/32880 이 적혀 있었는데 실제로 도는 건 16176/6076 이었다
  // (파일을 쓴 프로세스가 죽고 다른 경로로 재기동된 흔적). 그 상태로 이 스크립트를
  // 돌리면 죽은 PID 를 죽이려다 조용히 실패하고, 살아 있는 봇은 그대로 둔 채 새 봇을
  // 하나 더 띄운다 — bot-service 가 둘이면 같은 Telegram 업데이트를 두 번 처리한다.
  //
  // 그래서 실제로 도는 프로세스를 명령줄로 찾아 파일 값과 합집합으로 다룬다. 조회가
  // 실패해도 파일 값은 남으므로 이전보다 나빠지지 않는다.
  const discovered = await discoverServicePids();
  const botPids = mergePidSources(readPid(BOT_PID), discovered.botService);
  const gatewayPids = mergePidSources(readPid(GATEWAY_PID), discovered.localGateway);

  const mergedEnv = {
    ...process.env,
    ...await readWindowsProcessEnv(botPids[0]),
    ...await readWindowsProcessEnv(gatewayPids[0])
  };
  applyOperationEnvAliases(mergedEnv);
  setOperationRuntimeTimeout(mergedEnv);

  const errors = validateOperationEnv(mergedEnv, "all");
  if (errors.length > 0) {
    console.error("operation-live-env-restart-blocked");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  for (const pid of [...botPids, ...gatewayPids]) stopPid(pid);

  // 종료를 확인하고 나서 띄운다. process.kill 은 요청일 뿐이라 즉시 죽지 않는데,
  // 확인 없이 새로 띄우면 겹치는 순간이 생긴다 — 이 스크립트가 막으려는 그 상태다.
  const survivors = await waitForExit([...botPids, ...gatewayPids]);
  if (survivors.length > 0) {
    console.error("operation-live-env-restart-blocked");
    console.error(`- 기존 프로세스가 종료되지 않았다: ${survivors.join(", ")}`);
    console.error("- 새 프로세스를 띄우면 중복 실행이 된다. 수동으로 종료한 뒤 다시 실행한다.");
    process.exit(1);
  }

  rmSync(BOT_PID, { force: true });
  rmSync(GATEWAY_PID, { force: true });

  // 두 서비스의 출력을 파일로 남긴다.
  //
  // 예전에는 stdio: "ignore" 라 전부 버렸다. 그 대가를 라이브에서 치렀다 — 봇이
  // Telegram 메시지를 한 시간 넘게 못 받는데 /healthz 는 계속 ok 를 돌려줘서,
  // 왜 못 받는지 알 방법이 아예 없었다. 서비스가 스스로 남긴 진단(폴링 에러, 무시
  // 사유)이 있어도 읽을 수가 없으면 없는 것과 같다.
  mkdirSync(LOG_DIR, { recursive: true });
  const botLog = openSync(BOT_LOG, "a");
  const gatewayLog = openSync(GATEWAY_LOG, "a");

  const bot = spawn("node", ["dist/apps/bot-service/src/cli.js"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", botLog, botLog],
    windowsHide: true,
    env: mergedEnv
  });
  bot.unref();
  writeFileSync(BOT_PID, String(bot.pid));

  const gateway = spawn("node", ["dist/apps/local-gateway/src/cli.js"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", gatewayLog, gatewayLog],
    windowsHide: true,
    env: mergedEnv
  });
  gateway.unref();
  writeFileSync(GATEWAY_PID, String(gateway.pid));

  console.log(`bot_service_log=${BOT_LOG}`);
  console.log(`local_gateway_log=${GATEWAY_LOG}`);

  console.log(`bot_service_pid=${bot.pid}`);
  console.log(`local_gateway_pid=${gateway.pid}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  await restartOperationServices();
}

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

export function mergePidSources(pidFileValue, discoveredPids) {
  const merged = new Set();
  for (const pid of discoveredPids ?? []) if (isPid(pid)) merged.add(pid);
  if (isPid(pidFileValue)) merged.add(pidFileValue);
  return [...merged];
}

// 명령줄로 서비스를 가른다. 두 서비스 모두 node.exe 라 이름만으로는 구분이 안 되고,
// 이 저장소 밖의 node 프로세스를 잡으면 안 되므로 cli.js 경로까지 본다.
export function classifyServiceProcesses(processes) {
  const result = { botService: [], localGateway: [] };
  for (const proc of processes ?? []) {
    const commandLine = String(proc?.CommandLine ?? "").replace(/\\/g, "/");
    const pid = Number(proc?.ProcessId);
    if (!isPid(pid)) continue;
    if (commandLine.includes("apps/bot-service/src/cli.js")) result.botService.push(pid);
    else if (commandLine.includes("apps/local-gateway/src/cli.js")) result.localGateway.push(pid);
  }
  return result;
}

function isPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 은 "살아 있는데 신호 권한이 없다"는 뜻이다. 죽은 것으로 읽으면
    // 중복 실행을 그대로 통과시키므로 살아 있는 쪽으로 판정한다.
    return error?.code === "EPERM";
  }
}

async function waitForExit(pids, timeoutMs = 10000, intervalMs = 200) {
  const targets = pids.filter(isPid);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = targets.filter(isAlive);
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function discoverServicePids() {
  if (process.platform !== "win32") return { botService: [], localGateway: [] };
  try {
    const output = await runPwshCommand(
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    );
    if (!output.trim()) return { botService: [], localGateway: [] };
    const parsed = JSON.parse(output);
    return classifyServiceProcesses(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    // 조회가 실패해도 PID 파일 경로는 살아 있다. 여기서 멈추면 조회 불가 환경에서
    // 재기동 자체를 못 하게 되므로, 단서 하나를 잃는 것으로만 처리한다.
    return { botService: [], localGateway: [] };
  }
}

async function readWindowsProcessEnv(pid) {
  if (!pid || process.platform !== "win32") return {};
  const script = resolve(ROOT, "scripts", "read-windows-process-env.ps1");
  const output = await runPwsh(script, String(pid));
  if (!output.trim()) return {};
  return JSON.parse(output);
}

function runPwshCommand(command) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
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
      else rejectPromise(new Error(`process-list-failed:${code}:${stderr}`));
    });
  });
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
