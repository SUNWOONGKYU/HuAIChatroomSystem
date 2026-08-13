const ROLES = [
  ["PLATOON", "platoon_bot"],
  ["CLAUDE", "claude_bot"],
  ["CODEX", "codex_bot"],
  ["AUDITOR", "auditor_bot"]
];

export async function checkTelegramBots(env, fetchImpl = fetch) {
  const results = [];
  for (const [role, defaultUsername] of ROLES) {
    const token = required(env, `BOT_SERVICE_${role}_BOT_TOKEN`);
    const expectedUsername = env[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername;
    const response = await callTelegram(fetchImpl, token, "getMe", {});
    const actualUsername = response.result?.username;
    results.push({
      role: role.toLowerCase(),
      expectedUsername,
      actualUsername,
      ok: response.ok === true && actualUsername === expectedUsername,
      error: response.ok === true ? undefined : safeText(response.description)
    });
  }
  return results;
}

export function formatBotCheckResults(results) {
  return results.map((item) => [
    item.ok ? "OK" : "FAIL",
    item.role,
    `expected=${item.expectedUsername}`,
    `actual=${item.actualUsername ?? "unknown"}`,
    item.error ? `error=${item.error}` : undefined
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

function safeText(value) {
  return String(value ?? "unknown").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const results = await checkTelegramBots(process.env);
  console.log(formatBotCheckResults(results));
  if (results.some((item) => !item.ok)) process.exit(1);
}
