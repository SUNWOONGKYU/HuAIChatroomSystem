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
import { processTelegramInboundWithPersistence, type OrchestratorPersistencePort } from "./persistence.js";
import { SupabaseBotServiceStore, buildSupabaseBotServiceStoreFromEnv } from "./supabase-store.js";
import { type InFlightExecution } from "./execution-heartbeat.js";
import { loadSupabaseBotServiceRuntimeConfig, type LoadedSupabaseRoom } from "./supabase-runtime-loader.js";
import { type OutboxDispatcherStore } from "./outbox.js";
import { type MiniAppDecisionPollerRoom } from "./miniapp-decision-poller.js";

export type LocalBotServiceRuntime = {
  config: BotServiceConfig;
  webhookPorts: TelegramWebhookPorts;
  processQueuedInputs(): TelegramInboundQueueMessage[] | Promise<TelegramInboundQueueMessage[]>;
  storeKind: "local" | "supabase";
  outboxStore?: OutboxDispatcherStore;
  // Mini App 승인 폴러(server.ts 가 실제 주기 루프를 돈다)가 필요로 하는 것들.
  // supabase 모드에서만 채워진다 — local 모드는 방 개념이 없다.
  miniAppDecisionPolling?: MiniAppDecisionPollingSupport;
  // 실행 중 표시("…이 입력 중")를 유지하려면 지금 무엇이 도는지 알아야 한다.
  // 게이트웨이가 리스한 local_gateway 행이 곧 실행 중인 것이라 별도 상태를 만들지 않는다.
  inFlightExecutions?: { listInFlightExecutions(): Promise<InFlightExecution[]> };
  // /readyz 가 Supabase 도달성을 확인할 때 쓰는 가벼운 핑. local(비-Supabase) 모드는
  // 확인할 의존성 자체가 없으므로 undefined — 그 항목은 항상 통과로 본다.
  pingSupabase?: () => Promise<void>;
};

export type MiniAppDecisionPollingSupport = {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  rooms: readonly MiniAppDecisionPollerRoom[];
  authorization: TelegramInboundProcessorPorts["authorization"];
  executionDefaultsByChatId: ReadonlyMap<string, TelegramInboundProcessorPorts["orchestrator"]["executionDefaults"]>;
  persistence: OrchestratorPersistencePort;
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
    // updates/inboundQueue 아래 메서드들은 인터페이스 계약(TelegramWebhookPorts)이
    // Promise 반환을 요구한다 — local 모드는 메모리 배열/Set 조작뿐이라 await 할
    // 대상이 없어도 async 를 유지한다.
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
      // TelegramInboundQueue 계약이 Promise<void> 반환을 요구한다 — 메모리
      // 배열 push 뿐이라 await 할 대상이 없어도 async 를 유지한다.
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
    outboxStore: store,
    pingSupabase: () => store.ping()
  };
}

export async function buildSupabaseBotServiceRuntimeFromDatabase(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<LocalBotServiceRuntime> {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    fetchImpl: options.fetchImpl,
    env
  });

  // 방마다 실행 기본값(actor/gateway/project path)이 다르므로 telegram_chat_id 로
  // 큐 메시지를 다시 그 방으로 되돌려 찾는다. TelegramInboundQueueMessage 계약은
  // 바꾸지 않았으므로(다른 패키지 파급 방지) roomId 를 메시지에 실어 보내지 않고,
  // 여기서 부팅 시점에 한 번 만든 조회 테이블로 해결한다.
  const executionDefaultsByChatId = new Map(
    loaded.rooms.map((room) => [room.telegramChatId, buildExecutionDefaultsForRoom(env, room)])
  );

  const queue: TelegramInboundQueueMessage[] = [];
  // Bravo(다방 store 재설계)가 SupabaseStoreConfig 에서 roomId 필드를 제거한다.
  // 프로세스 하나가 여러 방을 처리하므로 store 는 이제 room 고정이 아니라
  // 각 호출(이벤트/아웃박스 행)에 실린 room_id 로 스스로 방을 구분해야 한다.
  // 그 작업이 아직 이 브랜치에 반영되지 않았다면 아래에서 필수 필드 누락
  // 타입 에러가 난다 — 의도된 신호이며 Bravo 작업 완료 후 사라진다.
  const store = new SupabaseBotServiceStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    fetchImpl: options.fetchImpl,
    miniAppDirectLinkBaseUrl: env.BOT_SERVICE_MINIAPP_DIRECT_LINK || undefined
  });

  return {
    config: loaded.config,
    webhookPorts: {
      updates: store,
      // TelegramInboundQueue 계약이 Promise<void> 반환을 요구한다 — 메모리
      // 배열 push 뿐이라 await 할 대상이 없어도 async 를 유지한다.
      inboundQueue: {
        async enqueue(message) {
          queue.push(message);
        }
      }
    },
    async processQueuedInputs() {
      const drained = queue.splice(0, queue.length);
      for (const message of drained) {
        const executionDefaults = executionDefaultsByChatId.get(message.input.envelope.telegramChatId);
        const ports = buildSupabaseInboundProcessorPorts(env, loaded.authorization, executionDefaults);
        try {
          await processTelegramInboundWithPersistence({
            message,
            processorPorts: ports,
            persistence: store
          });
        } catch (error) {
          // 메시지 하나(네트워크 장애, orchestrator 예외 등 이유 불문)가 여기서 던지면,
          // 예전엔 이 for 루프 전체가 멈춰서 이미 큐에서 빠져나온(drained) 뒤쪽 메시지 —
          // 다른 방의 것일 수도 있다 — 가 재시도 없이 통째로 유실됐다. 방 하나의 실패가
          // 다른 방을 끌고 죽으면 A-5 의 격리 목적 자체가 무너지므로, 메시지 단위로 잡아
          // 로그만 남기고 드레인을 계속한다. processTelegramInboundWithPersistence 내부에서
          // 이미 markTelegramUpdateFailed 를 호출했으므로 실패 상태는 DB 에도 남는다.
          console.error(JSON.stringify({
            type: "bot_service_message_processing_failed",
            telegramChatId: message.input.envelope.telegramChatId,
            idempotencyKey: message.idempotencyKey,
            reason: maskRuntimeError(error)
          }));
        }
      }
      return drained;
    },
    storeKind: "supabase",
    outboxStore: store,
    miniAppDecisionPolling: {
      url: requiredEnv(env, "SUPABASE_URL"),
      serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
      fetchImpl: options.fetchImpl,
      rooms: loaded.rooms.map((room) => ({ roomId: room.roomId, telegramChatId: room.telegramChatId })),
      authorization: loaded.authorization,
      executionDefaultsByChatId,
      persistence: store
    },
    inFlightExecutions: store,
    pingSupabase: () => store.ping()
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
  authorization: TelegramInboundProcessorPorts["authorization"],
  executionDefaults: TelegramInboundProcessorPorts["orchestrator"]["executionDefaults"]
): TelegramInboundProcessorPorts {
  return {
    authorization,
    orchestrator: {
      makeId(prefix) {
        return `${prefix}_${randomUUID()}`;
      },
      now() {
        return new Date().toISOString();
      },
      executionDefaults
    }
  };
}

// 방 하나의 실행 기본값(리더 판단 자동 호출에 쓰는 actor/gateway/project path)을 만든다.
// 예전에는 이 함수가 actor 를 못 찾으면 던졌고, 그 예외가 부팅 경로를 타면 프로세스 전체가
// 죽었다 — 다방에서는 방 하나가 잘못 시딩됐다고 나머지 19개 방까지 멈추면 안 된다.
// 이제는 던지지 않고 undefined 를 돌려준다: 그 방은 실행 기본값 없이(=리더 자동 판단 없이,
// 규칙 기반 경로로만) 계속 동작하고, 다른 방은 영향받지 않는다. 놓치면 안 되므로 로그는 남긴다.
export function buildExecutionDefaultsForRoom(
  env: NodeJS.ProcessEnv,
  room: LoadedSupabaseRoom
): TelegramInboundProcessorPorts["orchestrator"]["executionDefaults"] {
  const actorRole = env.BOT_SERVICE_EXECUTION_ACTOR_ROLE ?? "codex_leader";
  const actor = room.actors.find((candidate) => candidate.role === actorRole);
  if (!actor) {
    console.error(JSON.stringify({
      type: "bot_service_room_execution_defaults_unavailable",
      roomId: room.roomId,
      reason: `missing-runtime-actor:${actorRole}`
    }));
    return undefined;
  }

  // 게이트웨이/프로젝트 경로는 이 방 자신의 huai_gateway_instances 를 우선한다.
  // "고객 A 방은 고객 A 폴더" 가 다방 지원의 존재 이유이므로, 여기서 env 값이
  // DB 값을 덮어써 버리면 모든 방이 같은 게이트웨이·같은 폴더에서 실행되는
  // 회귀가 생긴다. env 오버라이드는 이 방의 DB 게이트웨이 정보가 아예 없을 때만
  // 쓰는 기본값으로 격하한다(예: 게이트웨이 테이블 시딩 전 단일 방 로컬 테스트).
  const dbGateway = room.gateways.find((candidate) => candidate.status === "online") ?? room.gateways[0];
  const gatewayId = dbGateway?.gatewayId ?? env.BOT_SERVICE_EXECUTION_GATEWAY_ID;
  const projectPath = dbGateway?.allowedProjectRoots[0] ?? env.BOT_SERVICE_EXECUTION_PROJECT_PATH;
  if (!gatewayId || !projectPath) return undefined;

  return {
    roomId: room.roomId,
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
      buildBotFromEnv(env, "leader", "BOT_SERVICE_LEADER_BOT_USERNAME", "BOT_SERVICE_LEADER_BOT_ID", "BOT_SERVICE_LEADER_WEBHOOK_SECRET"),
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

function maskRuntimeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization|service_role)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}

function hasAnySupabaseRuntimeEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY || env.BOT_SERVICE_ROOM_ID || env.BOT_SERVICE_TELEGRAM_CHAT_ID);
}




