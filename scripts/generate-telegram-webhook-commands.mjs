const ROLES = [
  ["PLATOON", "platoon_bot"],
  ["CLAUDE", "claude_bot"],
  ["CODEX", "codex_bot"],
  ["AUDITOR", "auditor_bot"]
];

export function generateWebhookCommands(input) {
  const publicBaseUrl = trimSlash(required(input, "BOT_SERVICE_PUBLIC_BASE_URL"));
  return ROLES.map(([role, defaultUsername]) => {
    const username = input[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername;
    const tokenEnv = `BOT_SERVICE_${role}_BOT_TOKEN`;
    const secretEnv = `BOT_SERVICE_${role}_WEBHOOK_SECRET`;
    const webhookUrl = `${publicBaseUrl}/telegram/webhook/${encodeURIComponent(username)}`;
    return [
      `curl -sS -X POST "https://api.telegram.org/bot$${tokenEnv}/setWebhook"`,
      `  -H "content-type: application/json"`,
      `  -d '{"url":"${webhookUrl}","secret_token":"'$${secretEnv}'"}'`
    ].join(" ");
  });
}

function required(input, key) {
  const value = input[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  for (const command of generateWebhookCommands(process.env)) console.log(command);
}
