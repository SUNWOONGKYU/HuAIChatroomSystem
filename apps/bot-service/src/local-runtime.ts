import { randomUUID } from "node:crypto";
import {
  makeTelegramUpdateIdempotencyKey,
  processTelegramInboundQueueMessage,
  type BotServiceConfig,
  type TelegramBotRuntimeConfig,
  type TelegramInboundProcessorPorts,
  type TelegramWebhookPorts
} from "./index.js";
import {
  type TelegramBotRole,
  type TelegramInboundQueueMessage,
  type TelegramUpdateReceipt
} from "../../../packages/contracts/src/index.js";
import { processTelegramInboundWithPersistence } from "./persistence.js";
import { SupabaseBotServiceStore, buildSupabaseBotServiceStoreFromEnv } from "./supabase-store.js";
import { loadSupabaseBotServiceRuntimeConfig } from "./supabase-runtime-loader.js";
import { type OutboxDispatcherStore } from "./outbox.js";

export type LocalBotServiceRuntime = {
  config: BotServiceConfig;
  webhookPorts: TelegramWebhookPorts;
  processQueuedInputs(): TelegramInboundQueueMessage[] | Promise<TelegramInboundQueueMessage[]>;
  storeKind: "local" | "supabase";
  outboxStore?: OutboxDispatcherStore;
};

export function buildBotServiceRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): LocalBotServiceRuntime {
  return hasAnySupabaseRuntimeEnv(env)
    ? buildSupabaseBotServiceRuntime(env)
    : buildLocalBotServiceRuntime(env);
}

export async function buildBotServiceRuntimeFromEnvAsync(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<LocalBotServiceRuntime> {
  return hasAnySupabaseRuntimeEnv(env)
    ? buildSupabaseBotServiceRuntimeFromDatabase(env, options)
    : buildLocalBotServiceRuntime(env);
}

export function buildLocalBotServiceRuntime(env: NodeJS.ProcessEnv = process.env): LocalBotServiceRuntime {
  const config = buildLocalBotServiceConfig(env);
  const queue: TelegramInboundQueueMessage[] = [];
  const seenUpdates = new Set<string>();

  return {
    config,
    webhookPorts: {
      updates: {
        async recordUpdateOnce(envelope, _rawUpdate, status): Promise<TelegramUpdateReceipt> {
          const idempotencyKey = makeTelegramUpdateIdempotencyKey(envelope);
          if (seenUpdates.has(idempotencyKey)) {
            return { inserted: false, status: "processed", idempotencyKey };
          }
          seenUpdates.add(idempotencyKey);
          return { inserted: true, status, idempotencyKey };
        },
        async markUpdateFailed() {
          return;
        }
      },
      inboundQueue: {
        async enqueue(message) {
          queue.push(message);
        }
      }
    },
    processQueuedInputs() {
      const drained = queue.splice(0, queue.length);
      const ports = buildLocalInboundProcessorPorts(env);
      for (const message of drained) {
        processTelegramInboundQueueMessage(message, ports);
      }
      return drained;
    },
    storeKind: "local"
  };
}

export function buildSupabaseBotServiceRuntime(env: NodeJS.ProcessEnv = process.env): LocalBotServiceRuntime {
  const config = buildLocalBotServiceConfig(env);
  const queue: TelegramInboundQueueMessage[] = [];
  const store = buildSupabaseBotServiceStoreFromEnv(env);

  return {
    config,
    webhookPorts: {
      updates: store,
      inboundQueue: {
        async enqueue(message) {
          queue.push(message);
        }
      }
    },
    async processQueuedInputs() {
      const drained = queue.splice(0, queue.length);
      const ports = buildLocalInboundProcessorPorts(env);
      for (const message of drained) {
        await processTelegramInboundWithPersistence({
          message,
          processorPorts: ports,
          persistence: store
        });
      }
      return drained;
    },
    storeKind: "supabase",
    outboxStore: store
  };
}

export async function buildSupabaseBotServiceRuntimeFromDatabase(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<LocalBotServiceRuntime> {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    roomId: env.BOT_SERVICE_ROOM_ID,
    telegramChatId: env.BOT_SERVICE_TELEGRAM_CHAT_ID,
    fetchImpl: options.fetchImpl,
    env
  });
  const queue: TelegramInboundQueueMessage[] = [];
  const store = new SupabaseBotServiceStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    roomId: loaded.roomId,
    fetchImpl: options.fetchImpl
  });

  return {
    config: loaded.config,
    webhookPorts: {
      updates: store,
      inboundQueue: {
        async enqueue(message) {
          queue.push(message);
        }
      }
    },
    async processQueuedInputs() {
      const drained = queue.splice(0, queue.length);
      const ports = buildSupabaseInboundProcessorPorts(env, loaded);
      for (const message of drained) {
        await processTelegramInboundWithPersistence({
          message,
          processorPorts: ports,
          persistence: store
        });
      }
      return drained;
    },
    storeKind: "supabase",
    outboxStore: store
  };
}
export function buildLocalBotServiceConfig(env: NodeJS.ProcessEnv = process.env): BotServiceConfig {
  const bots = parseBotRuntimeConfigs(env);
  const allowedChatIds = parseCsv(env.BOT_SERVICE_ALLOWED_CHAT_IDS);
  return {
    allowedChatIds,
    botsByUsername: new Map(bots.map((bot) => [bot.botUsername, bot]))
  };
}

export function buildLocalInboundProcessorPorts(env: NodeJS.ProcessEnv = process.env): TelegramInboundProcessorPorts {
  const allowedChatIds = parseCsv(env.BOT_SERVICE_ALLOWED_CHAT_IDS);
  const ownerId = requiredEnv(env, "BOT_SERVICE_OWNER_TELEGRAM_USER_ID");

  return {
    authorization: {
      memberships: allowedChatIds.map((telegramChatId) => ({
        telegramChatId,
        telegramUserId: ownerId,
        role: "owner",
        permissions: [],
        status: "active"
      }))
    },
    orchestrator: {
      makeId(prefix) {
        return `${prefix}_${randomUUID()}`;
      },
      now() {
        return new Date().toISOString();
      }
    }
  };
}

function buildSupabaseInboundProcessorPorts(
  env: NodeJS.ProcessEnv,
  loaded: Awaited<ReturnType<typeof loadSupabaseBotServiceRuntimeConfig>>
): TelegramInboundProcessorPorts {
  return {
    authorization: loaded.authorization,
    orchestrator: {
      makeId(prefix) {
        return `${prefix}_${randomUUID()}`;
      },
      now() {
        return new Date().toISOString();
      },
      executionDefaults: buildExecutionDefaultsFromEnv(env, loaded)
    }
  };
}

function buildExecutionDefaultsFromEnv(
  env: NodeJS.ProcessEnv,
  loaded: Awaited<ReturnType<typeof loadSupabaseBotServiceRuntimeConfig>>
): TelegramInboundProcessorPorts["orchestrator"]["executionDefaults"] {
  const actorRole = env.BOT_SERVICE_EXECUTION_ACTOR_ROLE ?? "codex_leader";
  const actor = loaded.actors.find((candidate) => candidate.role === actorRole);
  if (!actor) throw new Error(`missing-runtime-actor:${actorRole}`);

  const configuredGatewayId = env.BOT_SERVICE_EXECUTION_GATEWAY_ID;
  const configuredProjectPath = env.BOT_SERVICE_EXECUTION_PROJECT_PATH;
  const gateway = configuredGatewayId
    ? loaded.gateways.find((candidate) => candidate.gatewayId === configuredGatewayId)
    : loaded.gateways.find((candidate) => candidate.status === "online") ?? loaded.gateways[0];
  const gatewayId = configuredGatewayId ?? gateway?.gatewayId;
  const projectPath = configuredProjectPath ?? gateway?.allowedProjectRoots[0];
  if (!gatewayId || !projectPath) return undefined;

  return {
    roomId: loaded.roomId,
    actorId: actor.actorId,
    adapterType: actor.adapterType,
    projectPath,
    timeoutMs: Number(env.BOT_SERVICE_EXECUTION_TIMEOUT_MS ?? 900000),
    gatewayId
  };
}
function parseBotRuntimeConfigs(env: NodeJS.ProcessEnv): TelegramBotRuntimeConfig[] {
  const raw = env.BOT_SERVICE_BOTS_JSON;
  if (!raw) {
    return [
      buildBotFromEnv(env, "platoon_leader", "BOT_SERVICE_PLATOON_BOT_USERNAME", "BOT_SERVICE_PLATOON_BOT_ID", "BOT_SERVICE_PLATOON_WEBHOOK_SECRET"),
      buildBotFromEnv(env, "claude_leader", "BOT_SERVICE_CLAUDE_BOT_USERNAME", "BOT_SERVICE_CLAUDE_BOT_ID", "BOT_SERVICE_CLAUDE_WEBHOOK_SECRET"),
      buildBotFromEnv(env, "codex_leader", "BOT_SERVICE_CODEX_BOT_USERNAME", "BOT_SERVICE_CODEX_BOT_ID", "BOT_SERVICE_CODEX_WEBHOOK_SECRET"),
      buildBotFromEnv(env, "auditor", "BOT_SERVICE_AUDITOR_BOT_USERNAME", "BOT_SERVICE_AUDITOR_BOT_ID", "BOT_SERVICE_AUDITOR_WEBHOOK_SECRET")
    ];
  }

  const parsed = JSON.parse(raw) as TelegramBotRuntimeConfig[];
  return parsed.map(validateBotConfig);
}

function buildBotFromEnv(
  env: NodeJS.ProcessEnv,
  botRole: TelegramBotRole,
  usernameKey: string,
  idKey: string,
  secretKey: string
): TelegramBotRuntimeConfig {
  return validateBotConfig({
    botRole,
    botUsername: requiredEnv(env, usernameKey),
    telegramBotId: requiredEnv(env, idKey),
    webhookSecret: requiredEnv(env, secretKey)
  });
}

function validateBotConfig(bot: TelegramBotRuntimeConfig): TelegramBotRuntimeConfig {
  if (!bot.telegramBotId || !bot.botUsername || !bot.botRole || !bot.webhookSecret) {
    throw new Error("invalid-bot-runtime-config");
  }
  return bot;
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`missing-env:${key}`);
  }
  return value;
}

function hasAnySupabaseRuntimeEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY || env.BOT_SERVICE_ROOM_ID || env.BOT_SERVICE_TELEGRAM_CHAT_ID);
}




