import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalGatewayRuntimeConfig, runLocalGatewayLoop } from "../src/runtime.js";
import { type OutboxRecord } from "../../../packages/contracts/src/index.js";

test("parses local gateway runtime env", () => {
  const config = parseLocalGatewayRuntimeConfig({
    LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\repo;C:\\tmp",
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code",
    LOCAL_GATEWAY_INTERVAL_MS: "250",
    LOCAL_GATEWAY_LIMIT: "7",
    LOCAL_GATEWAY_CONCURRENCY: "7",
    LOCAL_GATEWAY_MAX_ATTEMPTS: "4",
    LOCAL_GATEWAY_LEASE_MS: "360000",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "300000",
    LOCAL_GATEWAY_ALLOW_NETWORK: "true"
  });

  assert.deepEqual(config.policy.allowedProjectRoots, ["C:\\repo", "C:\\tmp"]);
  assert.deepEqual(config.policy.allowedAdapters, ["codex", "claude_code"]);
  assert.equal(config.intervalMs, 250);
  assert.equal(config.limit, 7);
  assert.equal(config.concurrency, 7);
  assert.equal(config.maxAttempts, 4);
  assert.equal(config.leaseMs, 360000);
  assert.equal(config.maxConsecutiveErrors, 5);
  assert.equal(config.policy.maxRuntimeMs, 300000);
  assert.equal(config.policy.allowNetwork, true);
});

test("defaults concurrency to 3 and derives a lease that covers the worst-case batch", () => {
  const config = parseLocalGatewayRuntimeConfig({
    LOCAL_GATEWAY_ALLOWED_ROOTS: process.cwd(),
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex",
    LOCAL_GATEWAY_LIMIT: "5",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000"
  });

  assert.equal(config.concurrency, 3);
  // worst case: ceil(5/3) = 2 rounds * 900000ms + 60000ms margin
  assert.equal(config.leaseMs, 900000 * 2 + 60000);
});

test("rejects a lease shorter than the worst-case batch duration for the given concurrency", () => {
  assert.throws(
    () => parseLocalGatewayRuntimeConfig({
      LOCAL_GATEWAY_ALLOWED_ROOTS: process.cwd(),
      LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex",
      LOCAL_GATEWAY_LIMIT: "5",
      LOCAL_GATEWAY_CONCURRENCY: "3",
      LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
      // ceil(5/3) * 900000 = 1800000 — this is only exactly that, must be strictly greater
      LOCAL_GATEWAY_LEASE_MS: "1800000"
    }),
    /invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed-LOCAL_GATEWAY_MAX_RUNTIME_MS-times-ceil\(LOCAL_GATEWAY_LIMIT\/LOCAL_GATEWAY_CONCURRENCY\)/
  );
});

test("fails loudly when required env is partial or invalid", () => {
  assert.throws(
    () => parseLocalGatewayRuntimeConfig({ LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex" }),
    /missing-env:LOCAL_GATEWAY_ALLOWED_ROOTS/
  );
  assert.throws(
    () => parseLocalGatewayRuntimeConfig({ LOCAL_GATEWAY_ALLOWED_ROOTS: process.cwd(), LOCAL_GATEWAY_ALLOWED_ADAPTERS: "solar" }),
    /invalid-env:LOCAL_GATEWAY_ALLOWED_ADAPTERS:solar/
  );
  assert.throws(
    () => parseLocalGatewayRuntimeConfig({
      LOCAL_GATEWAY_ALLOWED_ROOTS: process.cwd(),
      LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex",
      LOCAL_GATEWAY_INTERVAL_MS: "0"
    }),
    /invalid-env:LOCAL_GATEWAY_INTERVAL_MS/
  );
});

test("runs repeated consumer ticks until shouldContinue stops", async () => {
  let leases = 0;
  let sleeps = 0;
  const results: Array<{ leased: number; completed: number; retried: number; dead: number; rejected: number }> = [];

  await runLocalGatewayLoop(
    {
      intervalMs: 10,
      limit: 3,
      concurrency: 2,
      maxAttempts: 2,
      leaseMs: 5000,
      maxConsecutiveErrors: 2,
      policy: {
        allowedProjectRoots: [process.cwd()],
        allowedAdapters: ["codex"],
        maxRuntimeMs: 30000,
        allowNetwork: false
      }
    },
    {
      store: {
        async leasePendingLocalGateway(limit, leaseUntil): Promise<OutboxRecord[]> {
          leases += 1;
          assert.equal(limit, 3);
          assert.equal(leaseUntil, "2026-08-10T00:00:05.000Z");
          return [];
        },
        async markSent() {},
        async markRetry() {},
        async markDead() {},
        async recordGatewayExecutionResult() {}
      },
      runner: { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } },
      sink: { async publish() {} },
      setTimeout(callback) {
        sleeps += 1;
        callback();
        return undefined;
      },
      shouldContinue: () => leases < 2,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      onResult(result) {
        results.push(result);
      }
    }
  );

  assert.equal(leases, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(results.map((result) => result.leased), [0, 0]);
});

test("stops after configured consecutive loop errors", async () => {
  let attempts = 0;
  const errors: string[] = [];

  await assert.rejects(
    () => runLocalGatewayLoop(
      {
        intervalMs: 10,
        limit: 3,
        concurrency: 2,
        maxAttempts: 2,
        leaseMs: 5000,
        maxConsecutiveErrors: 2,
        policy: {
          allowedProjectRoots: [process.cwd()],
          allowedAdapters: ["codex"],
          maxRuntimeMs: 30000,
          allowNetwork: false
        }
      },
      {
        store: {
          async leasePendingLocalGateway(): Promise<OutboxRecord[]> {
            attempts += 1;
            throw new Error(`store-down-${attempts}`);
          },
          async markSent() {},
          async markRetry() {},
          async markDead() {},
          async recordGatewayExecutionResult() {}
        },
        runner: { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } },
        sink: { async publish() {} },
        setTimeout(callback) {
          callback();
          return undefined;
        },
        shouldContinue: () => true,
        now: () => new Date("2026-08-10T00:00:00.000Z"),
        onError(error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    ),
    /local-gateway-loop-error-threshold:2/
  );

  assert.deepEqual(errors, ["store-down-1", "store-down-2"]);
});

