import assert from "node:assert/strict";
import test from "node:test";
import { inspectOutbox, formatOutboxInspection } from "./inspect-outbox.mjs";

test("summarizes outbox rows and detects stale processing without exposing service role", async () => {
  const requests = [];
  const summary = await inspectOutbox(
    { SUPABASE_URL: "https://example.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "service_role_SECRET_VALUE" },
    async (url, init) => {
      requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return jsonResponse(200, [
        { huai_outbox_id: "row-pending", target_kind: "telegram_bot", status: "pending", attempts: 0, locked_until: null, last_error: null },
        { huai_outbox_id: "row-stale", target_kind: "local_gateway", status: "processing", attempts: 2, locked_until: "2026-08-10T00:00:00.000Z", last_error: "masked" },
        { huai_outbox_id: "row-button", target_kind: "telegram_bot", status: "dead", attempts: 4, locked_until: null, last_error: "telegram-api-error:400:Bad Request: BUTTON_DATA_INVALID" },
        { huai_outbox_id: "row-sent", target_kind: "telegram_bot", status: "sent", attempts: 1, locked_until: null, last_error: null }
      ]);
    }
  );

  assert.equal(summary.counts.pending, 1);
  assert.equal(summary.counts.processing, 1);
  assert.equal(summary.counts.sent, 1);
  assert.equal(summary.counts.dead, 1);
  assert.equal(summary.staleProcessing >= 1, true);
  assert.equal(summary.problemRows.some((row) => row.kind === "telegram_button_data_invalid"), true);
  assert.equal(summary.problemRows.some((row) => row.action === "unlock-and-requeue-selected-if-no-process-running"), true);
  const formatted = formatOutboxInspection(summary);
  assert.equal(formatted.includes("service_role_SECRET_VALUE"), false);
  assert.equal(formatted.includes("telegram_button_data_invalid"), true);
  assert.equal(requests[0].headers.apikey, "service_role_SECRET_VALUE");
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}