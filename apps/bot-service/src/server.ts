import { createTelegramWebhookHttpServer } from "./http.js";
import { releaseTelegramWebhooks, runTelegramPollingCycle, TelegramPollingOffsets, type TelegramPollingBot } from "./polling.js";
import { buildBotServiceRuntimeFromEnvAsync } from "./local-runtime.js";
import { buildTelegramBotTokenResolverFromEnv } from "./bot-token-resolver.js";
import { createTelegramFetchSender, createTelegramGrammySender } from "./outbox.js";
import { startOutboxConsumerLoop, type OutboxConsumerHandle } from "./consumer.js";
import { startMiniAppDecisionPollerLoop, type MiniAppDecisionPollerHandle } from "./miniapp-decision-poller.js";
import { startExecutionHeartbeatLoop, type ExecutionHeartbeatHandle } from "./execution-heartbeat.js";
import {
  createStaleProposalCleanupRunner,
  startStaleProposalCleanupLoop,
  type StaleProposalCleanupHandle
} from "./stale-proposal-cleanup.js";
import {
  listRoomIdsFromSupabase,
  startRoomBackupLoop,
  type RoomBackupSchedulerHandle
} from "./room-backup-scheduler.js";
import { createRoomBackupRestClient } from "../../../packages/supabase-runtime/src/room-backup.js";
import { checkBotServiceReadiness, type BotServiceReadinessState, type BotServiceReceiveMode } from "./readiness.js";
import { createWebhookRegistrationChecker } from "./webhook-registration-check.js";

export type BotServiceServerHandle = {
  close(): Promise<void>;
  port: number;
};

export async function startBotServiceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<BotServiceServerHandle> {
  const runtime = await buildBotServiceRuntimeFromEnvAsync(env);
  const receiveMode: BotServiceReceiveMode = (env.BOT_SERVICE_RECEIVE_MODE ?? "webhook") === "polling" ? "polling" : "webhook";
  // /readyz 가 들여다보는 상태. polling 성공 시각은 아래 maybeStartTelegramPolling 루프가
  // 채운다 — /healthz 처럼 기동 시점 설정값을 되읊는 게 아니라 실제로 최근에 수신이
  // 됐는지를 봐야 하므로, 루프가 매 사이클 갱신하는 값을 그대로 참조한다.
  const readinessState: BotServiceReadinessState = {
    receiveMode,
    pollStaleMs: parsePositiveInteger(env.BOT_SERVICE_READYZ_POLL_STALE_MS ?? "120000", "BOT_SERVICE_READYZ_POLL_STALE_MS")
  };
  const checkWebhookRegistered = buildWebhookRegistrationChecker(env, receiveMode);

  const server = createTelegramWebhookHttpServer({
    config: runtime.config,
    ports: runtime.webhookPorts,
    readiness: () =>
      checkBotServiceReadiness({
        state: readinessState,
        pingSupabase: runtime.pingSupabase,
        checkWebhookRegistered
      })
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
  const polling = await maybeStartTelegramPolling(env, runtime, readinessState);
  const executionHeartbeat = maybeStartExecutionHeartbeat(env, runtime);
  const staleProposalCleanup = maybeStartStaleProposalCleanup(env);
  const roomBackup = maybeStartRoomBackup(env);

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
      executionHeartbeat?.stop();
      staleProposalCleanup?.stop();
      roomBackup?.stop();
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
  runtime: Awaited<ReturnType<typeof buildBotServiceRuntimeFromEnvAsync>>,
  readinessState: BotServiceReadinessState
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
            },
            attachmentsDir: env.BOT_SERVICE_ATTACHMENTS_DIR,
            onAttachmentError(error) {
              console.error(`telegram-attachment-download-failed:${maskServerError(error)}`);
            }
          }
        });
        // /readyz 판정 기준. getUpdates 왕복이 끝난 것 자체가 "폴링이 살아있다"는 신호라
        // fetched 가 0건이어도 갱신한다 — 방이 조용해서 온 게 없는 것과 루프가 멈춘 것은
        // 다르다.
        readinessState.lastPollAt = new Date().toISOString();
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
    [env.BOT_SERVICE_LEADER_BOT_USERNAME, env.BOT_SERVICE_LEADER_BOT_TOKEN],
    [env.BOT_SERVICE_CLAUDE_BOT_USERNAME, env.BOT_SERVICE_CLAUDE_BOT_TOKEN],
    [env.BOT_SERVICE_CODEX_BOT_USERNAME, env.BOT_SERVICE_CODEX_BOT_TOKEN],
    [env.BOT_SERVICE_AUDITOR_BOT_USERNAME, env.BOT_SERVICE_AUDITOR_BOT_TOKEN]
  ];
  return pairs
    .filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1]))
    .map(([botUsername, token]) => ({ botUsername: botUsername.replace(/^@/, ""), token }));
}

// webhook 모드일 때만 /readyz 가 쓸 등록 상태 확인기를 만든다. 토큰 구성은
// telegramPollingBotsFromEnv 와 같은 4개 역할 봇 env 를 그대로 재사용한다 — 수신 방식과
// 무관하게 봇 토큰은 항상 이 env 들에서 온다(아웃박스 발신도 같은 값을 쓴다).
function buildWebhookRegistrationChecker(
  env: NodeJS.ProcessEnv,
  receiveMode: BotServiceReceiveMode
): (() => Promise<boolean>) | undefined {
  if (receiveMode !== "webhook") return undefined;

  const bots = telegramPollingBotsFromEnv(env);
  if (bots.length === 0) {
    console.error("bot-service-readyz-webhook-checker-unavailable:no-bot-tokens");
    return undefined;
  }

  return createWebhookRegistrationChecker({
    bots,
    publicBaseUrl: env.BOT_SERVICE_PUBLIC_BASE_URL
  });
}

// 실행이 도는 동안 방 상단에 "…이 입력 중" 을 유지한다.
//
// 실행 버튼을 누르면 그 메시지가 "▶ 실행 중입니다" 로 바뀌지만 거기서 멈춘다. 작업자가
// 몇 분씩 도는 동안 방에는 아무 변화가 없어 방장이 "먹통인지 도는 건지 모르겠다"고
// 반복해 제기했다. Telegram 에서 봇이 낼 수 있는 움직이는 신호는 이것뿐이다 — 버튼 색도
// 애니메이션도 봇이 정할 수 없다.
//
// 무엇이 도는지는 huai_outbox 의 local_gateway 행이 processing 인지로 안다. 게이트웨이가
// 리스한 것이 곧 실행 중인 것이라 별도 상태를 만들지 않는다.
function maybeStartExecutionHeartbeat(
  env: NodeJS.ProcessEnv,
  runtime: Awaited<ReturnType<typeof buildBotServiceRuntimeFromEnvAsync>>
): ExecutionHeartbeatHandle | undefined {
  if (!runtime.inFlightExecutions || env.BOT_SERVICE_EXECUTION_HEARTBEAT_ENABLED === "false") return undefined;

  const sender = createTelegramRuntimeSender(env);

  return startExecutionHeartbeatLoop({
    // Telegram 의 입력 표시는 약 5초 뒤 사라진다. 그보다 짧게 보내야 끊기지 않는다.
    intervalMs: parsePositiveInteger(env.BOT_SERVICE_EXECUTION_HEARTBEAT_MS ?? "4000", "BOT_SERVICE_EXECUTION_HEARTBEAT_MS"),
    listInFlightExecutions: () => runtime.inFlightExecutions!.listInFlightExecutions(),
    // 입력중 표시는 있으면 쓰고 없으면 건너뛴다. 경과 시간 메시지가 본체이므로, 이것 때문에
    // 하트비트 전체를 멈추지 않는다 — 실제로 그렇게 막혀 아무 표시도 안 나갔다.
    sendTypingAction: async (telegramChatId) => {
      await sender.sendChatAction?.({ botRole: "leader", telegramChatId, action: "typing" });
    },
    async sendProgressMessage(telegramChatId, text, messageThreadId) {
      const result = await sender.sendMessage({ botRole: "leader", telegramChatId, messageThreadId, text });
      return result.telegramMessageId;
    },
    async editProgressMessage(telegramChatId, messageId, text) {
      await sender.editMessageText({ botRole: "leader", telegramChatId, telegramMessageId: messageId, text });
    },
    onError(error) {
      console.error(`bot-service-execution-heartbeat-error:${maskServerError(error)}`);
    }
  });
}

// 결정되지 않고 쌓인 제안을 정리한다(결함 대응 — scripts/cancel-stale-proposals.mjs
// 는 사람이 --apply 로 직접 실행해야 하는 수동 CLI였고, 어떤 기동·스케줄 경로에도
// 연결돼 있지 않아 방장이 응답 안 한 제안이 계속 쌓였다). SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY 가 없으면(오프라인/로컬 실행 모드) 조용히 끈다 — 그
// 스크립트 자체가 이 값들을 필수로 요구한다.
function maybeStartStaleProposalCleanup(env: NodeJS.ProcessEnv): StaleProposalCleanupHandle | undefined {
  if (env.BOT_SERVICE_STALE_PROPOSAL_CLEANUP_ENABLED === "false") return undefined;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return undefined;

  return startStaleProposalCleanupLoop({
    intervalMs: parsePositiveInteger(env.BOT_SERVICE_STALE_PROPOSAL_CLEANUP_MS ?? String(60 * 60 * 1000), "BOT_SERVICE_STALE_PROPOSAL_CLEANUP_MS"),
    run: createStaleProposalCleanupRunner({ env }),
    onResult(result) {
      if (result.exitCode !== 0) {
        console.error(`bot-service-stale-proposal-cleanup-failed:${maskServerError(result.stderr || result.stdout)}`);
      } else {
        console.log(JSON.stringify({ type: "bot_service_stale_proposal_cleanup_ran" }));
      }
    },
    onError(error) {
      console.error(`bot-service-stale-proposal-cleanup-error:${maskServerError(error)}`);
    }
  });
}

// 방 전체를 주기적으로 백업한다(결함 대응 — room-backup.ts 가 조회·직렬화·저장
// 로직을 갖추고도 어떤 실행 경로에도 연결돼 있지 않아 실제로는 한 방도 백업되지
// 않았다. 자세한 설계 이유는 room-backup-scheduler.ts 헤더 주석 참고). 그 스크립트
// 자체(createRoomBackupRestClient)가 SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY 를
// 필수로 요구하므로, 오프라인/로컬 실행 모드에서는 stale-proposal-cleanup 과 같은
// 방식으로 조용히 끈다.
function maybeStartRoomBackup(env: NodeJS.ProcessEnv): RoomBackupSchedulerHandle | undefined {
  if (env.BOT_SERVICE_ROOM_BACKUP_ENABLED === "false") return undefined;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return undefined;

  const request = createRoomBackupRestClient({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });

  return startRoomBackupLoop({
    intervalMs: parsePositiveInteger(
      env.BOT_SERVICE_ROOM_BACKUP_MS ?? String(6 * 60 * 60 * 1000),
      "BOT_SERVICE_ROOM_BACKUP_MS"
    ),
    listRoomIds: listRoomIdsFromSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
    request,
    onRoomResult(roomId, result) {
      if (!result.ok) {
        console.error(`bot-service-room-backup-failed:${roomId}:${maskServerError(new Error(result.reason))}`);
      } else {
        console.log(JSON.stringify({ type: "bot_service_room_backup_ran", roomId }));
      }
    },
    onError(error) {
      console.error(`bot-service-room-backup-error:${maskServerError(error)}`);
    }
  });
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