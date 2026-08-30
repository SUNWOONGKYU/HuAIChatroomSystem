import assert from "node:assert/strict";
import test from "node:test";
import { createWebhookRegistrationChecker } from "../src/webhook-registration-check.js";

function fetchReturning(url: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, result: { url } }), { status: 200 })) as unknown as typeof fetch;
}

test("등록된 URL이 기대한 webhook 경로와 일치하면 true다", async () => {
  const checker = createWebhookRegistrationChecker({
    bots: [{ botUsername: "leader_bot", token: "tok-1" }],
    publicBaseUrl: "https://example.com",
    fetchImpl: fetchReturning("https://example.com/telegram/webhook/leader_bot")
  });

  assert.equal(await checker(), true);
});

test("등록된 URL이 다르면 false다", async () => {
  const checker = createWebhookRegistrationChecker({
    bots: [{ botUsername: "leader_bot", token: "tok-1" }],
    publicBaseUrl: "https://example.com",
    fetchImpl: fetchReturning("https://old-tunnel.example.com/telegram/webhook/leader_bot")
  });

  assert.equal(await checker(), false);
});

test("publicBaseUrl 이 없으면 무언가에 등록만 돼 있어도 true다", async () => {
  const checker = createWebhookRegistrationChecker({
    bots: [{ botUsername: "leader_bot", token: "tok-1" }],
    fetchImpl: fetchReturning("https://anything.example.com/telegram/webhook/leader_bot")
  });

  assert.equal(await checker(), true);
});

test("webhook 이 아예 등록 안 돼 있으면(빈 url) false다", async () => {
  const checker = createWebhookRegistrationChecker({
    bots: [{ botUsername: "leader_bot", token: "tok-1" }],
    fetchImpl: fetchReturning("")
  });

  assert.equal(await checker(), false);
});

test("봇 목록이 비어 있으면 false다", async () => {
  const checker = createWebhookRegistrationChecker({ bots: [], fetchImpl: fetchReturning("https://x/y") });

  assert.equal(await checker(), false);
});

test("TTL 안에서는 캐시된 값을 쓰고 Telegram 을 다시 부르지 않는다", async () => {
  let calls = 0;
  let now = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, result: { url: "https://example.com/telegram/webhook/leader_bot" } }), {
      status: 200
    });
  }) as unknown as typeof fetch;

  const checker = createWebhookRegistrationChecker({
    bots: [{ botUsername: "leader_bot", token: "tok-1" }],
    publicBaseUrl: "https://example.com",
    fetchImpl,
    cacheTtlMs: 1000,
    now: () => now
  });

  await checker();
  now = 500;
  await checker();
  assert.equal(calls, 1, "TTL 안에서는 재호출하지 않아야 한다");

  now = 1500;
  await checker();
  assert.equal(calls, 2, "TTL 이 지나면 다시 확인해야 한다");
});
