import { isAiAdapterType, type AiAdapterType, type GatewayEvent } from "../../../packages/contracts/src/index.js";
import { runLocalGatewayConsumerOnce, type LocalGatewayConsumerResult, type LocalGatewayOutboxStore } from "./consumer.js";
import { type GatewayEventSink, type ProcessRunner } from "./executor.js";
import { type GatewayPolicy } from "./index.js";
import { createNodeProcessRunner } from "./process-runner.js";
import { buildLocalGatewaySupabaseOutboxStoreFromEnv } from "./supabase-store.js";
import { createArtifactCollector, type ArtifactCollector } from "./artifact-collector.js";
import { createPlaywrightScreenshotCapturer, type ScreenshotCapturer } from "./screenshot.js";
import { promoteDeployment } from "./artifact-publisher.js";
import { buildArtifactPromotionStore, promoteApprovedArtifacts, type ArtifactPromotionResult, type ArtifactPromotionStore } from "./artifact-promotion.js";

export type LocalGatewayRuntimeConfig = {
  intervalMs: number;
  limit: number;
  concurrency: number;
  maxAttempts: number;
  leaseMs: number;
  maxConsecutiveErrors: number;
  policy: GatewayPolicy;
};

export type LocalGatewayLoopDependencies = {
  store: LocalGatewayOutboxStore;
  runner: ProcessRunner;
  sink: GatewayEventSink;
  artifacts?: ArtifactCollector;
  // 웹 산출물을 올릴 Vercel 프로젝트. 없으면 올리지 않는다(기능 스위치).
  artifactVercelProject?: string;
  screenshot?: ScreenshotCapturer;
  // 완료 승인 난 웹 산출물을 프로덕션으로 승격한다. 없으면 프리뷰에 계속 머문다
  // (기능 스위치 — artifactVercelProject 처럼 SUPABASE 자격증명이 없는 테스트 환경에서 꺼둘 수 있다).
  artifactPromotion?: { store: ArtifactPromotionStore; promote: (deploymentUrl: string) => Promise<{ ok: boolean; failureReason?: string }> };
  setTimeout: (callback: () => void, ms: number) => unknown;
  shouldContinue: () => boolean;
  now: () => Date;
  onResult?: (result: LocalGatewayConsumerResult) => void;
  onArtifactPromotionResult?: (result: ArtifactPromotionResult) => void;
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
        artifacts: deps.artifacts,
        artifactVercelProject: deps.artifactVercelProject,
        screenshot: deps.screenshot,
        limit: config.limit,
        concurrency: config.concurrency,
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

    // 별도 try/catch — 승격이 실패해도 본 실행 루프의 연속 에러 카운터를 건드리지 않는다.
    // (승격은 완료된 작업의 뒷정리라 실패해도 새 작업 실행을 막을 이유가 없다.)
    if (deps.artifactPromotion) {
      try {
        const result = await promoteApprovedArtifacts({
          store: deps.artifactPromotion.store,
          promote: deps.artifactPromotion.promote
        });
        if (result.checked > 0) deps.onArtifactPromotionResult?.(result);
      } catch (error) {
        deps.onError?.(error);
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
    sink: createConsoleGatewayEventSink(),
    artifacts: createArtifactCollector(),
    // 실행이 만든 .html 을 여기 올려 폰에서 열 수 있게 한다. 안 두면 예전처럼 로컬 경로만 남는다.
    artifactVercelProject: env.LOCAL_GATEWAY_ARTIFACT_VERCEL_PROJECT || undefined,
    // 기본 켜짐 — chromium 이 없는 머신에서만 env 로 끈다. 캡처 자체의 playwright import 는
    // capture() 호출 시점에 지연 실행되므로, 여기서 확인 못 해도 게이트웨이 기동은 안 막힌다.
    screenshot: env.LOCAL_GATEWAY_SCREENSHOT_ENABLED === "false" ? undefined : createPlaywrightScreenshotCapturer(),
    // artifactVercelProject 와 같은 자격증명(SUPABASE_URL/SERVICE_ROLE_KEY)을 요구한다 —
    // 아웃박스 스토어가 이미 필수로 요구하는 값이라 여기선 다시 optional 처리하지 않는다.
    artifactPromotion: {
      store: buildArtifactPromotionStore({
        url: requiredEnv(env, "SUPABASE_URL"),
        serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY")
      }),
      promote: (deploymentUrl: string) => promoteDeployment(deploymentUrl)
    }
  };
}

export function parseLocalGatewayRuntimeConfig(env: NodeJS.ProcessEnv): LocalGatewayRuntimeConfig {
  const allowedProjectRoots = parseList(requiredEnv(env, "LOCAL_GATEWAY_ALLOWED_ROOTS"));
  const allowedAdapters = parseAllowedAdapters(requiredEnv(env, "LOCAL_GATEWAY_ALLOWED_ADAPTERS"));

  if (allowedProjectRoots.length === 0) throw new Error("missing-env:LOCAL_GATEWAY_ALLOWED_ROOTS");
  if (allowedAdapters.length === 0) throw new Error("missing-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS");

  const limit = parsePositiveInteger(env.LOCAL_GATEWAY_LIMIT ?? "5", "LOCAL_GATEWAY_LIMIT");
  // 뜨문뜨문 20방 / 동시 3방 요구를 맞추려면 배치 안의 행을 순차가 아니라 동시에 처리해야 한다.
  // 기본값 3 = "동시 사용 3방" 요구를 그대로 반영한 값. env로 조절 가능.
  const concurrency = parsePositiveInteger(env.LOCAL_GATEWAY_CONCURRENCY ?? "3", "LOCAL_GATEWAY_CONCURRENCY");
  const maxRuntimeMs = parsePositiveInteger(env.LOCAL_GATEWAY_MAX_RUNTIME_MS ?? "1800000", "LOCAL_GATEWAY_MAX_RUNTIME_MS");

  // 배치 limit 개 행을 동시성 concurrency로 나눠 처리하면, 최악의 경우
  // ceil(limit / concurrency) "라운드"가 필요하고 각 라운드는 최대 maxRuntimeMs 걸릴 수 있다.
  // lease가 이보다 짧으면 아직 실행 중인 행의 locked_until이 만료돼 재리스 → 같은 CLI가 중복 실행된다.
  const worstCaseBatchMs = maxRuntimeMs * Math.ceil(limit / concurrency);
  const leaseMs = parsePositiveInteger(env.LOCAL_GATEWAY_LEASE_MS ?? String(worstCaseBatchMs + 60_000), "LOCAL_GATEWAY_LEASE_MS");
  if (leaseMs <= worstCaseBatchMs) {
    throw new Error(
      "invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed-LOCAL_GATEWAY_MAX_RUNTIME_MS-times-ceil(LOCAL_GATEWAY_LIMIT/LOCAL_GATEWAY_CONCURRENCY)"
    );
  }

  return {
    intervalMs: parsePositiveInteger(env.LOCAL_GATEWAY_INTERVAL_MS ?? "5000", "LOCAL_GATEWAY_INTERVAL_MS"),
    limit,
    concurrency,
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
    if (!isAiAdapterType(item)) {
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


