import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramWebhookHttpServer } from "../src/http.js";
import { type BotServiceReadinessResult } from "../src/readiness.js";

test("serves token-free bot-service health response", async () => {
  const server = createTelegramWebhookHttpServer({
    config: {
      allowedChatIds: ["1001", "1002"],
      botsByUsername: new Map([
        ["leader_bot", { telegramBotId: "bot-1", botUsername: "leader_bot", botRole: "leader", webhookSecret: "secret-1" }],
        ["claude_bot", { telegramBotId: "bot-2", botUsername: "claude_bot", botRole: "claude_leader", webhookSecret: "secret-2" }],
        ["codex_bot", { telegramBotId: "bot-3", botUsername: "codex_bot", botRole: "codex_leader", webhookSecret: "secret-3" }],
        ["auditor_bot", { telegramBotId: "bot-4", botUsername: "auditor_bot", botRole: "auditor", webhookSecret: "secret-4" }]
      ])
    },
    ports: {
      updates: {
        async recordUpdateOnce() { throw new Error("unused"); },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue() {} }
    }
  });

  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await response.json() as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, service: "bot-service", bots: 4, allowedChats: 2 });
    assert.equal(JSON.stringify(body).includes("secret"), false);
  } finally {
    await close(server);
  }
});

// /healthz 는 설정값만 보는 liveness 라 항상 200 이다. /readyz 는 실제 의존성을 확인해야
// 한다는 게 이 프로젝트 최우선 규칙("curl 200 ≠ 동작함")이다. 아래는 그 규칙이 실제 HTTP
// 응답 코드까지 뒤집는지 확인한다.

test("readiness 를 안 넘기면 /readyz 는 확인할 게 없으니 200이다(저수준 API 직접 사용)", async () => {
  const server = createBareServer();
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(response.status, 200);
  } finally {
    await close(server);
  }
});

test("의존성이 모두 정상이면 /readyz 는 200이다", async () => {
  const server = createBareServer({
    readiness: async () => okReadiness()
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(body.ready, true);
  } finally {
    await close(server);
  }
});

test("Supabase 가 죽으면 /readyz 는 503이다", async () => {
  const server = createBareServer({
    readiness: async () => ({
      ready: false,
      checks: {
        supabase: { ok: false, detail: "supabase-rest-error:503" },
        receive: { ok: true, mode: "polling" }
      }
    })
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 503);
    assert.equal(body.ready, false);
  } finally {
    await close(server);
  }
});

test("폴링이 멎어 있으면(stale) /readyz 는 503이다", async () => {
  const server = createBareServer({
    readiness: async () => ({
      ready: false,
      checks: {
        supabase: { ok: true },
        receive: { ok: false, mode: "polling", detail: "stale-poll:999999ms" }
      }
    })
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 503);
    assert.deepEqual((body.checks as Record<string, unknown>).receive, { ok: false, mode: "polling", detail: "stale-poll:999999ms" });
  } finally {
    await close(server);
  }
});

function okReadiness(): BotServiceReadinessResult {
  return { ready: true, checks: { supabase: { ok: true }, receive: { ok: true, mode: "polling" } } };
}

function createBareServer(extra: { readiness?: () => Promise<BotServiceReadinessResult> } = {}) {
  return createTelegramWebhookHttpServer({
    config: {
      allowedChatIds: ["1001", "1002"],
      botsByUsername: new Map([
        ["leader_bot", { telegramBotId: "bot-1", botUsername: "leader_bot", botRole: "leader", webhookSecret: "secret-1" }]
      ])
    },
    ports: {
      updates: {
        async recordUpdateOnce() { throw new Error("unused"); },
        async markUpdateFailed() {}
      },
      inboundQueue: { async enqueue() {} }
    },
    ...extra
  });
}

function listen(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("unexpected-address");
      const port = address.port;
      resolve(port);
    });
  });
}

function close(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
