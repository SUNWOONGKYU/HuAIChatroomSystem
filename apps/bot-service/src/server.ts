import { createTelegramWebhookHttpServer } from "./http.js";
import { buildBotServiceRuntimeFromEnvAsync } from "./local-runtime.js";
import { buildTelegramBotTokenResolverFromEnv } from "./bot-token-resolver.js";
import { createTelegramFetchSender, createTelegramGrammySender } from "./outbox.js";
import { startOutboxConsumerLoop, type OutboxConsumerHandle } from "./consumer.js";

export type BotServiceServerHandle = {
  close(): Promise<void>;
  port: number;
};

export async function startBotServiceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BotServiceServerHandle> {
  const runtime = await buildBotServiceRuntimeFromEnvAsync(env);
  const server = createTelegramWebhookHttpServer({
    config: runtime.config,
    ports: runtime.webhookPorts
  });
  const port = Number(env.BOT_SERVICE_PORT ?? 8787);
  const inboundIntervalMs = Number(env.BOT_SERVICE_INBOUND_POLL_MS ?? 100);
  let processing = false;

  const drainQueuedInputs = () => {
    if (processing) return;
    processing = true;
    void Promise.resolve(runtime.processQueuedInputs())
      .catch((error) => {
        console.error(`bot-service-inbound-drain-error:${maskServerError(error)}`);
      })
      .finally(() => {
        processing = false;
      });
  };

  const inboundTimer = setInterval(drainQueuedInputs, inboundIntervalMs);
  drainQueuedInputs();

  const outboxLoop = maybeStartOutboxLoop(env, runtime);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    port,
    close() {
      clearInterval(inboundTimer);
      outboxLoop?.stop();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

function maybeStartOutboxLoop(
  env: NodeJS.ProcessEnv,
  runtime: Awaited<ReturnType<typeof buildBotServiceRuntimeFromEnvAsync>>
): OutboxConsumerHandle | undefined {
  if (!runtime.outboxStore || env.BOT_SERVICE_OUTBOX_ENABLED === "false") return undefined;

  return startOutboxConsumerLoop({
    store: runtime.outboxStore,
    telegram: createTelegramRuntimeSender(env),
    limit: parsePositiveInteger(env.BOT_SERVICE_OUTBOX_LIMIT ?? "10", "BOT_SERVICE_OUTBOX_LIMIT"),
    leaseMs: parsePositiveInteger(env.BOT_SERVICE_OUTBOX_LEASE_MS ?? "30000", "BOT_SERVICE_OUTBOX_LEASE_MS"),
    intervalMs: parsePositiveInteger(env.BOT_SERVICE_OUTBOX_POLL_MS ?? "250", "BOT_SERVICE_OUTBOX_POLL_MS"),
    maxAttempts: parsePositiveInteger(env.BOT_SERVICE_OUTBOX_MAX_ATTEMPTS ?? "5", "BOT_SERVICE_OUTBOX_MAX_ATTEMPTS"),
    allowedChatIds: runtime.config.allowedChatIds,
    onError(error) {
      console.error(`bot-service-outbox-dispatch-error:${maskServerError(error)}`);
    }
  });
}

function parsePositiveInteger(value: string, key: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid-env:${key}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid-env:${key}`);
  return parsed;
}

function maskServerError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization|service_role)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}

function createTelegramRuntimeSender(env: NodeJS.ProcessEnv) {
  const tokenResolver = buildTelegramBotTokenResolverFromEnv(env);
  if (env.BOT_SERVICE_TELEGRAM_SENDER === "fetch") return createTelegramFetchSender({ tokenResolver });
  return createTelegramGrammySender({ tokenResolver });
}