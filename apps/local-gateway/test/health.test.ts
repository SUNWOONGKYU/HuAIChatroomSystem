import assert from "node:assert/strict";
import test from "node:test";
import { createLocalGatewayHealthServer, maskHealthError, type LocalGatewayHealthState } from "../src/health.js";

test("serves token-free healthz with loop state", async () => {
  const state: LocalGatewayHealthState = {
    startedAt: "2026-08-10T00:00:00.000Z",
    configured: true,
    lastTickAt: "2026-08-10T00:01:00.000Z",
    consecutiveErrors: 2,
    lastError: maskHealthError("Bearer top.secret bot123:SECRET")
  };
  const server = createLocalGatewayHealthServer({ state });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(body.service, "local-gateway");
    assert.equal(body.consecutiveErrors, 2);
    assert.equal(body.hasLastError, true);
    assert.equal(body.lastError, "Bearer <redacted> bot<redacted>");
    assert.equal(JSON.stringify(body).includes("top.secret"), false);
    assert.equal(JSON.stringify(body).includes("SECRET"), false);
  } finally {
    await close(server);
  }
});

test("readyz reports readiness check failure without leaking error", async () => {
  const server = createLocalGatewayHealthServer({
    state: { startedAt: "2026-08-10T00:00:00.000Z", configured: true, consecutiveErrors: 0 },
    readinessCheck: async () => { throw new Error("Bearer top.secret"); }
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 503);
    assert.deepEqual(body, { ok: false, service: "local-gateway", ready: false });
  } finally {
    await close(server);
  }
});

test("readyz returns 200 when readiness check passes", async () => {
  const server = createLocalGatewayHealthServer({
    state: { startedAt: "2026-08-10T00:00:00.000Z", configured: true, consecutiveErrors: 0 },
    readinessCheck: async () => {}
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 200);
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createLocalGatewayHealthServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("unexpected-address");
      resolve(address.port);
    });
  });
}

function close(server: ReturnType<typeof createLocalGatewayHealthServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
