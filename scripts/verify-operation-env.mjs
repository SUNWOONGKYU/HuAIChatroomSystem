const BOT_ROLES = ["LEADER", "CLAUDE", "CODEX", "AUDITOR"];
const POSITIVE_INT_KEYS = [
  "BOT_SERVICE_OUTBOX_LIMIT",
  "BOT_SERVICE_OUTBOX_LEASE_MS",
  "BOT_SERVICE_OUTBOX_POLL_MS",
  "BOT_SERVICE_OUTBOX_MAX_ATTEMPTS",
  "LOCAL_GATEWAY_INTERVAL_MS",
  "LOCAL_GATEWAY_LIMIT",
  "LOCAL_GATEWAY_MAX_ATTEMPTS",
  "LOCAL_GATEWAY_LEASE_MS",
  "LOCAL_GATEWAY_MAX_RUNTIME_MS",
  "LOCAL_GATEWAY_MAX_CONSECUTIVE_ERRORS",
  // CONCURRENCY 는 이전까지 이 목록에 없었다 — 형식 검증이 아예 안 되고 있었다.
  // 아래 lease 부등식 교차검증이 이 값을 숫자로 쓰므로 먼저 정수인지부터 확인해야 한다.
  "LOCAL_GATEWAY_CONCURRENCY"
];

// apps/local-gateway/src/runtime.ts 의 부팅 검증(leaseMs > maxRuntimeMs * ceil(limit/concurrency))
// 을 여기서도 확인한다. .env 템플릿과 라이브 env 둘 다 이 부등식을 어긴 채로 커밋/배포돼
// 있었는데(2026-08-15), verify-operation-env.mjs 가 개별 값의 "양의 정수인지"만 보고
// 이 관계는 전혀 안 봐서 어떤 게이트도 못 잡았다 — 부팅해봐야만(runtime.ts) 드러났다.
//
// ⚠️ 파생 규칙 동기화 경고: 아래 계산식은 apps/local-gateway/src/runtime.ts:87-98 의
// parseLocalGatewayRuntimeConfig() 안 로직을 그대로 복제한 것이다. dist/ 빌드 산출물을
// import 하는 방식도 검토했지만, verify-operation-env.mjs 는 service-startup-preflight.mjs/
// telegram-connection-sequence.mjs 양쪽에서 "빌드 전에 먼저 env 만 빠르게 확인"하는
// 프리플라이트 용도로 쓰인다(둘 다 package.json 스크립트에 `npm run build &&` 가 없다) —
// dist import 를 강제하면 그 프리플라이트 성격 자체가 깨진다. 그래서 복제를 택했다.
// runtime.ts 의 기본값(LIMIT=5, CONCURRENCY=3, MAX_RUNTIME_MS=1800000)이나 부등식이
// 바뀌면 이 상수·계산식도 반드시 같이 바꿔야 한다 — 안 그러면 이 게이트가 다시 거짓말을
// 시작한다.
const LOCAL_GATEWAY_LEASE_DEFAULTS = {
  limit: 5,
  concurrency: 3,
  maxRuntimeMs: 1_800_000
};

export function validateOperationEnv(env, profile = "all") {
  const errors = [];
  if (profile === "all" || profile === "bot-service") validateBotServiceEnv(env, errors);
  if (profile === "all" || profile === "local-gateway") validateLocalGatewayEnv(env, errors);
  validatePositiveIntegers(env, errors);
  return errors;
}

function validateBotServiceEnv(env, errors) {
  // 다방화 이후 BOT_SERVICE_ROOM_ID/BOT_SERVICE_TELEGRAM_CHAT_ID 는 "부팅에 방 하나를
  // 반드시 지정해야 한다"는 뜻이 아니다 — supabase-runtime-loader 가 이제 huai_rooms 에서
  // status=eq.active 전체를 로드한다(Alpha 작업, SupabaseRuntimeLoadConfig 에서 필드 자체가
  // 빠졌다). 그래서 여기서 requireAny 를 완전히 뺀다.
  //
  // "있으면 유효해야 한다" 검증은 추가하지 않기로 판단했다 — local-runtime.ts 의
  // hasAnySupabaseRuntimeEnv() 가 여전히 이 둘을 모드 감지(Supabase vs 로컬) 신호로
  // 참조하긴 하지만, 그 함수는 SUPABASE_URL || SUPABASE_SERVICE_ROLE_KEY 만으로도 이미
  // Supabase 모드를 감지하고(둘 다 바로 아래에서 requireKey 로 필수), 두 값의 형식이
  // 틀려도 소비하는 다른 곳이 없어 형식 검증을 새로 추가할 실익이 없다.
  requireKey(env, "SUPABASE_URL", errors);
  requireKey(env, "SUPABASE_SERVICE_ROLE_KEY", errors);
  const tokenKeys = [];
  const webhookSecretKeys = [];
  for (const role of BOT_ROLES) {
    const tokenKey = `BOT_SERVICE_${role}_BOT_TOKEN`;
    const secretKey = `BOT_SERVICE_${role}_WEBHOOK_SECRET`;
    requireKey(env, tokenKey, errors);
    requireKey(env, secretKey, errors);
    tokenKeys.push(tokenKey);
    webhookSecretKeys.push(secretKey);
  }
  rejectDuplicateValues(env, tokenKeys, "duplicate-env:BOT_SERVICE_BOT_TOKEN", errors);
  rejectDuplicateValues(env, webhookSecretKeys, "duplicate-env:BOT_SERVICE_WEBHOOK_SECRET", errors);
  if (env.BOT_SERVICE_OUTBOX_ENABLED && !["true", "false"].includes(env.BOT_SERVICE_OUTBOX_ENABLED)) {
    errors.push("invalid-env:BOT_SERVICE_OUTBOX_ENABLED");
  }
}

function validateLocalGatewayEnv(env, errors) {
  requireKey(env, "SUPABASE_URL", errors);
  requireKey(env, "SUPABASE_SERVICE_ROLE_KEY", errors);
  requireKey(env, "LOCAL_GATEWAY_ALLOWED_ROOTS", errors);
  requireKey(env, "LOCAL_GATEWAY_ALLOWED_ADAPTERS", errors);
  const adapters = splitList(env.LOCAL_GATEWAY_ALLOWED_ADAPTERS);
  for (const adapter of adapters) {
    // 엔진 목록은 packages/contracts 의 AiAdapterType 이 정본이다. 여기는 .mjs 라 타입을
    // 가져오지 못하므로 값을 옮겨 적는다 — 엔진을 늘리면 이 줄도 같이 고쳐야 한다.
    if (!["codex", "claude_code", "gemini_web", "antigravity"].includes(adapter)) errors.push(`invalid-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS:${adapter}`);
  }
  if (adapters.length === 0) errors.push("missing-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS");
  if (splitList(env.LOCAL_GATEWAY_ALLOWED_ROOTS).length === 0) errors.push("missing-env:LOCAL_GATEWAY_ALLOWED_ROOTS");
  if (env.LOCAL_GATEWAY_ALLOW_NETWORK && !["true", "false"].includes(env.LOCAL_GATEWAY_ALLOW_NETWORK)) {
    errors.push("invalid-env:LOCAL_GATEWAY_ALLOW_NETWORK");
  }
  validateLeaseFormula(env, errors);
}

// runtime.ts:94 는 LOCAL_GATEWAY_LEASE_MS 가 unset 이면 worstCaseBatchMs + 60_000 으로
// 자동 계산해서 이 부등식을 항상 만족시킨다 — 그래서 LEASE_MS 가 명시적으로 설정된
// 경우에만 검사한다. 값 형식이 이미 틀린 게 있으면(POSITIVE_INT_KEYS 검사가 별도로
// 잡는다) 여기서 또 에러를 겹쳐 내지 않고 조용히 건너뛴다.
function validateLeaseFormula(env, errors) {
  if (env.LOCAL_GATEWAY_LEASE_MS === undefined || env.LOCAL_GATEWAY_LEASE_MS === "") return;

  const limitRaw = env.LOCAL_GATEWAY_LIMIT ?? String(LOCAL_GATEWAY_LEASE_DEFAULTS.limit);
  const concurrencyRaw = env.LOCAL_GATEWAY_CONCURRENCY ?? String(LOCAL_GATEWAY_LEASE_DEFAULTS.concurrency);
  const maxRuntimeRaw = env.LOCAL_GATEWAY_MAX_RUNTIME_MS ?? String(LOCAL_GATEWAY_LEASE_DEFAULTS.maxRuntimeMs);
  const leaseRaw = env.LOCAL_GATEWAY_LEASE_MS;

  if (![limitRaw, concurrencyRaw, maxRuntimeRaw, leaseRaw].every(isPositiveIntegerString)) return;

  const limit = Number(limitRaw);
  const concurrency = Number(concurrencyRaw);
  const maxRuntimeMs = Number(maxRuntimeRaw);
  const leaseMs = Number(leaseRaw);

  const worstCaseBatchMs = maxRuntimeMs * Math.ceil(limit / concurrency);
  if (leaseMs <= worstCaseBatchMs) {
    const minimumLeaseMs = worstCaseBatchMs + 1;
    errors.push(
      "invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed-LOCAL_GATEWAY_MAX_RUNTIME_MS-times-ceil(LOCAL_GATEWAY_LIMIT/LOCAL_GATEWAY_CONCURRENCY)" +
        `:got-${leaseMs}-need-greater-than-${worstCaseBatchMs}` +
        `:set-LOCAL_GATEWAY_LEASE_MS-to-at-least-${minimumLeaseMs}` +
        `:computed-from-LOCAL_GATEWAY_LIMIT=${limit},LOCAL_GATEWAY_CONCURRENCY=${concurrency},LOCAL_GATEWAY_MAX_RUNTIME_MS=${maxRuntimeMs}`
    );
  }
}

function isPositiveIntegerString(value) {
  return /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value));
}

function validatePositiveIntegers(env, errors) {
  for (const key of POSITIVE_INT_KEYS) {
    if (env[key] === undefined || env[key] === "") continue;
    if (!/^\d+$/.test(env[key]) || Number(env[key]) <= 0 || !Number.isSafeInteger(Number(env[key]))) {
      errors.push(`invalid-env:${key}`);
    }
  }
}

function rejectDuplicateValues(env, keys, errorPrefix, errors) {
  const seen = new Map();
  for (const key of keys) {
    const value = env[key];
    if (!value) continue;
    const firstKey = seen.get(value);
    if (firstKey) errors.push(`${errorPrefix}:${firstKey}:${key}`);
    else seen.set(value, key);
  }
}

function requireKey(env, key, errors) {
  if (!env[key]) errors.push(`missing-env:${key}`);
}

function splitList(value) {
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProfile(argv) {
  const profileFlag = argv.find((arg) => arg.startsWith("--profile="));
  const profile = profileFlag ? profileFlag.slice("--profile=".length) : "all";
  if (!["all", "bot-service", "local-gateway"].includes(profile)) {
    throw new Error(`invalid-profile:${profile}`);
  }
  return profile;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const profile = parseProfile(process.argv.slice(2));
  const errors = validateOperationEnv(process.env, profile);
  if (errors.length > 0) {
    console.error("Operation env verification failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Operation env verification passed: ${profile}`);
}
