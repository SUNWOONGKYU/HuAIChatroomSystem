import assert from "node:assert/strict";
import test from "node:test";
import {
  multiRoomOfflineChecks,
  liveOnlyItems,
  runMultiRoomOfflineChecks,
  formatMultiRoomOfflineReport,
  DEFAULT_SEQUENTIAL_ROOM_TARGET,
  DEFAULT_CONCURRENT_ROOM_TARGET,
  CONCURRENT_READ_ANOMALY_THRESHOLD_MS,
  KPI_DISCLAIMER,
  runLiveMultiRoomMeasurement,
  formatLiveMultiRoomReport
} from "./verify-multiroom.mjs";

// ---------------------------------------------------------------------------
// Layer 1: offline checks (spawnImpl injection, never runs a real `npm run`)
// ---------------------------------------------------------------------------

test("multiRoomOfflineChecks returns exactly 6 well-formed checks", () => {
  const checks = multiRoomOfflineChecks();
  assert.equal(checks.length, 6);
  for (const check of checks) {
    assert.equal(typeof check.id, "string");
    assert.ok(check.id.length > 0);
    assert.equal(typeof check.label, "string");
    assert.ok(check.label.length > 0);
    assert.ok(Array.isArray(check.gates));
    assert.ok(check.gates.length > 0);
    assert.equal(typeof check.symptomOnFailure, "string");
    assert.ok(check.symptomOnFailure.length > 0);
  }
});

test("runMultiRoomOfflineChecks: all gates pass -> report ok, every result ok, no failedGate/symptomOnFailure anywhere", () => {
  const report = runMultiRoomOfflineChecks({ spawnImpl: () => ({ status: 0 }), env: {} });

  assert.equal(report.ok, true);
  assert.equal(report.results.length, 6);
  for (const result of report.results) {
    assert.equal(result.ok, true);
    assert.equal(result.failedGate, undefined);
    assert.equal(result.symptomOnFailure, undefined);
  }
  // liveOnly is always attached regardless of pass/fail
  assert.equal(report.liveOnly.length, 1);
  assert.equal(report.liveOnly[0].id, "outbox-room-fairness");
});

test("runMultiRoomOfflineChecks: one failing gate only breaks the check(s) whose gates list includes it", () => {
  const failingGate = "verify:room-isolation";
  const report = runMultiRoomOfflineChecks({
    spawnImpl: (command) => ({ status: command === `npm run ${failingGate}` ? 1 : 0 }),
    env: {}
  });

  const checks = multiRoomOfflineChecks();
  const expectedBrokenIds = new Set(checks.filter((check) => check.gates.includes(failingGate)).map((check) => check.id));
  // sanity: the failing gate must actually be used by at least one check, and not by all of them,
  // otherwise this test wouldn't prove isolation at all.
  assert.ok(expectedBrokenIds.size > 0);
  assert.ok(expectedBrokenIds.size < checks.length);

  assert.equal(report.ok, false);
  for (const result of report.results) {
    if (expectedBrokenIds.has(result.id)) {
      assert.equal(result.ok, false, `expected ${result.id} to fail`);
      assert.equal(result.failedGate, failingGate);
      assert.equal(typeof result.symptomOnFailure, "string");
      assert.ok(result.symptomOnFailure.length > 0);
    } else {
      assert.equal(result.ok, true, `expected ${result.id} to stay ok (unrelated to the failing gate)`);
      assert.equal(result.failedGate, undefined);
      assert.equal(result.symptomOnFailure, undefined);
    }
  }
});

test("runMultiRoomOfflineChecks: a multi-gate check (outbox-room-id-populated) fails fast and never calls its second gate; but does call it when the first gate passes", () => {
  const checks = multiRoomOfflineChecks();
  const multiGateCheck = checks.find((check) => check.gates.length > 1);
  assert.ok(multiGateCheck, "expected exactly one check with more than one gate");
  assert.equal(multiGateCheck.id, "outbox-room-id-populated");
  assert.deepEqual(multiGateCheck.gates, ["verify:gateway-report-rendering", "verify:room-isolation"]);
  const [firstGate, secondGate] = multiGateCheck.gates;

  // Negative case: first gate of the multi-gate check fails -> its second gate must never run.
  // Note: `secondGate` ("verify:room-isolation") is ALSO the sole gate of the unrelated
  // "room-isolation-queries" check, which always runs and always passes here, so we can't
  // assert a raw zero count for that command string across the whole run. Instead we assert
  // the exact count: it may only be invoked once (by that unrelated check), never twice
  // (which would mean the multi-gate check's fail-fast broke and called its second gate too).
  const negativeCalls = [];
  const negativeReport = runMultiRoomOfflineChecks({
    spawnImpl: (command) => {
      negativeCalls.push(command);
      return { status: command === `npm run ${firstGate}` ? 1 : 0 };
    },
    env: {}
  });
  assert.equal(negativeCalls.filter((c) => c === `npm run ${firstGate}`).length, 1);
  assert.equal(
    negativeCalls.filter((c) => c === `npm run ${secondGate}`).length,
    1,
    "second gate of the multi-gate check must NOT have been called; only the unrelated single-gate check's own call should exist"
  );
  const multiGateResult = negativeReport.results.find((r) => r.id === multiGateCheck.id);
  assert.equal(multiGateResult.ok, false);
  assert.equal(multiGateResult.failedGate, firstGate);

  // Positive companion: when the first gate passes, the second gate of the SAME check
  // is reached and invoked, proving the negative result above wasn't just vacuously true
  // because the code never calls that gate at all.
  const positiveCalls = [];
  const positiveReport = runMultiRoomOfflineChecks({
    spawnImpl: (command) => {
      positiveCalls.push(command);
      return { status: 0 };
    },
    env: {}
  });
  assert.equal(
    positiveCalls.filter((c) => c === `npm run ${secondGate}`).length,
    2,
    "when nothing fails, verify:room-isolation should be called twice: once for room-isolation-queries, once as the multi-gate check's second gate"
  );
  const multiGateResultPositive = positiveReport.results.find((r) => r.id === multiGateCheck.id);
  assert.equal(multiGateResultPositive.ok, true);
});

test("runMultiRoomOfflineChecks prebuilds once before any gate, mirroring verify-operation-ready.mjs's HUAI_PREBUILT convention", () => {
  // 실제로 이 스크립트를 단독 실행해보니(node scripts/verify-multiroom.mjs), 게이트 5개가
  // 각자 npm run build 를 하는 바람에 Windows dist 쓰기 경합으로 같은 게이트가 첫 호출은
  // 실패하고 재실행하면 통과하는 간헐적 적색을 실제로 봤다. 그래서 한 번만 빌드하고
  // 이후 게이트에는 HUAI_PREBUILT=1 을 넘긴다 — 이 테스트는 그 순서와 전파를 고정한다.
  const calls = [];
  const report = runMultiRoomOfflineChecks({
    spawnImpl: (command, options) => {
      calls.push({ command, hasPrebuiltEnv: options.env.HUAI_PREBUILT === "1" });
      return { status: 0 };
    },
    env: {}
  });

  assert.equal(report.ok, true);
  assert.equal(calls[0].command, "npm run build:force");
  // prebuild 호출 자체에는 아직 HUAI_PREBUILT 가 없어야 한다(이게 바로 그 빌드 호출이므로).
  assert.equal(calls[0].hasPrebuiltEnv, false);
  // prebuild 이후의 모든 게이트 호출은 HUAI_PREBUILT=1 을 받아야 재빌드를 건너뛴다.
  for (const call of calls.slice(1)) {
    assert.equal(call.hasPrebuiltEnv, true, `expected ${call.command} to receive HUAI_PREBUILT=1`);
  }
  assert.ok(calls.length > 1, "expected at least one gate call after the prebuild call");
});

test("runMultiRoomOfflineChecks skips the prebuild call entirely when HUAI_PREBUILT is already 1", () => {
  const calls = [];
  runMultiRoomOfflineChecks({
    spawnImpl: (command) => {
      calls.push(command);
      return { status: 0 };
    },
    env: { HUAI_PREBUILT: "1" }
  });

  assert.equal(calls.includes("npm run build:force"), false);
});

test("runMultiRoomOfflineChecks aborts with prebuildFailed when the one-time build fails, without attempting any gate", () => {
  const calls = [];
  const report = runMultiRoomOfflineChecks({
    spawnImpl: (command) => {
      calls.push(command);
      return { status: command === "npm run build:force" ? 1 : 0 };
    },
    env: {}
  });

  assert.equal(report.ok, false);
  assert.equal(report.prebuildFailed, true);
  assert.equal(report.results.length, 0);
  assert.equal(calls.length, 1, "no gate should be attempted after the prebuild fails");
  assert.equal(report.liveOnly.length, 1);
});

test("formatMultiRoomOfflineReport handles the prebuildFailed case without throwing", () => {
  const output = formatMultiRoomOfflineReport({ ok: false, prebuildFailed: true, results: [], liveOnly: liveOnlyItems() });
  assert.equal(typeof output, "string");
  assert.match(output, /FAIL/);
});

test("formatMultiRoomOfflineReport prints symptomOnFailure text for failing items and no symptom lines when everything passes", () => {
  const passingReport = runMultiRoomOfflineChecks({ spawnImpl: () => ({ status: 0 }), env: {} });
  const passingOutput = formatMultiRoomOfflineReport(passingReport);
  assert.equal(passingOutput.includes("symptom if this stays broken:"), false);

  const failingGate = "verify:room-isolation";
  const failingReport = runMultiRoomOfflineChecks({
    spawnImpl: (command) => ({ status: command === `npm run ${failingGate}` ? 1 : 0 }),
    env: {}
  });
  const failingOutput = formatMultiRoomOfflineReport(failingReport);
  const failedResult = failingReport.results.find((result) => result.ok === false);
  assert.ok(failedResult);
  assert.ok(failingOutput.includes(failedResult.symptomOnFailure));
  assert.ok(failingOutput.includes("symptom if this stays broken:"));
});

test("liveOnlyItems returns exactly 1 item describing outbox room fairness", () => {
  const items = liveOnlyItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "outbox-room-fairness");
  assert.equal(typeof items[0].reason, "string");
  assert.ok(items[0].reason.length > 0);
  assert.equal(typeof items[0].verifiedBy, "string");
  assert.ok(items[0].verifiedBy.length > 0);
});

test("exported live-mode constants: room counts match the KPI scenario, anomaly threshold does not claim to be the KPI budget", () => {
  // 방 개수(20/3)는 KPI 시나리오와 의도적으로 맞췄다 — 그건 유지한다.
  assert.equal(DEFAULT_SEQUENTIAL_ROOM_TARGET, 20);
  assert.equal(DEFAULT_CONCURRENT_ROOM_TARGET, 3);
  // 시간 임계값은 KPI 예산(3분)이 아니다 — "DB 읽기가 비정상적으로 느린지"만 보는
  // 훨씬 작은 이상 탐지 임계값이어야 한다. KPI 예산 그대로 베끼면(3분) 사실상 항상
  // 통과해서 거짓 안심이 된다는 게 이번 조건부 통과의 핵심 지적이었다.
  assert.equal(CONCURRENT_READ_ANOMALY_THRESHOLD_MS, 10 * 1000);
  assert.ok(CONCURRENT_READ_ANOMALY_THRESHOLD_MS < 60 * 1000, "anomaly threshold must not resemble a multi-minute KPI budget");
});

test("KPI_DISCLAIMER explicitly states this tool does not measure user-perceived KPI response time", () => {
  assert.equal(typeof KPI_DISCLAIMER, "string");
  assert.match(KPI_DISCLAIMER, /KPI/);
  assert.match(KPI_DISCLAIMER, /측정하지 않는다/);
});

// ---------------------------------------------------------------------------
// Layer 2: live measurement (fake fetch only — never a real network call)
// ---------------------------------------------------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function sampleLiveEnv(overrides = {}) {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    ...overrides
  };
}

// In-memory fake for the two REST endpoints runLiveMultiRoomMeasurement talks to:
// GET .../huai_rooms (returns `rooms` verbatim) and GET .../huai_gateway_instances
// (filtered by the room_id=eq.<id> query param, parsed via URL/URLSearchParams —
// never by substring matching, per this repo's testing convention).
function createFakeLiveSupabase({ rooms = [], gatewayRowsByRoomId = {} } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET");
    calls.push({ url, method });

    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/huai_rooms")) {
      return jsonResponse(200, rooms);
    }
    if (parsed.pathname.endsWith("/huai_gateway_instances")) {
      const rawRoomIdFilter = parsed.searchParams.get("room_id") ?? "";
      const roomId = rawRoomIdFilter.startsWith("eq.") ? rawRoomIdFilter.slice(3) : rawRoomIdFilter;
      const rows = gatewayRowsByRoomId[roomId] ?? [];
      return jsonResponse(200, rows);
    }
    return jsonResponse(404, { message: `unknown-endpoint:${parsed.pathname}` });
  };
  return { fetchImpl, calls };
}

function gatewayCalls(calls) {
  return calls.filter((call) => new URL(call.url).pathname.endsWith("/huai_gateway_instances"));
}

test("runLiveMultiRoomMeasurement: zero active rooms -> ok:false, reason:no-active-rooms", async () => {
  const { fetchImpl } = createFakeLiveSupabase({ rooms: [] });
  const report = await runLiveMultiRoomMeasurement(sampleLiveEnv(), {}, fetchImpl);

  assert.equal(report.ok, false);
  assert.equal(report.reason, "no-active-rooms");
});

test("runLiveMultiRoomMeasurement: dryRun true returns a probe plan and sends zero huai_gateway_instances requests", async () => {
  const rooms = [
    { room_id: "room-1", telegram_chat_id: "-1001" },
    { room_id: "room-2", telegram_chat_id: "-1002" },
    { room_id: "room-3", telegram_chat_id: "-1003" }
  ];
  const { fetchImpl, calls } = createFakeLiveSupabase({ rooms });

  const report = await runLiveMultiRoomMeasurement(sampleLiveEnv(), { dryRun: true }, fetchImpl);

  assert.notEqual(report, undefined);
  assert.equal(report.dryRun, true);
  assert.ok(Array.isArray(report.plan.sequential));
  assert.ok(report.plan.sequential.length > 0);
  assert.deepEqual(report.plan.sequential, ["room-1", "room-2", "room-3"]);

  // The initial huai_rooms read IS expected (that's how it discovers what rooms exist)...
  const roomsReads = calls.filter((call) => new URL(call.url).pathname.endsWith("/huai_rooms"));
  assert.equal(roomsReads.length, 1);
  // ...but dry-run must not probe any room's gateway status.
  assert.equal(gatewayCalls(calls).length, 0);
});

test("runLiveMultiRoomMeasurement: normal run probes sequentialCount + concurrentCount rooms and reports numeric latency/timing", async () => {
  const rooms = [
    { room_id: "room-1", telegram_chat_id: "-1001" },
    { room_id: "room-2", telegram_chat_id: "-1002" },
    { room_id: "room-3", telegram_chat_id: "-1003" },
    { room_id: "room-4", telegram_chat_id: "-1004" },
    { room_id: "room-5", telegram_chat_id: "-1005" }
  ];
  const gatewayRowsByRoomId = {
    "room-1": [{ gateway_id: "gw-1", status: "online" }],
    "room-2": [{ gateway_id: "gw-2", status: "online" }]
  };
  const { fetchImpl, calls } = createFakeLiveSupabase({ rooms, gatewayRowsByRoomId });

  const report = await runLiveMultiRoomMeasurement(
    sampleLiveEnv(),
    { sequentialCount: 2, concurrentCount: 2 },
    fetchImpl
  );

  assert.equal(gatewayCalls(calls).length, 4);

  assert.equal(report.sequential.results.length, 2);
  assert.equal(report.concurrent.results.length, 2);
  for (const result of [...report.sequential.results, ...report.concurrent.results]) {
    assert.equal(typeof result.latencyMs, "number");
    assert.ok(result.latencyMs >= 0);
    assert.equal(typeof result.ok, "boolean");
  }
  assert.equal(typeof report.concurrent.totalMs, "number");
  assert.equal(report.ok, true);
});

test("runLiveMultiRoomMeasurement: a room with no huai_gateway_instances row is ok:false with a detail string, while sibling rooms stay ok:true", async () => {
  const rooms = [
    { room_id: "room-1", telegram_chat_id: "-1001" },
    { room_id: "room-2", telegram_chat_id: "-1002" }
  ];
  const gatewayRowsByRoomId = {
    "room-1": [], // empty result set -> "no huai_gateway_instances row for this room"
    "room-2": [{ gateway_id: "gw-2", status: "online" }]
  };
  const { fetchImpl } = createFakeLiveSupabase({ rooms, gatewayRowsByRoomId });

  const report = await runLiveMultiRoomMeasurement(
    sampleLiveEnv(),
    { sequentialCount: 2, concurrentCount: 2 },
    fetchImpl
  );

  assert.equal(report.ok, false);

  for (const bucket of [report.sequential.results, report.concurrent.results]) {
    const room1Result = bucket.find((r) => r.roomId === "room-1");
    const room2Result = bucket.find((r) => r.roomId === "room-2");
    assert.equal(room1Result.ok, false);
    assert.equal(typeof room1Result.detail, "string");
    assert.ok(room1Result.detail.length > 0);
    assert.equal(room2Result.ok, true);
  }
});

test("runLiveMultiRoomMeasurement marks measuresKpi:false and carries the KPI disclaimer in all three branches (no-active-rooms, dry-run, completed)", async () => {
  // 팀장 지시: 층 2가 재는 DB 읽기 지연은 MBO KPI(사용자 체감 응답시간)가 아니다.
  // 기계 판독 쪽(--json)에서도 오독이 안 되게, 모든 반환 경로에 measuresKpi:false 와
  // kpiDisclaimer 문자열이 항상 실려야 한다 — 하나라도 빠지면 그 경로의 출력만 보고
  // "KPI 통과"로 착각할 수 있다.
  const { fetchImpl: noRoomsFetch } = createFakeLiveSupabase({ rooms: [] });
  const noRoomsReport = await runLiveMultiRoomMeasurement(sampleLiveEnv(), {}, noRoomsFetch);
  assert.equal(noRoomsReport.measuresKpi, false);
  assert.equal(noRoomsReport.kpiDisclaimer, KPI_DISCLAIMER);

  const rooms = [{ room_id: "room-1", telegram_chat_id: "-1001" }];
  const { fetchImpl: dryRunFetch } = createFakeLiveSupabase({ rooms });
  const dryRunReport = await runLiveMultiRoomMeasurement(sampleLiveEnv(), { dryRun: true }, dryRunFetch);
  assert.equal(dryRunReport.measuresKpi, false);
  assert.equal(dryRunReport.kpiDisclaimer, KPI_DISCLAIMER);

  const gatewayRowsByRoomId = { "room-1": [{ gateway_id: "gw-1", status: "online" }] };
  const { fetchImpl: liveFetch } = createFakeLiveSupabase({ rooms, gatewayRowsByRoomId });
  const liveReport = await runLiveMultiRoomMeasurement(sampleLiveEnv(), { sequentialCount: 1, concurrentCount: 1 }, liveFetch);
  assert.equal(liveReport.measuresKpi, false);
  assert.equal(liveReport.kpiDisclaimer, KPI_DISCLAIMER);
});

test("runLiveMultiRoomMeasurement's concurrent result never uses KPI-budget field names (budgetMs/withinBudget)", async () => {
  const rooms = [{ room_id: "room-1", telegram_chat_id: "-1001" }];
  const gatewayRowsByRoomId = { "room-1": [{ gateway_id: "gw-1", status: "online" }] };
  const { fetchImpl } = createFakeLiveSupabase({ rooms, gatewayRowsByRoomId });
  const report = await runLiveMultiRoomMeasurement(sampleLiveEnv(), { sequentialCount: 1, concurrentCount: 1 }, fetchImpl);

  // 예전 필드명(budgetMs/withinBudget)이 KPI 예산인 것처럼 오독됐다 — 지금은
  // anomalyThresholdMs/withinAnomalyThreshold 로만 존재해야 한다.
  assert.equal("budgetMs" in report.concurrent, false);
  assert.equal("withinBudget" in report.concurrent, false);
  assert.equal(typeof report.concurrent.anomalyThresholdMs, "number");
  assert.equal(typeof report.concurrent.withinAnomalyThreshold, "boolean");
  assert.equal(report.concurrent.anomalyThresholdMs, CONCURRENT_READ_ANOMALY_THRESHOLD_MS);
});

test("formatLiveMultiRoomReport prints the KPI disclaimer in every branch and never claims to measure the KPI itself", async () => {
  const { fetchImpl: noRoomsFetch } = createFakeLiveSupabase({ rooms: [] });
  const noRoomsOutput = formatLiveMultiRoomReport(await runLiveMultiRoomMeasurement(sampleLiveEnv(), {}, noRoomsFetch));
  assert.match(noRoomsOutput, /KPI/);
  assert.match(noRoomsOutput, /측정하지 않는다/);

  const rooms = [{ room_id: "room-1", telegram_chat_id: "-1001" }];
  const { fetchImpl: dryRunFetch } = createFakeLiveSupabase({ rooms });
  const dryRunOutput = formatLiveMultiRoomReport(await runLiveMultiRoomMeasurement(sampleLiveEnv(), { dryRun: true }, dryRunFetch));
  assert.match(dryRunOutput, /KPI/);
  assert.match(dryRunOutput, /측정하지 않는다/);

  const gatewayRowsByRoomId = { "room-1": [{ gateway_id: "gw-1", status: "online" }] };
  const { fetchImpl: liveFetch } = createFakeLiveSupabase({ rooms, gatewayRowsByRoomId });
  const liveOutput = formatLiveMultiRoomReport(
    await runLiveMultiRoomMeasurement(sampleLiveEnv(), { sequentialCount: 1, concurrentCount: 1 }, liveFetch)
  );
  assert.match(liveOutput, /KPI/);
  assert.match(liveOutput, /측정하지 않는다/);
  // 예전 문구("budget_ms=", "within_budget=")가 KPI 예산인 것처럼 읽혔다 — 없어야 한다.
  assert.equal(liveOutput.includes("budget_ms="), false);
  assert.equal(liveOutput.includes("within_budget="), false);
  assert.match(liveOutput, /anomaly_threshold_ms=/);
});

test("formatLiveMultiRoomReport renders readable, distinct output for no-active-rooms, dry-run, and a completed measurement", async () => {
  // no-active-rooms
  const { fetchImpl: noRoomsFetch } = createFakeLiveSupabase({ rooms: [] });
  const noRoomsReport = await runLiveMultiRoomMeasurement(sampleLiveEnv(), {}, noRoomsFetch);
  const noRoomsOutput = formatLiveMultiRoomReport(noRoomsReport);
  assert.equal(typeof noRoomsOutput, "string");
  assert.ok(noRoomsOutput.includes("BLOCKED"));
  assert.ok(noRoomsOutput.includes("no-active-rooms"));

  // dry-run
  const rooms = [{ room_id: "room-1", telegram_chat_id: "-1001" }, { room_id: "room-2", telegram_chat_id: "-1002" }];
  const { fetchImpl: dryRunFetch } = createFakeLiveSupabase({ rooms });
  const dryRunReport = await runLiveMultiRoomMeasurement(sampleLiveEnv(), { dryRun: true }, dryRunFetch);
  const dryRunOutput = formatLiveMultiRoomReport(dryRunReport);
  assert.equal(typeof dryRunOutput, "string");
  assert.ok(dryRunOutput.includes("DRY-RUN"));
  assert.ok(dryRunOutput.includes("room-1"));
  assert.ok(dryRunOutput.includes("room-2"));

  // completed measurement
  const gatewayRowsByRoomId = {
    "room-1": [{ gateway_id: "gw-1", status: "online" }],
    "room-2": [{ gateway_id: "gw-2", status: "online" }]
  };
  const { fetchImpl: liveFetch } = createFakeLiveSupabase({ rooms, gatewayRowsByRoomId });
  const liveReport = await runLiveMultiRoomMeasurement(
    sampleLiveEnv(),
    { sequentialCount: 2, concurrentCount: 2 },
    liveFetch
  );
  const liveOutput = formatLiveMultiRoomReport(liveReport);
  assert.equal(typeof liveOutput, "string");
  assert.ok(liveOutput.includes("PASS"));
  assert.ok(liveOutput.includes("room-1"));
  assert.ok(liveOutput.includes("room-2"));
});
