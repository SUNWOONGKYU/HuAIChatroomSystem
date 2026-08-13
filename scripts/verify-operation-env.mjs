const BOT_ROLES = ["PLATOON", "CLAUDE", "CODEX", "AUDITOR"];
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
  "LOCAL_GATEWAY_MAX_CONSECUTIVE_ERRORS"
];

export function validateOperationEnv(env, profile = "all") {
  const errors = [];
  if (profile === "all" || profile === "bot-service") validateBotServiceEnv(env, errors);
  if (profile === "all" || profile === "local-gateway") validateLocalGatewayEnv(env, errors);
  validatePositiveIntegers(env, errors);
  return errors;
}

function validateBotServiceEnv(env, errors) {
  requireAny(env, ["BOT_SERVICE_ROOM_ID", "BOT_SERVICE_TELEGRAM_CHAT_ID"], errors);
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
    if (!["codex", "claude_code"].includes(adapter)) errors.push(`invalid-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS:${adapter}`);
  }
  if (adapters.length === 0) errors.push("missing-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS");
  if (splitList(env.LOCAL_GATEWAY_ALLOWED_ROOTS).length === 0) errors.push("missing-env:LOCAL_GATEWAY_ALLOWED_ROOTS");
  if (env.LOCAL_GATEWAY_ALLOW_NETWORK && !["true", "false"].includes(env.LOCAL_GATEWAY_ALLOW_NETWORK)) {
    errors.push("invalid-env:LOCAL_GATEWAY_ALLOW_NETWORK");
  }
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

function requireAny(env, keys, errors) {
  if (!keys.some((key) => Boolean(env[key]))) errors.push(`missing-env:${keys.join("|")}`);
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