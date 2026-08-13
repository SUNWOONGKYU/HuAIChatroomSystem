const ROLES = [
  ["PLATOON", "platoon_bot"],
  ["CLAUDE", "claude_bot"],
  ["CODEX", "codex_bot"],
  ["AUDITOR", "auditor_bot"]
];

export async function checkTelegramBotCommands(env, fetchImpl = fetch) {
  const results = [];
  for (const [role, defaultUsername] of ROLES) {
    const token = required(env, `BOT_SERVICE_${role}_BOT_TOKEN`);
    const username = env[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername;
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { type: "all_group_chats" } })
    });
    const payload = await response.json().catch(() => ({ ok: false, description: "invalid-json-response" }));
    const commands = Array.isArray(payload.result) ? payload.result.map((item) => item.command) : [];
    results.push({
      role: role.toLowerCase(),
      username,
      commands,
      ok: response.ok && payload.ok === true && commands.length > 0,
      description: sanitize(payload.description)
    });
  }
  return results;
}

export function formatBotCommandCheckResults(results) {
  return results.map((item) => [
    item.ok ? "OK" : "FAIL",
    item.role,
    `username=${item.username}`,
    `commands=${item.commands.join(",") || "none"}`,
    item.description ? `description=${item.description}` : undefined
  ].filter(Boolean).join(" ")).join("\n");
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function sanitize(value) {
  if (!value) return undefined;
  return String(value).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const results = await checkTelegramBotCommands(process.env);
  console.log(formatBotCommandCheckResults(results));
  if (results.some((item) => !item.ok)) process.exit(1);
}
