import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTelegramConnectionSequence,
  formatTelegramConnectionSequence
} from "./telegram-connection-sequence.mjs";

const completeEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
  BOT_SERVICE_ROOM_ID: "11111111-1111-4111-8111-111111111111",
  BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
  BOT_SERVICE_OWNER_TELEGRAM_USER_ID: "123456789",
  BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com",
  BOT_SERVICE_LEADER_BOT_TOKEN: "tok-leader",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "tok-claude",
  BOT_SERVICE_CODEX_BOT_TOKEN: "tok-codex",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "tok-auditor",
  BOT_SERVICE_LEADER_WEBHOOK_SECRET: "sec-leader",
  BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "sec-claude",
  BOT_SERVICE_CODEX_WEBHOOK_SECRET: "sec-codex",
  BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "sec-auditor",
  BOT_SERVICE_LEADER_BOT_USERNAME: "leader_live_bot",
  BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
  BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
  BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot",
  LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\repo",
  LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code"
};

test("builds the real Telegram connection order when operation env is complete", () => {
  const sequence = buildTelegramConnectionSequence(completeEnv);

  assert.equal(sequence.ready, true);
  assert.deepEqual(sequence.errors, []);
  assert.equal(sequence.steps.map((step) => step.id).join(","), [
    "fill-env",
    "discover-ids",
    "seed-room",
    "dry-run-webhooks",
    "apply-webhooks",
    "check-live",
    "start-services"
  ].join(","));
  assert.equal(sequence.webhookPlan.length, 4);
});

test("formats a token-free blocked sequence when live values are missing", () => {
  const sequence = buildTelegramConnectionSequence({});
  const formatted = formatTelegramConnectionSequence(sequence);

  assert.equal(sequence.ready, false);
  assert.match(formatted, /Telegram connection sequence: BLOCKED/);
  assert.match(formatted, /missing-env:SUPABASE_URL/);
  assert.equal(formatted.includes("tok-leader"), false);
  assert.equal(formatted.includes("sec-leader"), false);
});

test("stays ready without a per-room chat id/owner id (multi-room operation env)", () => {
  // 예전에는 BOT_SERVICE_TELEGRAM_CHAT_ID/BOT_SERVICE_OWNER_TELEGRAM_USER_ID 가 없으면
  // ready:false 였다(REQUIRED_ROOM_KEYS). 다방화 이후 이 둘은 방 하나를 고르는 값이
  // 아니라 온보딩 호출별 인자이므로, 전체 시퀀스는 이 둘 없이도 ready 여야 한다 —
  // 그게 이 테스트의 요점이다. discover-ids 단계만 비차단으로 blocked 표시된다.
  const env = { ...completeEnv };
  delete env.BOT_SERVICE_TELEGRAM_CHAT_ID;
  delete env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID;

  const sequence = buildTelegramConnectionSequence(env);

  assert.equal(sequence.ready, true);
  assert.deepEqual(sequence.errors, []);
  const discoverStep = sequence.steps.find((step) => step.id === "discover-ids");
  assert.equal(discoverStep.status, "blocked");
  const seedRoomStep = sequence.steps.find((step) => step.id === "seed-room");
  assert.equal(seedRoomStep.status, "ready");
});

test("blocks readiness when LOCAL_GATEWAY_LEASE_MS violates the lease formula (inherited from verify-operation-env)", () => {
  // buildTelegramConnectionSequence 도 validateOperationEnv() 를 그대로 호출하므로,
  // 신규 lease 부등식 교차검증이 여기까지 전파되는지 확인한다 — 팀장이 명시적으로
  // 확인하라고 지시한 두 번째 경로다.
  const env = {
    ...completeEnv,
    LOCAL_GATEWAY_LIMIT: "5",
    LOCAL_GATEWAY_CONCURRENCY: "1",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
    LOCAL_GATEWAY_LEASE_MS: "1860000"
  };

  const sequence = buildTelegramConnectionSequence(env);
  assert.equal(sequence.ready, false);
  assert.equal(
    sequence.errors.some((error) => error.startsWith("invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed")),
    true
  );
});

test("seed-room step points at the onboarding CLI, not manual SQL paste", () => {
  // scripts/onboard-telegram-room.mjs 가 생겼으므로 "사람이 SQL 을 수동 적용한다"는
  // 예전 전제가 더 이상 기본 경로가 아니다.
  const sequence = buildTelegramConnectionSequence(completeEnv);
  const seedRoomStep = sequence.steps.find((step) => step.id === "seed-room");

  assert.match(seedRoomStep.command, /onboard-telegram-room\.mjs/);
  assert.doesNotMatch(seedRoomStep.command, /generate-supabase-room-seed\.mjs/);
});

test("formats webhook plan without leaking bot tokens or webhook secrets", () => {
  const sequence = buildTelegramConnectionSequence(completeEnv);
  const formatted = formatTelegramConnectionSequence(sequence);

  assert.match(formatted, /PLAN leader username=leader_live_bot/);
  assert.equal(formatted.includes("tok-leader"), false);
  assert.equal(formatted.includes("sec-leader"), false);
});
