import { createTelegramWebhookHttpServer } from "./http.js";
import { releaseTelegramWebhooks, runTelegramPollingCycle, TelegramPollingOffsets, type TelegramPollingBot } from "./polling.js";
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
  const polling = await maybeStartTelegramPolling(env, runtime);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    port,
    close() {
      clearInterval(inboundTimer);
      outboxLoop?.stop();
      polling?.stop();
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

// Telegram 수신 방식.
//
// webhook 은 공개 URL 이 있어야 하고, 임시 터널은 주소가 바뀌거나 끊기면 방이 통째로 멎는다.
// polling 은 우리가 Telegram 에 가져오는 방식이라 공개 URL·도메인·추가 가입이 필요 없다.
// BOT_SERVICE_RECEIVE_MODE=polling 이면 켠다.
async function maybeStartTelegramPolling(
  env: NodeJS.ProcessEnv,
  runtime: Awaited<ReturnType<typeof buildBotServiceRuntimeFromEnvAsync>>
): Promise<{ stop(): void } | undefined> {
  if ((env.BOT_SERVICE_RECEIVE_MODE ?? "webhook") !== "polling") return undefined;

  const bots = telegramPollingBotsFromEnv(env);
  if (bots.length === 0) {
    console.error("bot-service-polling-disabled:no-bot-tokens");
    return undefined;
  }

  // 같은 토큰에 webhook 이 남아 있으면 Telegram 이 getUpdates 를 409 로 거절한다.
  const released = await releaseTelegramWebhooks(bots);
  for (const item of released) {
    if (!item.ok) console.error(`bot-service-polling-webhook-release-failed:${item.botUsername}`);
  }

  const offsets = new TelegramPollingOffsets();
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const result = await runTelegramPollingCycle({
          bots,
          config: runtime.config,
          ports: runtime.webhookPorts,
          offsets,
          deps: {
            onIgnored(botUsername, reason) {
              if (reason !== "bot-message-ignored") console.log(JSON.stringify({ type: "telegram_polling_ignored", botUsername, reason }));
            }
          }
        });
        if (result.fetched > 0) console.log(JSON.stringify({ type: "telegram_polling_cycle", ...result }));
      } catch (error) {
        console.error(`bot-service-polling-error:${maskServerError(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  };
  void loop();

  console.log(JSON.stringify({ type: "telegram_polling_started", bots: bots.length }));
  return { stop() { running = false; } };
}

function telegramPollingBotsFromEnv(env: NodeJS.ProcessEnv): TelegramPollingBot[] {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [env.BOT_SERVICE_PLATOON_BOT_USERNAME, env.BOT_SERVICE_PLATOON_BOT_TOKEN],
    [env.BOT_SERVICE_CLAUDE_BOT_USERNAME, env.BOT_SERVICE_CLAUDE_BOT_TOKEN],
    [env.BOT_SERVICE_CODEX_BOT_USERNAME, env.BOT_SERVICE_CODEX_BOT_TOKEN],
    [env.BOT_SERVICE_AUDITOR_BOT_USERNAME, env.BOT_SERVICE_AUDITOR_BOT_TOKEN]
  ];
  return pairs
    .filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1]))
    .map(([botUsername, token]) => ({ botUsername: botUsername.replace(/^@/, ""), token }));
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