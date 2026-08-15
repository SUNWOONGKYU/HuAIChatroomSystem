import { spawnSync } from "node:child_process";

const STEPS = [
  "typecheck",
  "verify:gate12",
  "verify:gate13",
  "verify:gate14",
  "verify:gate15",
  "verify:gate16",
  "verify:gate17",
  "verify:gate18",
  "verify:gate19",
  "verify:gate20",
  "verify:gate21",
  "verify:gate22",
  "verify:gate23",
  "verify:gate24",
  "verify:gate25",
  "verify:gate26",
  "verify:gate27",
  "verify:gate28",
  "verify:gate29",
  "verify:gate30",
  "verify:gate31",
  "verify:gate32",
  "verify:gate33",
  "verify:gate34",
  "verify:gate35",
  "verify:gate36",
  "verify:gate37",
  "verify:gate38",
  "verify:gate39",
  "verify:gate40",
  "verify:local-gateway-runtime",
  "verify:local-gateway-consumer",
  "verify:spec-coverage",
  // 다방 KPI(뜨문뜨문 20방, 동시 3방) 전용 오프라인 게이트. 다른 gate 들이 이미 검증하는
  // 항목들을 KPI 언어로 다시 매핑해서 재확인한다 — 개별 gate 가 이미 도니 재실행 비용이
  // 있지만, "다방이 지금 실제로 온전한가"를 한 곳에서 바로 답할 수 있는 전용 진입점이
  // 그동안 없었다. verify:multiroom 은 이 오케스트레이터 자체의 로직(spawnImpl 페이크)을
  // 검증하고, verify:multiroom-offline 이 실제로 다른 gate 들을 돌려서 결과를 낸다.
  // --live 실측(층 2)은 여기 안 들어간다 — 실 Supabase 접속이 필요해 옵트인으로만 돈다.
  // verify:secrets 는 마지막 관문으로 남겨야 해서 그 앞에 넣는다.
  "verify:multiroom",
  "verify:multiroom-offline",
  "verify:structure",
  "verify:secrets"
];

export function operationReadySteps() {
  return [...STEPS];
}

export function commandForStep(step) {
  if (step === "verify:structure") return "node scripts/verify-structure.mjs";
  if (step === "verify:secrets") return "node scripts/verify-no-secrets.mjs";
  return `npm run ${step}`;
}

export function parsePositiveInt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// 게이트마다 tsc 를 다시 돌리면 Windows 에서 dist 쓰기가 간헐 실패한다.
// 맨 앞에서 한 번만 빌드하고 이후 게이트는 건너뛰게 한다.
function prebuildOnce(spawnImpl, env) {
  const result = spawnImpl("npm run build:force", { cwd: process.cwd(), env, stdio: "inherit", shell: true });
  return result.status === 0;
}

export function runOperationReady({
  spawnImpl = spawnSync,
  env = process.env,
  retryCount = 1,
  retryDelayMs = 750,
  sleepImpl = sleepSync,
  nowImpl = Date.now,
  stepTimeoutMs = parsePositiveInt(env.OPERATION_READY_STEP_TIMEOUT_MS)
} = {}) {
  const totalStartedAt = nowImpl();
  if (env.HUAI_PREBUILT !== "1") {
    console.log("operation-ready prebuild-start");
    if (!prebuildOnce(spawnImpl, env)) {
      console.error("operation-ready prebuild-failed");
      return { ok: false, failedStep: "build", status: 1 };
    }
    env = { ...env, HUAI_PREBUILT: "1" };
    console.log("operation-ready prebuild-done (게이트별 재빌드 생략)");
  }
  for (const step of STEPS) {
    const command = commandForStep(step);
    console.log(`\n== ${step} ==`);
    console.log(`operation-ready step-start step=${step} command=${JSON.stringify(command)} timeout_ms=${stepTimeoutMs ?? "none"}`);
    let result;
    let stepStartedAt = nowImpl();
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      stepStartedAt = nowImpl();
      result = spawnImpl(command, {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
        shell: true,
        timeout: stepTimeoutMs
      });
      const durationMs = Math.max(0, nowImpl() - stepStartedAt);
      if (result.status === 0) {
        console.log(`operation-ready step-pass step=${step} attempt=${attempt + 1} duration_ms=${durationMs}`);
        break;
      }
      if (isTimeoutResult(result)) {
        console.error(`operation-ready step-timeout step=${step} attempt=${attempt + 1} duration_ms=${durationMs} timeout_ms=${stepTimeoutMs}`);
        break;
      }
      if (attempt < retryCount) {
        console.error(`operation-ready retry: ${step} attempt ${attempt + 2}`);
        sleepImpl(retryDelayMs);
      }
    }
    if (result.status !== 0) {
      const status = result.status ?? (isTimeoutResult(result) ? 124 : 1);
      return { ok: false, failedStep: step, status };
    }
  }
  console.log(`operation-ready total-pass duration_ms=${Math.max(0, nowImpl() - totalStartedAt)}`);
  return { ok: true };
}

function isTimeoutResult(result) {
  return result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM";
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const result = runOperationReady();
  if (!result.ok) {
    console.error(`operation-ready failed: ${result.failedStep}`);
    process.exit(result.status);
  }
  console.log("operation-ready passed");
}
