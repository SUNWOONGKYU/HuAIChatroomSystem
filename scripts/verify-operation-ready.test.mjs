import assert from "node:assert/strict";
import test from "node:test";
import { commandForStep, operationReadySteps, parsePositiveInt, runOperationReady } from "./verify-operation-ready.mjs";

test("operation ready runner keeps gates ordered", () => {
  const steps = operationReadySteps();
  assert.equal(steps[0], "typecheck");
  assert.equal(steps.includes("verify:gate25"), true);
  assert.equal(steps.includes("verify:gate28"), true);
  assert.equal(steps.at(-1), "verify:secrets");
});

test("operation ready runner uses direct node commands for terminal checks", () => {
  assert.equal(commandForStep("verify:structure"), "node scripts/verify-structure.mjs");
  assert.equal(commandForStep("verify:secrets"), "node scripts/verify-no-secrets.mjs");
  assert.equal(commandForStep("verify:gate25"), "npm run verify:gate25");
});

test("operation ready runner stops at first failing step", () => {
  const calls = [];
  const result = runOperationReady({
    spawnImpl(command) {
      calls.push(command);
      return { status: String(command).endsWith("verify:gate13") ? 1 : 0 };
    },
    retryCount: 0,
    env: {}
  });

  assert.equal(calls.at(-1), "npm run verify:gate13");
  assert.deepEqual(result, { ok: false, failedStep: "verify:gate13", status: 1 });
});

test("operation ready runner retries a transient failing step once", () => {
  const calls = [];
  const result = runOperationReady({
    spawnImpl(command) {
      calls.push(command);
      if (String(command).endsWith("verify:gate13") && calls.filter((item) => item === command).length === 1) {
        return { status: 1 };
      }
      return { status: 0 };
    },
    sleepImpl() {},
    env: {}
  });

  assert.equal(result.ok, true);
  assert.equal(calls.filter((command) => command === "npm run verify:gate13").length, 2);
});

test("operation ready runner passes per-step timeout to spawned commands", () => {
  const spawnOptions = [];
  const result = runOperationReady({
    spawnImpl(_command, options) {
      spawnOptions.push(options);
      return { status: 0 };
    },
    retryCount: 0,
    env: { OPERATION_READY_STEP_TIMEOUT_MS: "1234" }
  });

  assert.equal(result.ok, true);
  assert.equal(spawnOptions.every((options) => options.timeout === 1234), true);
});

test("operation ready runner maps timeout failures to status 124", () => {
  const result = runOperationReady({
    spawnImpl(command) {
      return String(command).endsWith("typecheck")
        ? { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }
        : { status: 0 };
    },
    retryCount: 0,
    env: { OPERATION_READY_STEP_TIMEOUT_MS: "1" }
  });

  assert.deepEqual(result, { ok: false, failedStep: "typecheck", status: 124 });
});

test("parsePositiveInt accepts only positive integers", () => {
  assert.equal(parsePositiveInt("1500"), 1500);
  assert.equal(parsePositiveInt("0"), undefined);
  assert.equal(parsePositiveInt("nope"), undefined);
  assert.equal(parsePositiveInt(undefined), undefined);
});

test("operation ready runner does not retry timed out steps", () => {
  const calls = [];
  const result = runOperationReady({
    spawnImpl(command) {
      calls.push(command);
      return { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } };
    },
    retryCount: 2,
    env: { OPERATION_READY_STEP_TIMEOUT_MS: "1" }
  });

  assert.deepEqual(result, { ok: false, failedStep: "typecheck", status: 124 });
  assert.deepEqual(calls, ["npm run typecheck"]);
});
