import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationStatusReport, exitStatusForReport, formatOperationStatusReport } from "./operation-status-report.mjs";

test("formats ok operation status without exposing service role", async () => {
  const report = await buildOperationStatusReport(env(), { now: "2026-08-12T00:00:00.000Z" }, fakeFetch({
    healthOk: true,
    updates: [{ status: "processed", received_at: "2026-08-12T00:00:00.000Z", last_error: null }],
    outbox: [{ huai_outbox_id: "row-1", target_kind: "telegram_bot", status: "sent", attempts: 1, locked_until: null, last_error: null }]
  }));

  assert.equal(report.status, "ok");
  const text = formatOperationStatusReport(report);
  assert.match(text, /operation_status status=ok/);
  assert.equal(text.includes("service_role_SECRET_VALUE"), false);
});

test("marks attention when outbox has repairable dead rows", async () => {
  const report = await buildOperationStatusReport(env(), { now: "2026-08-12T00:00:00.000Z" }, fakeFetch({
    healthOk: true,
    updates: [{ status: "processed", received_at: "2026-08-12T00:00:00.000Z", last_error: null }],
    outbox: [{
      huai_outbox_id: "row-button",
      target_kind: "telegram_bot",
      status: "dead",
      attempts: 4,
      locked_until: null,
      last_error: "telegram-api-error:400:Bad Request: BUTTON_DATA_INVALID"
    }]
  }));

  assert.equal(report.status, "attention");
  const text = formatOperationStatusReport(report);
  assert.match(text, /outbox_problem/);
  assert.match(text, /telegram_button_data_invalid/);
});

test("marks down when a service health endpoint is unavailable", async () => {
  const report = await buildOperationStatusReport(env(), { now: "2026-08-12T00:00:00.000Z" }, fakeFetch({
    healthOk: false,
    updates: [],
    outbox: []
  }));

  assert.equal(report.status, "down");
  assert.match(formatOperationStatusReport(report), /bot_service=down/);
});

function env() {
  return { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service_role_SECRET_VALUE" };
}

function fakeFetch({ healthOk, updates, outbox }) {
  return async (url) => {
    const href = String(url);
    if (href.includes("127.0.0.1")) {
      return jsonResponse(healthOk ? 200 : 503, healthOk ? { ok: true, service: "test" } : { ok: false, service: "test" });
    }
    if (href.includes("huai_telegram_updates")) return jsonResponse(200, updates);
    if (href.includes("huai_outbox")) return jsonResponse(200, outbox);
    throw new Error("unexpected-url:" + href);
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("maps report status to cli exit code without forcing process exit", () => {
  assert.equal(exitStatusForReport({ status: "ok" }), 0);
  assert.equal(exitStatusForReport({ status: "attention" }), 1);
  assert.equal(exitStatusForReport({ status: "down" }), 2);
});
