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

function fakeFetch({ healthOk, updates, outbox, approvals = [], tasks = [] }) {
  return async (url) => {
    const href = String(url);
    if (href.includes("127.0.0.1")) {
      return jsonResponse(healthOk ? 200 : 503, healthOk ? { ok: true, service: "test" } : { ok: false, service: "test" });
    }
    if (href.includes("huai_telegram_updates")) return jsonResponse(200, updates);
    if (href.includes("huai_outbox")) return jsonResponse(200, outbox);
    if (href.includes("huai_approvals")) return jsonResponse(200, approvals);
    if (href.includes("huai_tasks")) return jsonResponse(200, tasks);
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


test("승인은 났는데 task 가 없으면 고아 승인으로 탐지한다", async () => {
  const report = await buildOperationStatusReport(env(), { now: "2026-08-15T00:00:00.000Z" }, fakeFetch({
    healthOk: true,
    updates: [{ status: "processed", received_at: "2026-08-15T00:00:00.000Z", last_error: null }],
    outbox: [{ huai_outbox_id: "row-1", target_kind: "telegram_bot", status: "sent", attempts: 1, locked_until: null, last_error: null }],
    approvals: [
      { approval_id: "a1", stage: "task_approval", decision: "approved", entity_ref: "proposal_0001", task_id: null, created_at: "2026-08-15T00:00:00.000Z" },
      { approval_id: "a2", stage: "task_approval", decision: "approved", entity_ref: "proposal_0002", task_id: null, created_at: "2026-08-15T00:00:00.000Z" }
    ],
    tasks: [{ idempotency_key: "task:approved-proposal:proposal_0002" }]
  }));

  assert.equal(report.approvals.taskApproved, 2);
  assert.equal(report.approvals.orphaned, 1);
  assert.equal(report.status, "attention");
  const text = formatOperationStatusReport(report);
  assert.match(text, /approval_orphan entity_ref=proposal_0001/);
  assert.equal(text.includes("proposal_0002"), false);
});

test("거부·취소 승인은 task 가 없어도 고아로 세지 않는다", async () => {
  const report = await buildOperationStatusReport(env(), { now: "2026-08-15T00:00:00.000Z" }, fakeFetch({
    healthOk: true,
    updates: [{ status: "processed", received_at: "2026-08-15T00:00:00.000Z", last_error: null }],
    outbox: [{ huai_outbox_id: "row-1", target_kind: "telegram_bot", status: "sent", attempts: 1, locked_until: null, last_error: null }],
    approvals: [
      { approval_id: "a1", stage: "task_approval", decision: "rejected", entity_ref: "proposal_0003", task_id: null, created_at: "2026-08-15T00:00:00.000Z" },
      { approval_id: "a2", stage: "cancellation", decision: "cancelled", entity_ref: "proposal_0004", task_id: null, created_at: "2026-08-15T00:00:00.000Z" }
    ]
  }));

  assert.equal(report.approvals.orphaned, 0);
  assert.equal(report.status, "ok");
});

test("승인 원장 조회 실패는 은폐되지 않고 상태에 드러난다", async () => {
  const report = await buildOperationStatusReport(env(), { now: "2026-08-15T00:00:00.000Z" }, async (url) => {
    const href = String(url);
    if (href.includes("127.0.0.1")) return jsonResponse(200, { ok: true, service: "test" });
    if (href.includes("huai_telegram_updates")) return jsonResponse(200, []);
    if (href.includes("huai_outbox")) return jsonResponse(200, []);
    if (href.includes("huai_approvals")) return jsonResponse(500, { message: "relation missing" });
    throw new Error("unexpected-url:" + href);
  });

  assert.equal(typeof report.approvals.error, "string");
  assert.equal(report.status, "attention");
  assert.match(formatOperationStatusReport(report), /approvals .*error=/);
});
