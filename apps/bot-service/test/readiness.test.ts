import assert from "node:assert/strict";
import test from "node:test";
import { checkBotServiceReadiness, type BotServiceReadinessState } from "../src/readiness.js";

// /healthz 는 설정값만 보는 liveness 라 Supabase 가 끊기거나 폴링이 멎어도 200 을 준다.
// /readyz 는 실제 의존성을 확인해야 한다는 게 이 프로젝트 최우선 규칙("curl 200 ≠ 동작함")
// 이므로, 판정 로직 자체가 각 실패 모드를 정확히 503 으로 뒤집는지 여기서 순수하게 본다.

test("모든 의존성이 정상이면 준비완료다 (polling)", async () => {
  const state: BotServiceReadinessState = {
    receiveMode: "polling",
    lastPollAt: new Date(1_000_000).toISOString(),
    pollStaleMs: 60_000
  };
  const result = await checkBotServiceReadiness({
    state,
    pingSupabase: async () => undefined,
    now: () => 1_010_000
  });

  assert.equal(result.ready, true);
  assert.equal(result.checks.supabase.ok, true);
  assert.equal(result.checks.receive.ok, true);
  assert.equal(result.checks.receive.mode, "polling");
});

test("Supabase 핑이 실패하면 다른 게 다 정상이어도 준비 안 됨이다", async () => {
  const state: BotServiceReadinessState = {
    receiveMode: "polling",
    lastPollAt: new Date(1_000_000).toISOString(),
    pollStaleMs: 60_000
  };
  const result = await checkBotServiceReadiness({
    state,
    pingSupabase: async () => {
      throw new Error("supabase-rest-error:503:down");
    },
    now: () => 1_010_000
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.supabase.ok, false);
  assert.match(result.checks.supabase.detail ?? "", /down/);
});

test("아직 한 번도 폴링에 성공한 적이 없으면 준비 안 됨이다", async () => {
  const state: BotServiceReadinessState = { receiveMode: "polling", pollStaleMs: 60_000 };
  const result = await checkBotServiceReadiness({ state, pingSupabase: async () => undefined });

  assert.equal(result.ready, false);
  assert.equal(result.checks.receive.detail, "no-successful-poll-yet");
});

test("마지막 성공 폴링이 임계치를 넘게 오래되면 준비 안 됨이다", async () => {
  const state: BotServiceReadinessState = {
    receiveMode: "polling",
    lastPollAt: new Date(0).toISOString(),
    pollStaleMs: 60_000
  };
  const result = await checkBotServiceReadiness({
    state,
    pingSupabase: async () => undefined,
    now: () => 120_000
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.receive.ok, false);
  assert.match(result.checks.receive.detail ?? "", /stale-poll/);
});

test("Supabase 의존성이 없는(local) 모드는 그 항목을 통과로 본다", async () => {
  const state: BotServiceReadinessState = {
    receiveMode: "polling",
    lastPollAt: new Date().toISOString(),
    pollStaleMs: 60_000
  };
  const result = await checkBotServiceReadiness({ state });

  assert.equal(result.checks.supabase.ok, true);
});

test("webhook 모드에서 등록이 확인되면 준비완료다", async () => {
  const state: BotServiceReadinessState = { receiveMode: "webhook", pollStaleMs: 60_000 };
  const result = await checkBotServiceReadiness({
    state,
    pingSupabase: async () => undefined,
    checkWebhookRegistered: async () => true
  });

  assert.equal(result.ready, true);
  assert.equal(result.checks.receive.mode, "webhook");
});

test("webhook 모드에서 등록이 안 돼 있으면 준비 안 됨이다", async () => {
  const state: BotServiceReadinessState = { receiveMode: "webhook", pollStaleMs: 60_000 };
  const result = await checkBotServiceReadiness({
    state,
    pingSupabase: async () => undefined,
    checkWebhookRegistered: async () => false
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.receive.detail, "webhook-not-registered");
});

test("webhook 모드인데 확인 수단이 없으면 통과가 아니라 실패다", async () => {
  const state: BotServiceReadinessState = { receiveMode: "webhook", pollStaleMs: 60_000 };
  const result = await checkBotServiceReadiness({ state, pingSupabase: async () => undefined });

  assert.equal(result.ready, false);
  assert.equal(result.checks.receive.detail, "webhook-check-unavailable");
});
