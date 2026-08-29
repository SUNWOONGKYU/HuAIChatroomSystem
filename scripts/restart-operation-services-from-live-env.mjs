import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOperationEnvAliases } from "./operation-env-loader.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";
import { fileURLToPath as __fileURLToPath } from "node:url";
// 이 저장소의 루트. 개발자 PC 의 절대경로를 박아 두면 다른 PC·다른 체크아웃에서 조용히
// 엉뚱한 곳을 가리킨다 — 스크립트 위치(scripts/)에서 한 단계 올라간 곳이 루트다.
const REPO_ROOT = __fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");

const ROOT = REPO_ROOT;
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

  // 살아 있는 프로세스에서 환경변수를 물려받되, 설정 파일이 그보다 우선한다.
  //
  // 물려받기의 목적은 시크릿을 파일에서 다시 읽지 않는 것이다. 그런데 순서가 반대로
  // 되어 있어서, 죽은 프로세스가 들고 있던 값이 계속 대물림됐다 — 파일에서
  // LOCAL_GATEWAY_MAX_RUNTIME_MS 를 5분에서 15분으로 고치고 재기동했는데도 실행은
  // 여전히 5분에 끊겼고, 프로세스 환경을 직접 열어보고서야 옛 값이 그대로인 것을 알았다.
  //
  // 파일에 적힌 값이 사람이 방금 정한 값이다. 그것을 마지막에 얹는다. 파일에 없는
  // 항목은 여전히 살아 있는 프로세스에서 물려받으므로 시크릿은 그대로 유지된다.
  const mergedEnv = {
    ...process.env,
    ...await readWindowsProcessEnv(botPids[0]),
    ...await readWindowsProcessEnv(gatewayPids[0]),
    ...readOperationEnvFile()
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

  // 죽인 실행을 큐에 되돌린다.
  //
  // 게이트웨이를 멈추면 그 순간 돌던 CLI 도 같이 죽는데, 그 행은 huai_outbox 에
  // processing + locked_until(약 31분) 로 남는다. 아무도 그걸 건드릴 수 없어서 방은
  // "작업 중"인 채로 30분을 흘려보낸다 — 라이브에서 방장이 결과를 기다리다 그대로 멈췄다.
  //
  // 리스를 푸는 것은 우리가 그 실행을 죽였다는 사실을 아는 이 시점이 가장 정확하다.
  // 새 게이트웨이가 다음 tick 에 다시 집어간다.
  const released = await releaseLeasesForOurGateways(mergedEnv);
  if (released > 0) console.log(`released_leases=${released}`);

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

  // 방마다 게이트웨이를 하나씩 띄운다.
  //
  // 게이트웨이는 자기 gateway_id 로 온 일만 리스하고 자기 allowed roots 안에서만 실행한다.
  // 그래서 방이 늘면 프로세스도 늘어야 한다 — 하나로 여러 방을 맡는 길은 아직 없다.
  // 방을 섞지 않는 것이 이 구조의 값이다: 개인회생 방의 실행이 회계 자료 폴더를 열 수
  // 없고, 그 반대도 마찬가지다.
  for (const instance of parseGatewayInstances(mergedEnv.LOCAL_GATEWAY_EXTRA_INSTANCES)) {
    const log = openSync(`${LOG_DIR}\\local-gateway.${instance.label}.log`, "a");
    const child = spawn("node", ["dist/apps/local-gateway/src/cli.js"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: {
        ...mergedEnv,
        LOCAL_GATEWAY_ID: instance.gatewayId,
        LOCAL_GATEWAY_ALLOWED_ROOTS: instance.root,
        LOCAL_GATEWAY_HEALTH_PORT: String(instance.healthPort)
      }
    });
    child.unref();
    writeFileSync(`C:\\tmp\\huai-local-gateway.${instance.label}.pid`, String(child.pid));
    console.log(`local_gateway_pid[${instance.label}]=${child.pid} port=${instance.healthPort}`);
  }
}

// LOCAL_GATEWAY_EXTRA_INSTANCES=라벨|gatewayId|건강검진포트|작업폴더;라벨|...
//
// 라벨은 로그·PID 파일 이름이 된다. 사람이 어느 방 로그인지 알아보려면 uuid 보다 이름이 낫다.
export function parseGatewayInstances(value) {
  const instances = [];
  for (const entry of String(value ?? "").split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [label, gatewayId, healthPort, ...rootParts] = trimmed.split("|");
    // 경로에 | 는 들어갈 수 없지만, 나머지를 다시 붙여 두면 규칙이 바뀌어도 경로가 잘리지 않는다.
    const root = rootParts.join("|").trim();
    const port = positiveInteger(healthPort);
    if (!label?.trim() || !gatewayId?.trim() || !port || !root) {
      throw new Error(`invalid-env:LOCAL_GATEWAY_EXTRA_INSTANCES:${trimmed}`);
    }
    instances.push({ label: label.trim(), gatewayId: gatewayId.trim(), healthPort: port, root });
  }
  return instances;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  await restartOperationServices();
}

function setOperationRuntimeTimeout(env) {
  const requestedMs = positiveInteger(env.HUAI_OPERATION_RUNTIME_MS) ?? 900000;
  env.BOT_SERVICE_EXECUTION_TIMEOUT_MS = String(requestedMs);
  env.LOCAL_GATEWAY_MAX_RUNTIME_MS = String(requestedMs);
}

// 이 기계가 맡은 게이트웨이 id 들. 다른 기계의 실행까지 되돌리면 그쪽 작업을 중복 실행시킨다.
export function gatewayIdsFromEnv(env) {
  const ids = [];
  if (env.LOCAL_GATEWAY_ID) ids.push(env.LOCAL_GATEWAY_ID.trim());
  for (const instance of parseGatewayInstances(env.LOCAL_GATEWAY_EXTRA_INSTANCES)) {
    ids.push(instance.gatewayId);
  }
  return [...new Set(ids.filter(Boolean))];
}

async function releaseLeasesForOurGateways(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const gatewayIds = gatewayIdsFromEnv(env);
  if (!url || !key || gatewayIds.length === 0) return 0;

  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    prefer: "return=representation"
  };

  try {
    const response = await fetch(
      `${url.replace(/\/+$/, "")}/rest/v1/huai_outbox?target_kind=eq.local_gateway&status=eq.processing&select=huai_outbox_id,target`,
      { headers, signal: AbortSignal.timeout(20_000) }
    );
    if (!response.ok) return 0;
    const rows = await response.json();
    const ours = rows.filter((row) => {
      try {
        return gatewayIds.includes(JSON.parse(row.target ?? "{}").gatewayId);
      } catch {
        return false;
      }
    });
    if (ours.length === 0) return 0;

    const quoted = ours.map((row) => `"${row.huai_outbox_id}"`).join(",");
    const patch = await fetch(
      `${url.replace(/\/+$/, "")}/rest/v1/huai_outbox?huai_outbox_id=in.(${encodeURIComponent(quoted)})`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          status: "pending",
          locked_at: null,
          locked_until: null,
          next_attempt_at: new Date().toISOString()
        }),
        signal: AbortSignal.timeout(20_000)
      }
    );
    return patch.ok ? ours.length : 0;
  } catch {
    // 리스를 못 풀어도 재기동 자체는 진행한다 — 31분 뒤 만료되면 어차피 다시 걸린다.
    return 0;
  }
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

// .env.operation.local 을 읽어 키/값으로 돌려준다. 파일이 없으면 빈 값 —
// 물려받은 환경만으로 돌던 예전 동작이 그대로 유지된다.
export function parseEnvFile(text) {
  const parsed = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    // 값에 = 가 더 있어도 첫 = 만 구분자로 본다(토큰에 = 가 들어간다).
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) parsed[key] = value;
  }
  return parsed;
}

function readOperationEnvFile() {
  const path = resolve(ROOT, ".env.operation.local");
  if (!existsSync(path)) return {};
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
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
  // 물려받기는 편의일 뿐 필수가 아니다 — 설정 파일이 어차피 마지막에 덮어쓴다.
  // 서비스가 죽은 뒤 PID 파일만 남으면 OpenProcess 가 open-process-failed 로 실패하는데,
  // 예전에는 그 예외가 재기동 전체를 멈춰 세웠다("서비스가 꺼져 있을수록 못 켜는" 상태).
  // 못 읽으면 그냥 안 물려받는다.
  let output = "";
  try {
    output = await runPwsh(script, String(pid));
  } catch (error) {
    console.warn(`process-env-inherit-skipped pid=${pid} reason=${error instanceof Error ? error.message.split(String.fromCharCode(10))[0] : String(error)}`);
    return {};
  }
  if (!output.trim()) return {};
  try {
    return JSON.parse(output);
  } catch {
    console.warn(`process-env-inherit-skipped pid=${pid} reason=unparsable-output`);
    return {};
  }
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
