import {
  isAiAdapterType,
  normalizeAiAdapterType,
  type AiAdapterType,
  type TelegramBotRole
} from "../../../packages/contracts/src/index.js";
import {
  type RoomAuthorizationContext,
  type RoomMembership,
  type RoomPermission
} from "../../../packages/orchestrator/src/index.js";
import {
  type BotServiceConfig,
  type TelegramBotRuntimeConfig
} from "./index.js";

export type SupabaseRuntimeLoadConfig = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

// 방 하나의 런타임 스냅샷. 다방 지원 전에는 이 모양이 최상위 반환값이었다 —
// 지금은 활성 방마다 하나씩 만들어져 LoadedSupabaseBotServiceRuntime.rooms 에 담긴다.
export type LoadedSupabaseRoom = {
  roomId: string;
  telegramChatId: string;
  authorization: RoomAuthorizationContext;
  actors: readonly LoadedAiActor[];
  gateways: readonly LoadedGatewayInstance[];
};

export type LoadedSupabaseBotServiceRuntime = {
  rooms: readonly LoadedSupabaseRoom[];
  // 아웃박스 리스는 room 조건 없이 전역이다(lease_huai_outbox). allowedChatIds 가
  // 활성 방 전체의 합집합이 아니면, 방을 늘리는 순간 다른 방으로 나갈 메시지가
  // 전부 unauthorized-outbound-chat 으로 영구 폐기된다 — 반드시 합집합을 유지한다.
  config: BotServiceConfig;
  // 인증은 telegramChatId + telegramUserId 로 매칭되므로(authorizeTelegramInput),
  // 방마다 나눌 필요 없이 전체 방의 멤버십을 평평하게 합쳐도 안전하다.
  authorization: RoomAuthorizationContext;
};

export type LoadedAiActor = {
  actorId: string;
  role: TelegramBotRole;
  adapterType: AiAdapterType;
  status: "active" | "inactive" | "disabled";
};

export type LoadedGatewayInstance = {
  gatewayId: string;
  status: "online" | "offline" | "draining" | "disabled";
  allowedProjectRoots: readonly string[];
  allowedAdapters: readonly AiAdapterType[];
};

export async function loadSupabaseBotServiceRuntimeConfig(
  config: SupabaseRuntimeLoadConfig
): Promise<LoadedSupabaseBotServiceRuntime> {
  const client = new SupabaseRuntimeRestClient(config);
  const activeRoomRows = await loadActiveRooms(client);

  if (activeRoomRows.length === 0) {
    return {
      rooms: [],
      config: { allowedChatIds: [], botsByUsername: new Map() },
      authorization: { memberships: [] }
    };
  }

  const roomIds = activeRoomRows.map((room) => room.room_id);
  const { members, actors, gateways } = await loadRoomScopedRows(client, roomIds);
  const membersByRoom = groupByRoomId(members);
  const actorsByRoom = groupByRoomId(actors);
  const gatewaysByRoom = groupByRoomId(gateways);

  // 봇은 room 과 무관한 공통 계정(role 하나에 실제 Telegram 봇 계정 하나)이라
  // actor_id 로는 못 찾는다. 다방에서는 "이 방의 active actor role" 이 아니라
  // "활성 방 전체의 active actor role 합집합" 으로 넓혀야 한다 — 방 A 에만
  // codex_leader 가 있고 방 B 에는 없어도, 방 B 의 codex_bot 웹훅은 여전히
  // 열려 있어야 한다(다른 방이 그 role 을 쓰고 있으므로).
  const activeRoleUnion = new Set<TelegramBotRole>();
  const rooms: LoadedSupabaseRoom[] = activeRoomRows.map((room) => {
    const roomActors = (actorsByRoom.get(room.room_id) ?? [])
      .filter((actor) => actor.status === "active")
      .map(toLoadedActor);
    for (const actor of roomActors) activeRoleUnion.add(actor.role);

    return {
      roomId: room.room_id,
      telegramChatId: String(room.telegram_chat_id),
      authorization: {
        memberships: (membersByRoom.get(room.room_id) ?? []).map((member) => toRoomMembership(member, room.telegram_chat_id))
      },
      actors: roomActors,
      gateways: (gatewaysByRoom.get(room.room_id) ?? [])
        .filter((gateway) => gateway.status !== "disabled")
        .map(toLoadedGateway)
    };
  });

  const bots = await loadBotsForRoles(client, [...activeRoleUnion], config.env ?? process.env);

  return {
    rooms,
    config: {
      // 뜨문뜨문 20방 / 동시 3방 목표: 아웃박스 리스가 전역이라 여기서 좁히면
      // 그 순간 다른 방들의 발신이 전부 dead 로 떨어진다(위 타입 주석 참고).
      allowedChatIds: rooms.map((room) => room.telegramChatId),
      botsByUsername: new Map(bots.map((bot) => [bot.botUsername, bot]))
    },
    authorization: {
      memberships: rooms.flatMap((room) => room.authorization.memberships)
    }
  };
}

class SupabaseRuntimeRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SupabaseRuntimeLoadConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.serviceRoleKey = config.serviceRoleKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async get<T>(path: string): Promise<T> {
    // 끊기지 않는 호출 하나가 기동을 통째로 멈춘다(supabase-store.ts 의 같은 주석 참고).
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      signal: AbortSignal.timeout(20_000),
      method: "GET",
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`
      }
    });
    if (!response.ok) {
      throw new Error(`supabase-runtime-load-error:${response.status}:${maskSensitiveText(await safeResponseText(response))}`);
    }
    return (await response.json()) as T;
  }
}

async function loadActiveRooms(client: SupabaseRuntimeRestClient): Promise<RoomRow[]> {
  return client.get<RoomRow[]>("/huai_rooms?status=eq.active&select=room_id,telegram_chat_id,status");
}

// 멤버십·actor·게이트웨이는 방마다 왕복하지 않고 활성 방 id 전체를 한 번에
// in.() 으로 묶어 조회한다. 20방 규모에서 방마다 3건씩 왕복하면 60건이 되고,
// 그만큼 부팅이 느려지고 부분 실패 지점도 늘어난다.
async function loadRoomScopedRows(
  client: SupabaseRuntimeRestClient,
  roomIds: readonly string[]
): Promise<{ members: RoomMemberRow[]; actors: AiActorRow[]; gateways: GatewayInstanceRow[] }> {
  const quotedRoomIds = roomIds.map((id) => `"${escapePostgrestInValue(id)}"`).join(",");
  const [members, actors, gateways] = await Promise.all([
    client.get<RoomMemberRow[]>(
      `/huai_room_members?room_id=in.(${encodeURIComponent(quotedRoomIds)})&select=room_id,telegram_user_id,role,permissions,status`
    ),
    client.get<AiActorRow[]>(
      `/huai_ai_actors?room_id=in.(${encodeURIComponent(quotedRoomIds)})&select=room_id,actor_id,role,adapter_type,status`
    ),
    client.get<GatewayInstanceRow[]>(
      `/huai_gateway_instances?room_id=in.(${encodeURIComponent(quotedRoomIds)})&select=room_id,gateway_id,status,allowed_project_roots,allowed_adapters&order=created_at.asc`
    )
  ]);
  return { members, actors, gateways };
}

function groupByRoomId<T extends { room_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.room_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.room_id, [row]);
  }
  return grouped;
}

async function loadBotsForRoles(
  client: SupabaseRuntimeRestClient,
  roles: readonly TelegramBotRole[],
  env: NodeJS.ProcessEnv
): Promise<TelegramBotRuntimeConfig[]> {
  if (roles.length === 0) return [];

  const quotedRoles = roles.map((role) => `"${role}"`).join(",");
  const rows = await client.get<TelegramBotRow[]>(
    `/huai_telegram_bots?role=in.(${encodeURIComponent(quotedRoles)})&status=eq.active&select=telegram_bot_id,bot_username,role,webhook_secret_ref,status`
  );

  return rows.map((row) =>
    validateBotConfig({
      telegramBotId: row.telegram_bot_id,
      botUsername: row.bot_username,
      botRole: assertBotRole(row.role),
      webhookSecret: resolveSecretRef(row.webhook_secret_ref, env)
    })
  );
}

function toLoadedActor(row: AiActorRow): LoadedAiActor {
  return {
    actorId: row.actor_id,
    role: assertBotRole(row.role),
    adapterType: assertAdapterType(row.adapter_type),
    status: assertActorStatus(row.status)
  };
}

function toLoadedGateway(row: GatewayInstanceRow): LoadedGatewayInstance {
  return {
    gatewayId: row.gateway_id,
    status: assertGatewayStatus(row.status),
    allowedProjectRoots: parseStringArray(row.allowed_project_roots),
    allowedAdapters: parseStringArray(row.allowed_adapters).filter(isAiAdapterType).map(normalizeAiAdapterType)
  };
}

function toRoomMembership(row: RoomMemberRow, telegramChatId: number | string): RoomMembership {
  return {
    telegramChatId: String(telegramChatId),
    telegramUserId: String(row.telegram_user_id),
    role: assertMemberRole(row.role),
    permissions: parsePermissions(row.permissions),
    status: assertMemberStatus(row.status)
  };
}

function resolveSecretRef(secretRef: string, env: NodeJS.ProcessEnv): string {
  if (!secretRef.startsWith("env:")) {
    throw new Error(`unsupported-secret-ref:${secretRefKind(secretRef)}`);
  }
  const envKey = secretRef.slice("env:".length);
  if (!envKey) throw new Error("invalid-secret-ref:env");
  const value = env[envKey];
  if (!value) throw new Error(`missing-env:${envKey}`);
  return value;
}

function secretRefKind(secretRef: string): string {
  const separatorIndex = secretRef.indexOf(":");
  return separatorIndex === -1 ? "unknown" : secretRef.slice(0, separatorIndex);
}

function validateBotConfig(bot: TelegramBotRuntimeConfig): TelegramBotRuntimeConfig {
  if (!bot.telegramBotId || !bot.botUsername || !bot.botRole || !bot.webhookSecret) {
    throw new Error("invalid-bot-runtime-config");
  }
  return bot;
}

function parsePermissions(value: unknown): RoomPermission[] {
  if (!Array.isArray(value)) return [];
  return value.filter((permission): permission is RoomPermission =>
    [
      "task:create",
      "task:read",
      "task:approve",
      "task:reject",
      "task:verify",
      "task:final_approve",
      "task:cancel",
      "bots:manage"
    ].includes(String(permission))
  );
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function assertBotRole(value: string): TelegramBotRole {
  if (["leader", "claude_leader", "codex_leader", "auditor"].includes(value)) {
    return value as TelegramBotRole;
  }
  throw new Error("invalid-ai-actor-role");
}

function assertAdapterType(value: string): AiAdapterType {
  if (["orchestrator", "claude_code", "codex", "gemini_web", "antigravity", "auditor"].includes(value)) {
    return value === "antigravity" ? "gemini_web" : value as AiAdapterType;
  }
  throw new Error("invalid-ai-actor-adapter-type");
}

function assertActorStatus(value: string): LoadedAiActor["status"] {
  if (["active", "inactive", "disabled"].includes(value)) return value as LoadedAiActor["status"];
  throw new Error("invalid-ai-actor-status");
}

function assertMemberRole(value: string): RoomMembership["role"] {
  if (["owner", "human_member", "leader", "claude_leader", "codex_leader", "auditor", "operator"].includes(value)) {
    return value as RoomMembership["role"];
  }
  throw new Error("invalid-room-member-role");
}

function assertMemberStatus(value: string): RoomMembership["status"] {
  if (["active", "invited", "left", "removed", "suspended"].includes(value)) {
    return value as RoomMembership["status"];
  }
  throw new Error("invalid-room-member-status");
}

function assertGatewayStatus(value: string): LoadedGatewayInstance["status"] {
  if (["online", "offline", "draining", "disabled"].includes(value)) return value as LoadedGatewayInstance["status"];
  throw new Error("invalid-gateway-status");
}

async function safeResponseText(response: Response): Promise<string> {
  return response.text().catch(() => "unreadable-response");
}

function maskSensitiveText(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization|service_role)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}

// PostgREST in.() 필터에서 값 하나가 콤마·괄호·따옴표를 포함해도 안전하도록
// 항상 큰따옴표로 감싸고 그 안의 특수문자를 이스케이프한다. room_id 는 UUID 라
// 지금은 이런 문자가 나올 일이 없지만, 다른 in.() 사용처(예: role 목록)와
// 동일한 방식으로 통일해 둔다.
function escapePostgrestInValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

type RoomRow = {
  room_id: string;
  telegram_chat_id: string | number;
  status: string;
};

type RoomMemberRow = {
  room_id: string;
  telegram_user_id: string | number;
  role: string;
  permissions: unknown;
  status: string;
};

type AiActorRow = {
  room_id: string;
  actor_id: string;
  role: string;
  adapter_type: string;
  status: string;
};

type TelegramBotRow = {
  telegram_bot_id: string;
  bot_username: string;
  role: string;
  webhook_secret_ref: string;
  status: string;
};

type GatewayInstanceRow = {
  room_id: string;
  gateway_id: string;
  status: string;
  allowed_project_roots: unknown;
  allowed_adapters: unknown;
};
