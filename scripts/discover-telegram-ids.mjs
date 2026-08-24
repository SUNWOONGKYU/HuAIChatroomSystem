export async function discoverTelegramIds(env, fetchImpl = fetch) {
  const role = (env.DISCOVER_TELEGRAM_ROLE || "LEADER").toUpperCase();
  const token = required(env, `BOT_SERVICE_${role}_BOT_TOKEN`);
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowed_updates: ["message", "callback_query"] })
  });
  const payload = await response.json().catch(() => ({ ok: false, description: "invalid-json-response" }));
  if (!response.ok || payload.ok !== true) {
    throw new Error(`telegram-get-updates-error:${response.status}:${sanitize(payload.description)}`);
  }
  return summarizeUpdates(payload.result ?? []);
}

export function summarizeUpdates(updates) {
  const chats = new Map();
  const users = new Map();
  for (const update of updates) {
    const message = update.message ?? update.callback_query?.message;
    const from = update.message?.from ?? update.callback_query?.from;
    if (message?.chat?.id !== undefined) {
      chats.set(String(message.chat.id), {
        telegramChatId: String(message.chat.id),
        type: message.chat.type,
        title: message.chat.title,
        username: message.chat.username
      });
    }
    if (from?.id !== undefined && from.is_bot !== true) {
      users.set(String(from.id), {
        telegramUserId: String(from.id),
        username: from.username,
        firstName: from.first_name,
        lastName: from.last_name
      });
    }
  }
  return { chats: [...chats.values()], users: [...users.values()] };
}

export function formatDiscoveredTelegramIds(summary) {
  const lines = ["Telegram id discovery result:", "Chats:"];
  if (summary.chats.length === 0) lines.push("- none");
  for (const chat of summary.chats) {
    lines.push(`- telegram_chat_id=${chat.telegramChatId} type=${chat.type ?? "unknown"} title=${chat.title ?? ""}`.trim());
  }
  lines.push("Users:");
  if (summary.users.length === 0) lines.push("- none");
  for (const user of summary.users) {
    lines.push(`- telegram_user_id=${user.telegramUserId} username=${user.username ?? ""}`.trim());
  }
  return lines.join("\n");
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function sanitize(value) {
  return String(value ?? "unknown")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  console.error("Use only before webhook activation. Send one message in the target Telegram group first.");
  const summary = await discoverTelegramIds(process.env);
  console.log(formatDiscoveredTelegramIds(summary));
}
