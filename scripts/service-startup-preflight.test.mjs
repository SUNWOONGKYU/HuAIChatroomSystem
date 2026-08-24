import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServiceStartupPreflight,
  formatServiceStartupPreflight
} from "./service-startup-preflight.mjs";

const completeEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
  BOT_SERVICE_ROOM_ID: "11111111-1111-4111-8111-111111111111",
  BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
  BOT_SERVICE_PUBLIC_BASE_URL: "https://ops.example.com",
  BOT_SERVICE_PORT: "8787",
  BOT_SERVICE_LEADER_BOT_TOKEN: "tok-leader",
  BOT_SERVICE_CLAUDE_BOT_TOKEN: "tok-claude",
  BOT_SERVICE_CODEX_BOT_TOKEN: "tok-codex",
  BOT_SERVICE_AUDITOR_BOT_TOKEN: "tok-auditor",
  BOT_SERVICE_LEADER_WEBHOOK_SECRET: "sec-leader",
  BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "sec-claude",
  BOT_SERVICE_CODEX_WEBHOOK_SECRET: "sec-codex",
  BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "sec-auditor",
  LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem",
  LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code",
  LOCAL_GATEWAY_HEALTH_PORT: "8797"
};

test("builds startup commands and health checks for both operation services", () => {
  const preflight = buildServiceStartupPreflight(completeEnv);

  assert.equal(preflight.ready, true);
  assert.deepEqual(preflight.commands, [
    "npm run build",
    "node dist/apps/bot-service/src/cli.js",
    "node dist/apps/local-gateway/src/cli.js"
  ]);
  assert.deepEqual(preflight.checks, [
    "http://127.0.0.1:8787/healthz",
    "http://127.0.0.1:8797/healthz",
    "http://127.0.0.1:8797/readyz"
  ]);
});

test("is ready without a room selector (multi-room boot, inherited from verify-operation-env)", () => {
  // service-startup-preflight 는 validateOperationEnv() 를 그대로 호출하므로,
  // 다방화 이후 room selector 완화가 여기까지 자동 전파돼야 한다 — 별도 코드
  // 변경 없이도 이 케이스가 통과함을 확인한다.
  const env = { ...completeEnv };
  delete env.BOT_SERVICE_ROOM_ID;
  delete env.BOT_SERVICE_TELEGRAM_CHAT_ID;

  const preflight = buildServiceStartupPreflight(env);
  assert.equal(preflight.ready, true);
});

test("blocks startup when LOCAL_GATEWAY_LEASE_MS violates the lease formula (inherited from verify-operation-env)", () => {
  // service-startup-preflight 는 validateOperationEnv() 를 그대로 호출하므로, 신규 lease
  // 부등식 교차검증도 별도 코드 변경 없이 여기까지 전파돼야 한다 — 팀장이 명시적으로
  // 확인하라고 지시한 경로다.
  const env = {
    ...completeEnv,
    LOCAL_GATEWAY_LIMIT: "5",
    LOCAL_GATEWAY_CONCURRENCY: "1",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
    LOCAL_GATEWAY_LEASE_MS: "1860000" // concurrency=3 기준 값 — concurrency=1 에는 부족하다
  };

  const preflight = buildServiceStartupPreflight(env);
  assert.equal(preflight.ready, false);
  assert.equal(
    preflight.errors.some((error) => error.startsWith("invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed")),
    true
  );
});

test("blocks startup when required env or port values are invalid", () => {
  const preflight = buildServiceStartupPreflight({ BOT_SERVICE_PORT: "not-a-port" });

  assert.equal(preflight.ready, false);
  assert.equal(preflight.errors.includes("invalid-env:BOT_SERVICE_PORT"), true);
  assert.equal(preflight.errors.some((error) => error.startsWith("missing-env:SUPABASE_URL")), true);
});

test("formats startup preflight without leaking token or secret values", () => {
  const formatted = formatServiceStartupPreflight(buildServiceStartupPreflight(completeEnv));

  assert.match(formatted, /Service startup preflight: READY/);
  assert.equal(formatted.includes("tok-leader"), false);
  assert.equal(formatted.includes("sec-leader"), false);
});
