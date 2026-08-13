import { type AiAdapterType, type GatewayEvent } from "../../../packages/contracts/src/index.js";
import { runLocalGatewayConsumerOnce, type LocalGatewayConsumerResult, type LocalGatewayOutboxStore } from "./consumer.js";
import { type GatewayEventSink, type ProcessRunner } from "./executor.js";
import { type GatewayPolicy } from "./index.js";
import { createNodeProcessRunner } from "./process-runner.js";
import { buildLocalGatewaySupabaseOutboxStoreFromEnv } from "./supabase-store.js";

export type LocalGatewayRuntimeConfig = {
  intervalMs: number;
  limit: number;
  maxAttempts: number;
  leaseMs: number;
  maxConsecutiveErrors: number;
  policy: GatewayPolicy;
};

export type LocalGatewayLoopDependencies = {
  store: LocalGatewayOutboxStore;
  runner: ProcessRunner;
  sink: GatewayEventSink;
  setTimeout: (callback: () => void, ms: number) => unknown;
  shouldContinue: () => boolean;
  now: () => Date;
  onResult?: (result: LocalGatewayConsumerResult) => void;
  onError?: (error: unknown) => void;
};

export async function runLocalGatewayLoop(
  config: LocalGatewayRuntimeConfig,
  deps: LocalGatewayLoopDependencies
): Promise<void> {
  let consecutiveErrors = 0;
  while (deps.shouldContinue()) {
    try {
      const now = deps.now();
      const result = await runLocalGatewayConsumerOnce({
        store: deps.store,
        policy: config.policy,
        runner: deps.runner,
        sink: deps.sink,
        limit: config.limit,
        leaseUntil: new Date(now.getTime() + config.leaseMs).toISOString(),
        maxAttempts: config.maxAttempts,
        now: () => deps.now().toISOString()
      });
      deps.onResult?.(result);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      deps.onError?.(error);
      if (consecutiveErrors >= config.maxConsecutiveErrors) {
        throw new Error(`local-gateway-loop-error-threshold:${consecutiveErrors}`);
      }
    }

    if (!deps.shouldContinue()) return;
    await delay(config.intervalMs, deps.setTimeout);
  }
}

export function buildLocalGatewayRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const config = parseLocalGatewayRuntimeConfig(env);
  return {
    config,
    store: buildLocalGatewaySupabaseOutboxStoreFromEnv(env),
    runner: createNodeProcessRunner(),
    sink: createConsoleGatewayEventSink()
  };
}

export function parseLocalGatewayRuntimeConfig(env: NodeJS.ProcessEnv): LocalGatewayRuntimeConfig {
  const allowedProjectRoots = parseList(requiredEnv(env, "LOCAL_GATEWAY_ALLOWED_ROOTS"));
  const allowedAdapters = parseAllowedAdapters(requiredEnv(env, "LOCAL_GATEWAY_ALLOWED_ADAPTERS"));

  if (allowedProjectRoots.length === 0) throw new Error("missing-env:LOCAL_GATEWAY_ALLOWED_ROOTS");
  if (allowedAdapters.length === 0) throw new Error("missing-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS");

  const maxRuntimeMs = parsePositiveInteger(env.LOCAL_GATEWAY_MAX_RUNTIME_MS ?? "1800000", "LOCAL_GATEWAY_MAX_RUNTIME_MS");
  const leaseMs = parsePositiveInteger(env.LOCAL_GATEWAY_LEASE_MS ?? String(maxRuntimeMs + 60_000), "LOCAL_GATEWAY_LEASE_MS");
  if (leaseMs <= maxRuntimeMs) throw new Error("invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed-LOCAL_GATEWAY_MAX_RUNTIME_MS");

  return {
    intervalMs: parsePositiveInteger(env.LOCAL_GATEWAY_INTERVAL_MS ?? "5000", "LOCAL_GATEWAY_INTERVAL_MS"),
    limit: parsePositiveInteger(env.LOCAL_GATEWAY_LIMIT ?? "5", "LOCAL_GATEWAY_LIMIT"),
    maxAttempts: parsePositiveInteger(env.LOCAL_GATEWAY_MAX_ATTEMPTS ?? "3", "LOCAL_GATEWAY_MAX_ATTEMPTS"),
    leaseMs,
    maxConsecutiveErrors: parsePositiveInteger(
      env.LOCAL_GATEWAY_MAX_CONSECUTIVE_ERRORS ?? "5",
      "LOCAL_GATEWAY_MAX_CONSECUTIVE_ERRORS"
    ),
    policy: {
      allowedProjectRoots,
      allowedAdapters,
      maxRuntimeMs,
      allowNetwork: parseBoolean(env.LOCAL_GATEWAY_ALLOW_NETWORK ?? "false", "LOCAL_GATEWAY_ALLOW_NETWORK")
    }
  };
}

export function createConsoleGatewayEventSink(): GatewayEventSink {
  return {
    async publish(event: GatewayEvent) {
      console.log(JSON.stringify(event));
    }
  };
}

function delay(ms: number, setTimeoutImpl: LocalGatewayLoopDependencies["setTimeout"]): Promise<void> {
  return new Promise((resolve) => {
    setTimeoutImpl(resolve, ms);
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function parseList(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAllowedAdapters(value: string): AiAdapterType[] {
  return parseList(value).map((item) => {
    if (item !== "codex" && item !== "claude_code") {
      throw new Error(`invalid-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS:${item}`);
    }
    return item;
  });
}

function parsePositiveInteger(value: string, key: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid-env:${key}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`invalid-env:${key}`);
  return parsed;
}

function parseBoolean(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid-env:${key}`);
}


