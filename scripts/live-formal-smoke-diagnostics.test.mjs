import assert from "node:assert/strict";
import test from "node:test";
import { buildOutboxTimeoutDiagnostic, checkLocalGatewayHealth } from "./live-formal-smoke-diagnostics.mjs";

test("timeout diagnostic preserves outbox state and links the repeated finding without declaring identity", () => {
  assert.deepEqual(buildOutboxTimeoutDiagnostic("task-1", {
    idempotency_key: "key-1",
    status: "processing",
    last_error: "lease stuck",
    created_at: "2026-08-26T00:00:00Z"
  }), {
    taskId: "task-1",
    rowFound: true,
    idempotencyKey: "key-1",
    status: "processing",
    lastError: "lease stuck",
    createdAt: "2026-08-26T00:00:00Z",
    repeatedFinding: "approval-result-not-returned",
    repeatedFindingAssessment: "same-symptom-reproduction-candidate"
  });
});

test("timeout diagnostic distinguishes a missing row", () => {
  const diagnostic = buildOutboxTimeoutDiagnostic("task-2");
  assert.equal(diagnostic.rowFound, false);
  assert.equal(diagnostic.status, null);
  assert.equal(diagnostic.lastError, null);
});

test("health check accepts a live local-gateway and returns operational fields", async () => {
  const result = await checkLocalGatewayHealth(async (url) => {
    assert.equal(url, "http://127.0.0.1:8797/healthz");
    return new Response(JSON.stringify({ ok: true, service: "local-gateway", lastTickAt: "now", consecutiveErrors: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.lastTickAt, "now");
  assert.equal(result.consecutiveErrors, 0);
});

test("health check fails when port 8797 cannot be reached", async () => {
  await assert.rejects(
    checkLocalGatewayHealth(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8797"); }),
    /local-gateway-health-unreachable:connect ECONNREFUSED/
  );
});
