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
  assert.equal(
    commandForStep("verify:supabase-functions"),
    "node scripts/verify-supabase-functions.mjs && node --test scripts/verify-supabase-functions.test.mjs"
  );
  assert.equal(commandForStep("verify:gate25"), "npm run verify:gate25");
});

test("supabase edge function tests run before the terminal secrets scan", () => {
  const steps = operationReadySteps();
  assert.equal(steps.includes("verify:supabase-functions"), true);
  assert.ok(steps.indexOf("verify:supabase-functions") < steps.indexOf("verify:secrets"));
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

// commandForStep 의 하드코딩 분기는 package.json 의 동명 스크립트와 "따로 적힌 같은 정보"다.
// 4차 감사에서 실제로 이 둘이 어긋나 있었다 — package.json 의 verify:supabase-functions 는
// 실행 스크립트와 단위 테스트를 둘 다 돌리는데, commandForStep 은 실행 스크립트만 반환해서
// verify:all 기준으로는 그 단위 테스트가 한 번도 안 돌았다(npm 스크립트에만 걸려 있는
// 은폐된 고아). 두 곳이 어긋나면 여기서 실패시킨다.
test("commandForStep 하드코딩 분기가 package.json 스크립트보다 적게 실행하지 않는다", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // commandForStep 이 npm 위임(`npm run <step>`)이 아니라 직접 명령을 반환하는 스텝만 대상.
  const overriddenSteps = operationReadySteps().filter(
    (step) => commandForStep(step) !== `npm run ${step}`
  );
  assert.ok(overriddenSteps.length > 0, "하드코딩 분기가 하나도 없으면 이 테스트가 무의미하다");

  // 명령 문자열에서 실행되는 파일 경로만 뽑는다(.mjs/.js/.ts).
  const filesIn = (command) => new Set(command.match(/[\w./-]+\.(?:mjs|cjs|js|ts)\b/g) ?? []);

  for (const step of overriddenSteps) {
    const scripted = pkg.scripts?.[step];
    if (!scripted) continue; // package.json 에 동명 스크립트가 없으면 대조할 대상이 없다.
    const missing = [...filesIn(scripted)].filter((file) => !filesIn(commandForStep(step)).has(file));
    assert.deepEqual(
      missing,
      [],
      `${step}: package.json 은 돌리는데 commandForStep 은 건너뛰는 파일이 있다 — ${missing.join(", ")}`
    );
  }
});
