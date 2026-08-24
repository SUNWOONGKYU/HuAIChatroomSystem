const ROLES = [
  ["LEADER", "leader_bot"],
  ["CLAUDE", "claude_bot"],
  ["CODEX", "codex_bot"],
  ["AUDITOR", "auditor_bot"]
];

export function buildWebhookPlan(env) {
  const publicBaseUrl = trimSlash(required(env, "BOT_SERVICE_PUBLIC_BASE_URL"));
  return ROLES.map(([role, defaultUsername]) => {
    const username = env[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername;
    const token = required(env, `BOT_SERVICE_${role}_BOT_TOKEN`);
    const secretToken = required(env, `BOT_SERVICE_${role}_WEBHOOK_SECRET`);
    return {
      role: role.toLowerCase(),
      username,
      token,
      secretToken,
      url: `${publicBaseUrl}/telegram/webhook/${encodeURIComponent(username)}`
    };
  });
}

export async function applyTelegramWebhooks(env, fetchImpl = fetch) {
  const plan = buildWebhookPlan(env);
  const results = [];
  for (const item of plan) {
    const response = await fetchImpl(`https://api.telegram.org/bot${item.token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: item.url, secret_token: item.secretToken })
    });
    const payload = await response.json().catch(() => ({ ok: false, description: "invalid-json-response" }));
    results.push({
      role: item.role,
      username: item.username,
      url: item.url,
      ok: response.ok && payload.ok === true,
      description: sanitize(payload.description)
    });
  }
  return results;
}

export function formatWebhookPlan(plan) {
  return plan.map((item) => `PLAN ${item.role} username=${item.username} url=${item.url}`).join("\n");
}

export function formatWebhookApplyResults(results) {
  return results.map((item) => [
    item.ok ? "OK" : "FAIL",
    item.role,
    `username=${item.username}`,
    `url=${item.url}`,
    item.description ? `description=${item.description}` : undefined
  ].filter(Boolean).join(" ")).join("\n");
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function sanitize(value) {
  if (!value) return undefined;
  return String(value)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function parseMode(argv) {
  if (argv.includes("--apply")) return "apply";
  if (argv.includes("--dry-run")) return "dry-run";
  return "dry-run";
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const mode = parseMode(process.argv.slice(2));
  if (mode === "dry-run") {
    console.log(formatWebhookPlan(buildWebhookPlan(process.env)));
  } else {
    const results = await applyTelegramWebhooks(process.env);
    console.log(formatWebhookApplyResults(results));
    if (results.some((item) => !item.ok)) process.exit(1);
  }
}
