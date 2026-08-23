import { buildLocalGatewayRuntimeFromEnv, runLocalGatewayLoop } from "./runtime.js";
import { createLocalGatewayHealthServer, maskHealthError, type LocalGatewayHealthState } from "./health.js";

const runtime = buildLocalGatewayRuntimeFromEnv();
let running = true;
const healthState: LocalGatewayHealthState = {
  startedAt: new Date().toISOString(),
  configured: true,
  consecutiveErrors: 0
};
const healthServer = maybeStartHealthServer();

process.once("SIGINT", () => {
  running = false;
  healthServer?.close();
});
process.once("SIGTERM", () => {
  running = false;
  healthServer?.close();
});

await runLocalGatewayLoop(runtime.config, {
  store: runtime.store,
  runner: runtime.runner,
  sink: runtime.sink,
  artifacts: runtime.artifacts,
  // 이 한 줄이 빠져 있어서 웹 산출물 배포가 통째로 꺼져 있었다 — 런타임이 환경변수를
  // 읽어놓고도 루프까지 전달되지 않아, 게임을 만들어도 공개 주소가 안 붙었다.
  artifactVercelProject: runtime.artifactVercelProject,
  screenshot: runtime.screenshot,
  artifactPromotion: runtime.artifactPromotion,
  setTimeout,
  shouldContinue: () => running,
  now: () => new Date(),
  onResult(result) {
    healthState.lastTickAt = new Date().toISOString();
    healthState.consecutiveErrors = 0;
    healthState.lastError = undefined;
    console.log(JSON.stringify({ type: "local_gateway_tick", ...result }));
  },
  onArtifactPromotionResult(result) {
    console.log(JSON.stringify({ type: "local_gateway_artifact_promotion", ...result }));
  },
  onError(error) {
    healthState.consecutiveErrors += 1;
    healthState.lastError = maskHealthError(error);
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ type: "local_gateway_error", error: maskHealthError(message) }));
  }
});

function maybeStartHealthServer() {
  const rawPort = process.env.LOCAL_GATEWAY_HEALTH_PORT;
  if (!rawPort) return undefined;
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error("invalid-env:LOCAL_GATEWAY_HEALTH_PORT");
  const server = createLocalGatewayHealthServer({
    state: healthState,
    readinessCheck: async () => {
      await runtime.store.leasePendingLocalGateway(0, new Date().toISOString());
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ type: "local_gateway_health_listening", port }));
  });
  return server;
}
