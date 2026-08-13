import {
  dispatchOutboxBatch,
  type OutboxDispatchResult,
  type OutboxDispatcherStore,
  type TelegramMessageSender
} from "./outbox.js";

export type OutboxConsumerOptions = {
  store: OutboxDispatcherStore;
  telegram: TelegramMessageSender;
  limit: number;
  leaseMs: number;
  intervalMs: number;
  maxAttempts: number;
  allowedChatIds?: readonly string[];
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export type OutboxConsumerHandle = {
  stop(): void;
};

export async function runOutboxConsumerOnce(options: OutboxConsumerOptions): Promise<OutboxDispatchResult> {
  const now = options.now ?? (() => new Date());
  return dispatchOutboxBatch({
    store: options.store,
    telegram: options.telegram,
    limit: options.limit,
    leaseUntil: new Date(now().getTime() + options.leaseMs).toISOString(),
    now,
    maxAttempts: options.maxAttempts,
    allowedChatIds: options.allowedChatIds
  });
}

export function startOutboxConsumerLoop(options: OutboxConsumerOptions): OutboxConsumerHandle {
  let stopped = false;
  let running = false;

  const tick = () => {
    if (stopped || running) return;
    running = true;
    void runOutboxConsumerOnce(options)
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
