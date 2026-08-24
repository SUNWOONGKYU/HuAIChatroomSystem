import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { applyOperationEnvFile } from "./operation-env-loader.mjs";

const ROLES = [
  ["LEADER", "leader_chatroom_bot", "leaderbot-deep-orange.jpg"],
  ["CLAUDE", "claude_chatroom1_bot", "claudebot-orange.jpg"],
  ["CODEX", "codex_chatroom_bot", "codexbot-purple.jpg"],
  ["AUDITOR", "audit_chatroom_bot", "auditbot-gold.jpg"]
];

export function buildBotProfilePhotoPlan(env, root = process.cwd()) {
  return ROLES.map(([role, defaultUsername, fileName]) => ({
    role: role.toLowerCase(),
    roleKey: role,
    username: env[`BOT_SERVICE_${role}_BOT_USERNAME`] || defaultUsername,
    token: required(env, `BOT_SERVICE_${role}_BOT_TOKEN`),
    filePath: resolve(root, "assets", "telegram-bot-profiles", fileName)
  }));
}

export async function setTelegramBotProfilePhotos(env, fetchImpl = fetch, root = process.cwd()) {
  const plan = buildBotProfilePhotoPlan(env, root);
  const results = [];
  for (const item of plan) {
    const image = await readFile(item.filePath);
    const form = new FormData();
    form.set("photo", JSON.stringify({ type: "static", photo: "attach://profile_photo" }));
    form.set("profile_photo", new Blob([image], { type: "image/jpeg" }), basename(item.filePath));

    const response = await fetchImpl(`https://api.telegram.org/bot${item.token}/setMyProfilePhoto`, {
      method: "POST",
      body: form
    });
    const payload = await response.json().catch(() => ({ ok: false, description: "invalid-json-response" }));
    results.push({
      role: item.role,
      username: item.username,
      ok: response.ok && payload.ok === true,
      description: sanitize(payload.description)
    });
  }
  return results;
}

export function formatBotProfilePhotoPlan(plan) {
  return plan.map((item) => `PLAN ${item.role} username=${item.username} file=${basename(item.filePath)}`).join("\n");
}

export function formatBotProfilePhotoResults(results) {
  return results.map((item) => [
    item.ok ? "OK" : "FAIL",
    item.role,
    `username=${item.username}`,
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
  applyOperationEnvFile(process.env);
  const mode = parseMode(process.argv.slice(2));
  if (mode === "dry-run") {
    console.log(formatBotProfilePhotoPlan(buildBotProfilePhotoPlan(process.env)));
  } else {
    const results = await setTelegramBotProfilePhotos(process.env);
    console.log(formatBotProfilePhotoResults(results));
    if (results.some((item) => !item.ok)) process.exit(1);
  }
}
