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
  "verify:gate41",
  "verify:gate42",
  "verify:gate43",
  "verify:gate44",
  "verify:gate45",
  "verify:gate46",
  // gate47~49 는 package.json 에 정의는 됐지만 이 STEPS 배열에 추가되는 걸 잊어서
  // verify:all 에서 한 번도 자동 실행된 적이 없었다(품질 인프라 감사에서 발견) —
  // 14개 고아 테스트 파일과 같은 종류의 결함이 gate 단위로도 있었다는 뜻이다.
  "verify:gate47",
  "verify:gate48",
  "verify:gate49",
  // verify:game-browser 도 같은 이유로 빠져 있었다 — treasure-collector-runner 등
  // 미니게임 브라우저 회귀가 자동으로 안 걸렸다. gate47 스크린샷 서브테스트가 이미
  // playwright chromium 을 요구하므로 추가 브라우저 의존성을 새로 들이는 건 아니다.
  "verify:game-browser",
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
  // gate50/51 은 어떤 npm 스크립트에도 안 걸려 있던 고아 테스트 14개를 묶는다
  // (품질 인프라 감사에서 발견 — 그중 quiz-gate.test.mjs 는 방장이 실제로 보고한
  // "보완 요청 버튼이 안 보인다" 프로덕션 버그의 회귀 테스트였는데, 자동 실행이
  // 안 걸려 있어 재발해도 못 잡는 상태였다). gate50 은 빌드가 필요한 .ts, gate51 은
  // 빌드 없이 바로 도는 miniapp-web .mjs 다.
  "verify:gate50",
  "verify:gate51",
  // gate52 는 이번 완성도 개선에서 새로 만든 검증들을 묶는다 —
  // bot-service /readyz(진짜 의존성 확인), 로그 로테이션, 룸 백업 스냅샷,
  // stale 제안 정리 주기 배선, 시크릿 스캐너 패턴 자체 테스트.
  "verify:gate52",
  // 패키지 package.json 의 dependencies 선언이 실제 import 그래프와 일치하는지 대조한다.
  // 선언이 다시 죽은 설정이 되지 않게 하는 가드다(1~3차 평가에서 연속 지적된 항목).
  "verify:package-boundaries",
  // supabase/functions/**(Deno Edge Function) 회귀 테스트 11개 — 미니앱 인증(HMAC
  // initData 검증)·권한(membership)·방 격리(room-isolation) 같은 보안 핵심 경로인데도
  // 어떤 npm 스크립트에도 안 걸려 있던 고아 테스트였다(품질 인프라 감사에서 발견).
  // Deno 설치 여부와 무관하게 Node 어댑터로 실제 실행한다 — scripts/verify-supabase-functions.mjs
  // 상단 주석 참고.
  "verify:supabase-functions",
  // 방 복구(restore) CLI — 백업은 있었지만 복구가 저장소 어디에도 없던 공백을 메운다
  // (3차 평가 지적). 여기서도 package.json 에 스크립트 줄을 새로 추가하지 않고
  // verify:structure/verify:secrets/verify:supabase-functions 와 같은 패턴으로 바로
  // 실행되게 한다 — 이 STEPS 배열에 추가하는 걸 잊는 것 자체가 gate47~49 주석이
  // 경고하는 "고아 테스트" 결함과 같은 종류다.
  "verify:restore-room-backup",
  "verify:structure",
  "verify:secrets"
];

export function operationReadySteps() {
  return [...STEPS];
}

export function commandForStep(step) {
  if (step === "verify:structure") return "node scripts/verify-structure.mjs";
  if (step === "verify:secrets") return "node scripts/verify-no-secrets.mjs";
  // package.json 에 별도 스크립트 줄을 추가하지 않고도 돌게 한다(structure/secrets 와
  // 같은 패턴) — supabase/functions 는 이 저장소의 tsc 빌드 대상(apps/**, packages/**)
  // 밖이라 npm run build 로는 컴파일되지 않는다.
  if (step === "verify:supabase-functions") return "node scripts/verify-supabase-functions.mjs";
  if (step === "verify:restore-room-backup") return "node --test scripts/restore-room-backup.test.mjs";
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
