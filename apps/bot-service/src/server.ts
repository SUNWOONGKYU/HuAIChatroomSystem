import { createTelegramWebhookHttpServer } from "./http.js";
import { releaseTelegramWebhooks, runTelegramPollingCycle, TelegramPollingOffsets, type TelegramPollingBot } from "./polling.js";
import { buildBotServiceRuntimeFromEnvAsync } from "./local-runtime.js";
import { buildTelegramBotTokenResolverFromEnv } from "./bot-token-resolver.js";
import { createTelegramFetchSender, createTelegramGrammySender } from "./outbox.js";
import { startOutboxConsumerLoop, type OutboxConsumerHandle } from "./consumer.js";
import { startMiniAppDecisionPollerLoop, type MiniAppDecisionPollerHandle } from "./miniapp-decision-poller.js";

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
  const miniAppDecisionPolling = maybeStartMiniAppDecisionPolling(env, runtime);
  const polling = await maybeStartTelegramPolling(env, runtime);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    port,
    close() {
      clearInterval(inboundTimer);
      outboxLoop?.stop();
      miniAppDecisionPolling?.stop();
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

// Mini App 승인 버튼은 huai_approvals 에 기록만 남기고 그 자체로는 아무 실행도
// 일으키지 않는다 — 유일한 실행 트리거는 huai_outbox 의 local_gateway pending 행이고,
// 그건 SupabaseBotServiceStore.commitTelegramInputResult(= Telegram 경로)만 만든다.
// bot-service 는 이미 인바운드 드레인(100ms)·아웃박스 루프를 상주 프로세스로 돌리므로,
// 폴러 하나 더 추가하는 비용은 사실상 0 이고 아웃바운드 방향이라 공개 URL·방화벽 개방이
// 필요 없다(server.ts:42 가 127.0.0.1 bind 라 클라우드 Edge Function 에서 직접 못 부른다 —
// 그래서 로컬 PC 를 여는 대신 이 폴러가 대신 당겨온다).
function maybeStartMiniAppDecisionPolling(
  env: NodeJS.ProcessEnv,
  runtime: Awaited<ReturnType<typeof buildBotServiceRuntimeFromEnvAsync>>
): MiniAppDecisionPollerHandle | undefined {
  if (!runtime.miniAppDecisionPolling || env.BOT_SERVICE_MINIAPP_POLL_ENABLED === "false") return undefined;

  return startMiniAppDecisionPollerLoop({
    ...runtime.miniAppDecisionPolling,
    limit: parsePositiveInteger(env.BOT_SERVICE_MINIAPP_POLL_LIMIT ?? "20", "BOT_SERVICE_MINIAPP_POLL_LIMIT"),
    intervalMs: parsePositiveInteger(env.BOT_SERVICE_MINIAPP_POLL_MS ?? "3000", "BOT_SERVICE_MINIAPP_POLL_MS"),
    onDecisionOutcome(event) {
      // 실행까지 이어진 것과, 의도적으로 건너뛴 것과, 못 정한 것(재시도 대상)을
      // 로그에서 구분할 수 있어야 한다 — "결정 하나가 조용히 죽어 있는데 아무도
      // 모르는" 상황을 여기서도 반복하지 않기 위해서다.
      if (event.outcome === "failed" || event.outcome === "skipped_unauthorized") {
        console.error(JSON.stringify({ type: "bot_service_miniapp_decision_outcome", ...event }));
      } else {
        console.log(JSON.stringify({ type: "bot_service_miniapp_decision_outcome", ...event }));
      }
    },
    onError(error) {
      console.error(`bot-service-miniapp-decision-poll-error:${maskServerError(error)}`);
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