const ROLES = [
  ["PLATOON", "platoon_bot"],
  ["CLAUDE", "claude_bot"],
  ["CODEX", "codex_bot"],
  ["AUDITOR", "auditor_bot"]
];

const ROLE_COMMANDS = {
  PLATOON: [
    { command: "newtask", description: "새 작업 제안" },
    { command: "tasks", description: "작업 목록" },
    { command: "task", description: "작업 상세" },
    { command: "search", description: "작업 검색" },
    { command: "trace", description: "작업 이력" },
    { command: "approve", description: "작업 승인" },
    { command: "reject", description: "작업 반려" },
    { command: "verify", description: "검증 요청" },
    { command: "done", description: "최종 승인" },
    { command: "cancel", description: "작업 취소" },
    { command: "help", description: "도움말" }
  ],
  CLAUDE: [
    { command: "help", description: "ClaudeBot 도움말" }
  ],
  CODEX: [
    { command: "help", description: "CodexBot 도움말" }
  ],
  AUDITOR: [
    { command: "help", description: "AuditBot 도움말" }
  ]
};

export function buildBotCommandPlan(env) {
  return ROLES.map(([role, defaultUsername]) => ({
    role: role.toLowerCase(),
    roleKey: role,
    username: env[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername,
    token: required(env, `BOT_SERVICE_${role}_BOT_TOKEN`),
    commands: ROLE_COMMANDS[role]
  }));
}

export async function setTelegramBotCommands(env, fetchImpl = fetch) {
  const plan = buildBotCommandPlan(env);
  const results = [];
  for (const item of plan) {
    const response = await fetchImpl(`https://api.telegram.org/bot${item.token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: item.commands, scope: { type: "all_group_chats" } })
    });
    const payload = await response.json().catch(() => ({ ok: false, description: "invalid-json-response" }));
    results.push({
      role: item.role,
      username: item.username,
      commandCount: item.commands.length,
      ok: response.ok && payload.ok === true,
      description: sanitize(payload.description)
    });
  }
  return results;
}

export function formatBotCommandPlan(plan) {
  return plan.map((item) => `PLAN ${item.role} username=${item.username} commands=${item.commands.map((command) => command.command).join(",")}`).join("\n");
}

export function formatBotCommandResults(results) {
  return results.map((item) => [
    item.ok ? "OK" : "FAIL",
    item.role,
    `username=${item.username}`,
    `commands=${item.commandCount}`,
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
    console.log(formatBotCommandPlan(buildBotCommandPlan(process.env)));
  } else {
    const results = await setTelegramBotCommands(process.env);
    console.log(formatBotCommandResults(results));
    if (results.some((item) => !item.ok)) process.exit(1);
  }
}
