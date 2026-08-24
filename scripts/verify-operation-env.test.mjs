import assert from "node:assert/strict";
import test from "node:test";
import { validateOperationEnv } from "./verify-operation-env.mjs";

test("accepts complete production operation env", () => {
  assert.deepEqual(validateOperationEnv(sampleEnv()), []);
});

test("rejects missing bot tokens and invalid gateway adapter", () => {
  const env = sampleEnv();
  delete env.BOT_SERVICE_AUDITOR_BOT_TOKEN;
  env.LOCAL_GATEWAY_ALLOWED_ADAPTERS = "codex,solar";
  env.BOT_SERVICE_OUTBOX_POLL_MS = "0";

  assert.deepEqual(validateOperationEnv(env), [
    "missing-env:BOT_SERVICE_AUDITOR_BOT_TOKEN",
    "invalid-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS:solar",
    "invalid-env:BOT_SERVICE_OUTBOX_POLL_MS"
  ]);
});

test("accepts operation env with no room selector at all (multi-room boot)", () => {
  // 다방화 이후 supabase-runtime-loader 가 huai_rooms 에서 active room 전체를 로드하므로,
  // 부팅 env 는 특정 방 하나를 더 이상 지정할 필요가 없다. 예전에는 이 둘이 모두 없으면
  // "missing-env:BOT_SERVICE_ROOM_ID|BOT_SERVICE_TELEGRAM_CHAT_ID" 로 실패했었다 —
  // 그 케이스가 이제는 통과해야 한다는 것 자체가 이 테스트의 요점이다.
  const env = sampleEnv();
  delete env.BOT_SERVICE_ROOM_ID;

  assert.deepEqual(validateOperationEnv(env), []);
});

test("rejects missing webhook secret and duplicate role credentials", () => {
  const env = sampleEnv();
  delete env.BOT_SERVICE_CODEX_WEBHOOK_SECRET;
  env.BOT_SERVICE_AUDITOR_BOT_TOKEN = env.BOT_SERVICE_LEADER_BOT_TOKEN;
  env.BOT_SERVICE_AUDITOR_WEBHOOK_SECRET = env.BOT_SERVICE_LEADER_WEBHOOK_SECRET;

  assert.deepEqual(validateOperationEnv(env), [
    "missing-env:BOT_SERVICE_CODEX_WEBHOOK_SECRET",
    "duplicate-env:BOT_SERVICE_BOT_TOKEN:BOT_SERVICE_LEADER_BOT_TOKEN:BOT_SERVICE_AUDITOR_BOT_TOKEN",
    "duplicate-env:BOT_SERVICE_WEBHOOK_SECRET:BOT_SERVICE_LEADER_WEBHOOK_SECRET:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET"
  ]);
});

// runtime.ts 의 lease 부등식(leaseMs > maxRuntimeMs * ceil(limit/concurrency))을
// verify-operation-env.mjs 가 그대로 복제해 검증한다. 2026-08-15 에 .env.operation.example
// 과 실 라이브 env 둘 다 이 부등식을 어긴 채로 있었는데, 이 검증이 없어서 부팅해봐야만
// (runtime.ts) 드러났다 — 이 테스트들이 그 재발을 막는다.

test("lease formula: accepts the current live-verified values (LIMIT/CONCURRENCY defaulted)", () => {
  const env = sampleEnv();
  delete env.LOCAL_GATEWAY_LIMIT;
  delete env.LOCAL_GATEWAY_CONCURRENCY;
  env.LOCAL_GATEWAY_MAX_RUNTIME_MS = "300000";
  env.LOCAL_GATEWAY_LEASE_MS = "660000";

  assert.deepEqual(validateOperationEnv(env), []);
});

test("lease formula: accepts the current .env.operation.example template values", () => {
  const env = sampleEnv();
  env.LOCAL_GATEWAY_LIMIT = "5";
  env.LOCAL_GATEWAY_CONCURRENCY = "3";
  env.LOCAL_GATEWAY_MAX_RUNTIME_MS = "900000";
  env.LOCAL_GATEWAY_LEASE_MS = "1860000";

  assert.deepEqual(validateOperationEnv(env), []);
});

test("lease formula: rejects when CONCURRENCY is lowered to 1 without raising LEASE_MS to match", () => {
  const env = sampleEnv();
  env.LOCAL_GATEWAY_LIMIT = "5";
  env.LOCAL_GATEWAY_CONCURRENCY = "1";
  env.LOCAL_GATEWAY_MAX_RUNTIME_MS = "900000";
  env.LOCAL_GATEWAY_LEASE_MS = "1860000"; // 템플릿 값 그대로 — concurrency=3 기준이라 1엔 부족하다

  const errors = validateOperationEnv(env);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed-LOCAL_GATEWAY_MAX_RUNTIME_MS-times-ceil/);
  // 에러 메시지 자체에 계산된 최소값과 지금 값이 들어있어야 한다 — 운영자가 이 메시지만
  // 보고 고칠 수 있어야 한다는 게 팀장 지시였다.
  assert.match(errors[0], /got-1860000-need-greater-than-4500000/);
  assert.match(errors[0], /set-LOCAL_GATEWAY_LEASE_MS-to-at-least-4500001/);
});

test("lease formula: rejects an exact boundary value (inequality is strict >, not >=)", () => {
  const env = sampleEnv();
  env.LOCAL_GATEWAY_LIMIT = "5";
  env.LOCAL_GATEWAY_CONCURRENCY = "3";
  env.LOCAL_GATEWAY_MAX_RUNTIME_MS = "900000";
  env.LOCAL_GATEWAY_LEASE_MS = "1800000"; // worstCaseBatchMs 와 정확히 같은 값

  const errors = validateOperationEnv(env);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /got-1800000-need-greater-than-1800000/);
});

test("lease formula: LIMIT/CONCURRENCY/MAX_RUNTIME_MS unset use runtime.ts's own defaults (5, 3, 1800000), not this gate's own", () => {
  const env = sampleEnv();
  delete env.LOCAL_GATEWAY_LIMIT;
  delete env.LOCAL_GATEWAY_CONCURRENCY;
  delete env.LOCAL_GATEWAY_MAX_RUNTIME_MS;
  // default worstCaseBatchMs = 1_800_000 * ceil(5/3) = 3_600_000
  env.LOCAL_GATEWAY_LEASE_MS = "3700000";
  assert.deepEqual(validateOperationEnv(env), []);

  const boundaryEnv = { ...env, LOCAL_GATEWAY_LEASE_MS: "3600000" };
  const errors = validateOperationEnv(boundaryEnv);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /computed-from-LOCAL_GATEWAY_LIMIT=5,LOCAL_GATEWAY_CONCURRENCY=3,LOCAL_GATEWAY_MAX_RUNTIME_MS=1800000/);
});

test("lease formula: skips the check entirely when LOCAL_GATEWAY_LEASE_MS is unset (runtime.ts auto-derives a safe value then)", () => {
  const env = sampleEnv();
  delete env.LOCAL_GATEWAY_LEASE_MS;
  env.LOCAL_GATEWAY_CONCURRENCY = "1"; // 극단값이어도, LEASE_MS 를 손대지 않았다면 문제없다
  assert.deepEqual(validateOperationEnv(env), []);
});

function sampleEnv() {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010",
    BOT_SERVICE_LEADER_BOT_TOKEN: "test-leader-token",
    BOT_SERVICE_CLAUDE_BOT_TOKEN: "test-claude-token",
    BOT_SERVICE_CODEX_BOT_TOKEN: "test-codex-token",
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token",
    BOT_SERVICE_LEADER_WEBHOOK_SECRET: "test-leader-secret",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "test-claude-secret",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "test-codex-secret",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "test-auditor-secret",
    BOT_SERVICE_OUTBOX_ENABLED: "true",
    BOT_SERVICE_OUTBOX_POLL_MS: "1000",
    LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem;C:\\tmp",
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code",
    LOCAL_GATEWAY_ALLOW_NETWORK: "false",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "600000"
  };
}