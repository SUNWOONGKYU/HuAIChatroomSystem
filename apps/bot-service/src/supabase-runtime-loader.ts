import {
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
  roomId?: string;
  telegramChatId?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export type LoadedSupabaseBotServiceRuntime = {
  roomId: string;
  config: BotServiceConfig;
  authorization: RoomAuthorizationContext;
  actors: readonly LoadedAiActor[];
  gateways: readonly LoadedGatewayInstance[];
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
  const room = await loadRoom(client, config);
  const [members, actors, gateways] = await Promise.all([
    client.get<RoomMemberRow[]>(
      `/huai_room_members?room_id=eq.${encodeURIComponent(room.room_id)}&select=telegram_user_id,role,permissions,status`
    ),
    client.get<AiActorRow[]>(
      `/huai_ai_actors?room_id=eq.${encodeURIComponent(room.room_id)}&select=actor_id,role,adapter_type,status`
    ),
    client.get<GatewayInstanceRow[]>(
      `/huai_gateway_instances?room_id=eq.${encodeURIComponent(room.room_id)}&select=gateway_id,status,allowed_project_roots,allowed_adapters&order=created_at.asc`
    )
  ]);
  const activeActors = actors
    .filter((actor) => actor.status === "active")
    .map(toLoadedActor);
  const bots = await loadBotsForActors(client, activeActors, config.env ?? process.env);
  const allowedChatIds = room.status === "active" ? [String(room.telegram_chat_id)] : [];

  return {
    roomId: room.room_id,
    config: {
      allowedChatIds,
      botsByUsername: new Map(bots.map((bot) => [bot.botUsername, bot]))
    },
    authorization: {
      memberships: members.map((member) => toRoomMembership(member, room.telegram_chat_id))
    },
    actors: activeActors,
    gateways: gateways.filter((gateway) => gateway.status !== "disabled").map(toLoadedGateway)
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
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
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

async function loadRoom(
  client: SupabaseRuntimeRestClient,
  config: SupabaseRuntimeLoadConfig
): Promise<RoomRow> {
  const selector = config.roomId
    ? `room_id=eq.${encodeURIComponent(config.roomId)}`
    : config.telegramChatId
      ? `telegram_chat_id=eq.${encodeURIComponent(config.telegramChatId)}`
      : undefined;
  if (!selector) {
    throw new Error("missing-env:BOT_SERVICE_ROOM_ID");
  }

  const rows = await client.get<RoomRow[]>(`/huai_rooms?${selector}&select=room_id,telegram_chat_id,status`);
  const room = rows[0];
  if (!room) throw new Error("supabase-runtime-room-not-found");
  if (room.status !== "active") throw new Error("supabase-runtime-room-inactive");
  return room;
}

async function loadBotsForActors(
  client: SupabaseRuntimeRestClient,
  actors: readonly LoadedAiActor[],
  env: NodeJS.ProcessEnv
): Promise<TelegramBotRuntimeConfig[]> {
  if (actors.length === 0) return [];

  const actorRoles = new Map(actors.map((actor) => [actor.actorId, actor.role]));
  const quotedIds = actors.map((actor) => `"${actor.actorId}"`).join(",");
  const rows = await client.get<TelegramBotRow[]>(
    `/huai_telegram_bots?actor_id=in.(${encodeURIComponent(quotedIds)})&status=eq.active&select=telegram_bot_id,bot_username,actor_id,webhook_secret_ref,status`
  );

  return rows.map((row) => {
    const role = actorRoles.get(row.actor_id);
    if (!role) throw new Error("supabase-runtime-bot-actor-missing");
    return validateBotConfig({
      telegramBotId: row.telegram_bot_id,
      botUsername: row.bot_username,
      botRole: role,
      webhookSecret: resolveSecretRef(row.webhook_secret_ref, env)
    });
  });
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
    allowedAdapters: parseStringArray(row.allowed_adapters).filter((adapter): adapter is AiAdapterType =>
      adapter === "codex" || adapter === "claude_code"
    )
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
  if (["platoon_leader", "claude_leader", "codex_leader", "auditor"].includes(value)) {
    return value as TelegramBotRole;
  }
  throw new Error("invalid-ai-actor-role");
}

function assertAdapterType(value: string): AiAdapterType {
  if (["orchestrator", "claude_code", "codex", "auditor"].includes(value)) {
    return value as AiAdapterType;
  }
  throw new Error("invalid-ai-actor-adapter-type");
}

function assertActorStatus(value: string): LoadedAiActor["status"] {
  if (["active", "inactive", "disabled"].includes(value)) return value as LoadedAiActor["status"];
  throw new Error("invalid-ai-actor-status");
}

function assertMemberRole(value: string): RoomMembership["role"] {
  if (["owner", "human_member", "platoon_leader", "claude_leader", "codex_leader", "auditor", "operator"].includes(value)) {
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

type RoomRow = {
  room_id: string;
  telegram_chat_id: string | number;
  status: string;
};

type RoomMemberRow = {
  telegram_user_id: string | number;
  role: string;
  permissions: unknown;
  status: string;
};

type AiActorRow = {
  actor_id: string;
  role: string;
  adapter_type: string;
  status: string;
};

type TelegramBotRow = {
  telegram_bot_id: string;
  bot_username: string;
  actor_id: string;
  webhook_secret_ref: string;
  status: string;
};

type GatewayInstanceRow = {
  gateway_id: string;
  status: string;
  allowed_project_roots: unknown;
  allowed_adapters: unknown;
};
