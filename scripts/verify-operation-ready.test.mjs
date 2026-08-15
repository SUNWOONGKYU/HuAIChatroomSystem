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

test("multi-room offline gate is wired in, before the terminal secrets scan", () => {
  const steps = operationReadySteps();
  assert.equal(steps.includes("verify:multiroom"), true);
  assert.equal(steps.includes("verify:multiroom-offline"), true);
  // verify:secrets 는 마지막 관문이어야 한다 — 그 뒤에 들어가면 실질적으로 검증 안 된
  // 상태로 "ready" 처리될 수 있다.
  assert.ok(steps.indexOf("verify:multiroom-offline") < steps.indexOf("verify:secrets"));
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
    env: { HUAI_PREBUILT: "1" }
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
    env: { HUAI_PREBUILT: "1" }
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
    env: { HUAI_PREBUILT: "1", OPERATION_READY_STEP_TIMEOUT_MS: "1234" }
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
    env: { HUAI_PREBUILT: "1", OPERATION_READY_STEP_TIMEOUT_MS: "1" }
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
    env: { HUAI_PREBUILT: "1", OPERATION_READY_STEP_TIMEOUT_MS: "1" }
  });

  assert.deepEqual(result, { ok: false, failedStep: "typecheck", status: 124 });
  assert.deepEqual(calls, ["npm run typecheck"]);
});


test("전체 검증은 빌드를 한 번만 하고 게이트에서는 다시 하지 않는다", () => {
  // 게이트마다 tsc 를 돌리면 Windows 에서 dist 쓰기가 간헐 실패해
  // 매번 다른 게이트가 깨졌다(gate12·18·20·25·30 이 번갈아).
  const calls = [];
  runOperationReady({
    spawnImpl(command, options) {
      calls.push({ command, prebuilt: options?.env?.HUAI_PREBUILT });
      return { status: 0 };
    },
    retryCount: 0,
    env: {}
  });

  assert.equal(calls[0]?.command, "npm run build:force", "맨 앞에서 한 번 빌드해야 한다");
  assert.equal(calls.filter((call) => call.command === "npm run build:force").length, 1);
  assert.equal(calls.slice(1).every((call) => call.prebuilt === "1"), true, "이후 게이트는 재빌드를 건너뛰어야 한다");
});
