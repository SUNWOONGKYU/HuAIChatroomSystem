const ROLES = [
  ["PLATOON", "platoon_bot"],
  ["CLAUDE", "claude_bot"],
  ["CODEX", "codex_bot"],
  ["AUDITOR", "auditor_bot"]
];

export async function checkTelegramWebhooks(env, fetchImpl = fetch) {
  const publicBaseUrl = trimSlash(required(env, "BOT_SERVICE_PUBLIC_BASE_URL"));
  const results = [];
  for (const [role, defaultUsername] of ROLES) {
    const token = required(env, `BOT_SERVICE_${role}_BOT_TOKEN`);
    const username = env[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername;
    const expectedUrl = `${publicBaseUrl}/telegram/webhook/${encodeURIComponent(username)}`;
    const response = await callTelegram(fetchImpl, token, "getWebhookInfo", {});
    const actualUrl = response.result?.url ?? "";
    results.push({
      role: role.toLowerCase(),
      username,
      expectedUrl,
      actualUrl,
      pendingUpdateCount: Number(response.result?.pending_update_count ?? 0),
      ok: response.ok === true && actualUrl === expectedUrl,
      lastError: sanitize(response.result?.last_error_message)
    });
  }
  return results;
}

export function formatWebhookCheckResults(results) {
  return results.map((item) => [
    item.ok ? "OK" : "FAIL",
    item.role,
    `url=${item.actualUrl || "unset"}`,
    `pending=${item.pendingUpdateCount}`,
    item.lastError ? `last_error=${item.lastError}` : undefined
  ].filter(Boolean).join(" ")).join("\n");
}

async function callTelegram(fetchImpl, token, method, body) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
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

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const results = await checkTelegramWebhooks(process.env);
  console.log(formatWebhookCheckResults(results));
  if (results.some((item) => !item.ok)) process.exit(1);
}
