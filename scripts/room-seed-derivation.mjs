import { createHash } from "node:crypto";

// room 시딩 관련 파생 규칙(uuid 파생, CLI 인자 매핑, 값 해석)의 유일한 출처다.
// generate-supabase-room-seed.mjs(순수 SQL 생성기)와 onboard-telegram-room.mjs
// (PostgREST 업서트 실행기) 가 이 모듈을 함께 쓴다 — 두 곳이 각자 파생 로직을
// 들고 있으면 같은 입력에서 다른 uuid 가 나올 수 있고, 그건 재앙이다.

export const BOT_ROLES = [
  ["platoon_leader", "PLATOON"],
  ["claude_leader", "CLAUDE"],
  ["codex_leader", "CODEX"],
  ["auditor", "AUDITOR"]
];

// 방을 여러 개 시딩/온보딩할 때 매번 env 를 바꿔치기하고 되돌리는 파괴적 수동 절차를
// 없애기 위한 CLI 인자 매핑이다. 값이 오면 env 를 덮어쓰고(override), 인자가 없는
// 키는 그대로 env 로 폴백한다 — 기존 "env 전용" 사용법을 깨지 않기 위해서다.
export const ROOM_SEED_CLI_FLAG_TO_ENV_KEY = {
  "--room-id": "BOT_SERVICE_ROOM_ID",
  "--chat-id": "BOT_SERVICE_TELEGRAM_CHAT_ID",
  "--owner-id": "BOT_SERVICE_OWNER_TELEGRAM_USER_ID",
  "--project-path": "BOT_SERVICE_EXECUTION_PROJECT_PATH",
  "--gateway-id": "BOT_SERVICE_EXECUTION_GATEWAY_ID",
  "--machine-label": "BOT_SERVICE_EXECUTION_MACHINE_LABEL"
};

export function parseRoomSeedArgs(argv) {
  const overrides = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const envKey = ROOM_SEED_CLI_FLAG_TO_ENV_KEY[arg];
    if (!envKey) throw new Error(`unknown-arg:${arg}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing-arg-value:${arg}`);
    overrides[envKey] = value;
    i += 1;
  }
  return overrides;
}

// env + CLI 인자를 하나의 확정 설정으로 합친다. 인자가 env 보다 우선하고,
// 인자가 없는 키는 env 값으로 폴백한다. 필수값 검증은 여기서 한 번만 한다.
export function resolveRoomSeedConfig(env, argv = []) {
  const effectiveEnv = { ...env, ...parseRoomSeedArgs(argv) };
  const roomId = required(effectiveEnv, "BOT_SERVICE_ROOM_ID");
  const telegramChatId = requiredInt64(effectiveEnv, "BOT_SERVICE_TELEGRAM_CHAT_ID");
  const ownerTelegramUserId = requiredInt64(effectiveEnv, "BOT_SERVICE_OWNER_TELEGRAM_USER_ID");
  const projectPath = effectiveEnv.BOT_SERVICE_EXECUTION_PROJECT_PATH;
  const gatewayId = effectiveEnv.BOT_SERVICE_EXECUTION_GATEWAY_ID;
  const machineLabel = effectiveEnv.BOT_SERVICE_EXECUTION_MACHINE_LABEL || "primary";
  // huai_rooms.purpose 는 schema 상 not null 이고 기본값이 없다. CLI 인자 목록에는
  // 없는 필드라 env 전용으로만 받고, 없으면 안전한 기본 문구로 채운다 — 이게 없으면
  // 온보딩 CLI 의 huai_rooms upsert 가 매번 not-null 위반으로 실패한다.
  const purpose = effectiveEnv.BOT_SERVICE_ROOM_PURPOSE || "Telegram 협업 room";
  return { env: effectiveEnv, roomId, telegramChatId, ownerTelegramUserId, projectPath, gatewayId, machineLabel, purpose };
}

// huai_ai_actors 에는 gatewayId/projectPath 를 담을 곳이 없다 — 실행 기본값은
// huai_gateway_instances(방마다 별도 행)와 buildExecutionDefaultsForRoom(apps/bot-service)
// 이 담당한다. 예전엔 여기서 actorConfig(role, gatewayId, projectPath) 를 만들어
// huai_ai_actors.config jsonb 컬럼에 실었는데, 그 컬럼이 schema.sql/라이브 DB
// 어디에도 애초에 존재하지 않았다 — 라이브 온보딩 3건이 upsert-actors 단계에서
// PGRST204("Could not find the 'config' column")로 전부 실패한 뒤에야 드러났다.
// 아무도 안 읽는 것도 문제였지만, 그 이전에 쓸 컬럼 자체가 없었다.
export function deriveActors(roomId) {
  return BOT_ROLES.map(([role]) => ({
    actorId: uuidFrom(`${roomId}:actor:${role}`),
    role,
    adapterType: role === "claude_leader" ? "claude_code" : "codex"
  }));
}

export function deriveBots(actors, env) {
  return BOT_ROLES.map(([role, prefix]) => ({
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
}

// 게이트웨이는 봇과 반대다 — 봇은 room 과 무관하지만, huai_gateway_instances.room_id 는
// NOT NULL 이라 게이트웨이 행은 정확히 방 하나에 속한다. 머신 1대(같은 machineLabel)로
// 여러 방을 돌려도 방마다 별개의 게이트웨이 행이 필요하므로, roomId 와 machineLabel 을
// 함께 파생 키에 넣어 방마다 다른 gateway_id 가 나오게 한다.
export function deriveGateway(config) {
  const gatewayInstanceId = uuidFrom(`gateway:${config.roomId}:${config.machineLabel}`);
  const allowedProjectRoots = dedupe([
    ...splitList(config.env.LOCAL_GATEWAY_ALLOWED_ROOTS),
    ...(config.projectPath ? [config.projectPath] : [])
  ]);
  const allowedAdaptersFromEnv = splitList(config.env.LOCAL_GATEWAY_ALLOWED_ADAPTERS);
  const allowedAdapters = allowedAdaptersFromEnv.length > 0 ? allowedAdaptersFromEnv : ["claude_code", "codex"];
  return { gatewayInstanceId, machineLabel: config.machineLabel, allowedProjectRoots, allowedAdapters };
}

export function dedupe(values) {
  return [...new Set(values)];
}

export function splitList(value) {
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

export function requiredInt64(env, key) {
  const value = required(env, key);
  if (!/^-?\d+$/.test(value)) throw new Error(`invalid-env:${key}`);
  return value;
}

export function uuidFrom(value) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant(hex.slice(16, 20))}-${hex.slice(20, 32)}`;
}

function variant(hex) {
  const first = (parseInt(hex[0], 16) & 0x3) | 0x8;
  return first.toString(16) + hex.slice(1);
}
