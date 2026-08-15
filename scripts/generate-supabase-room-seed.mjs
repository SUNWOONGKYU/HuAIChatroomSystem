import { createHash } from "node:crypto";

const BOT_ROLES = [
  ["platoon_leader", "PLATOON"],
  ["claude_leader", "CLAUDE"],
  ["codex_leader", "CODEX"],
  ["auditor", "AUDITOR"]
];

export function generateSupabaseRoomSeed(env) {
  const roomId = required(env, "BOT_SERVICE_ROOM_ID");
  const telegramChatId = requiredInt64(env, "BOT_SERVICE_TELEGRAM_CHAT_ID");
  const ownerTelegramUserId = requiredInt64(env, "BOT_SERVICE_OWNER_TELEGRAM_USER_ID");
  const projectPath = env.BOT_SERVICE_EXECUTION_PROJECT_PATH;
  const gatewayId = env.BOT_SERVICE_EXECUTION_GATEWAY_ID;

  const actors = BOT_ROLES.map(([role]) => ({
    actorId: uuidFrom(`${roomId}:actor:${role}`),
    role,
    adapterType: role === "claude_leader" ? "claude_code" : "codex"
  }));

  const bots = BOT_ROLES.map(([role, prefix]) => ({
    // 봇은 room 과 무관한 존재(공통 봇 4개를 여러 방에서 재사용)라
    // botId 파생에 roomId 를 섞지 않는다. roomId 를 섞으면 두 번째 방을
    // 시딩할 때 새 botId 가 생겨 bot_username unique 제약에 걸린다.
    botId: uuidFrom(`telegram-bot:${role}`),
    role,
    actorId: actors.find((actor) => actor.role === role).actorId,
    username: required(env, `BOT_SERVICE_${prefix}_BOT_USERNAME`),
    tokenSecretRef: `env:BOT_SERVICE_${prefix}_BOT_TOKEN`,
    webhookSecretRef: `env:BOT_SERVICE_${prefix}_WEBHOOK_SECRET`
  }));

  return [
    "begin;",
    `insert into huai_rooms (room_id, telegram_chat_id, owner_telegram_user_id, status) values (${sql(roomId)}::uuid, ${sql(telegramChatId)}, ${sql(ownerTelegramUserId)}, 'active') on conflict (room_id) do update set telegram_chat_id = excluded.telegram_chat_id, owner_telegram_user_id = excluded.owner_telegram_user_id, status = excluded.status;`,
    `insert into huai_room_members (room_id, telegram_user_id, role, permissions, status) values (${sql(roomId)}::uuid, ${sql(ownerTelegramUserId)}, 'owner', '{"approve":true,"final_approve":true,"manage_ai_actors":true}'::jsonb, 'active') on conflict (room_id, telegram_user_id) do update set role = excluded.role, permissions = excluded.permissions, status = excluded.status;`,
    ...actors.map((actor) => `insert into huai_ai_actors (actor_id, room_id, role, adapter_type, status, config) values (${sql(actor.actorId)}::uuid, ${sql(roomId)}::uuid, ${sql(actor.role)}, ${sql(actor.adapterType)}, 'active', ${sql(JSON.stringify(actorConfig(actor.role, gatewayId, projectPath)))}::jsonb) on conflict (actor_id) do update set role = excluded.role, adapter_type = excluded.adapter_type, status = excluded.status, config = excluded.config;`),
    // conflict 타깃은 bot_username(unique) 으로 잡는다. 봇은 room 과 무관하므로
    // 여러 방을 시딩해도 같은 봇 행 하나로 수렴해야 한다. actor_id 는 이제
    // 정보성 참조일 뿐이라 다른 방의 시딩이 앞서 시딩된 방의 actor_id 를
    // 덮어쓰면 안 되므로 update 대상에서 제외한다. telegram_bot_id 도 PK 라 제외.
    ...bots.map((bot) => `insert into huai_telegram_bots (telegram_bot_id, bot_username, role, actor_id, token_secret_ref, webhook_secret_ref, status) values (${sql(bot.botId)}::uuid, ${sql(bot.username)}, ${sql(bot.role)}, ${sql(bot.actorId)}::uuid, ${sql(bot.tokenSecretRef)}, ${sql(bot.webhookSecretRef)}, 'active') on conflict (bot_username) do update set role = excluded.role, token_secret_ref = excluded.token_secret_ref, webhook_secret_ref = excluded.webhook_secret_ref, status = excluded.status;`),
    "commit;"
  ].join("\n");
}

function actorConfig(role, gatewayId, projectPath) {
  if (role !== "codex_leader" && role !== "claude_leader") return {};
  return Object.fromEntries(Object.entries({ gatewayId, projectPath }).filter(([, value]) => Boolean(value)));
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function requiredInt64(env, key) {
  const value = required(env, key);
  if (!/^-?\d+$/.test(value)) throw new Error(`invalid-env:${key}`);
  return value;
}

function uuidFrom(value) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant(hex.slice(16, 20))}-${hex.slice(20, 32)}`;
}

function variant(hex) {
  const first = (parseInt(hex[0], 16) & 0x3) | 0x8;
  return first.toString(16) + hex.slice(1);
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  console.log(generateSupabaseRoomSeed(process.env));
}