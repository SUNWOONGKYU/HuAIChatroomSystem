import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRepairButtonCallbackResult,
  repairButtonCallbackOutbox,
  rewritePayloadCallbacks
} from "./repair-button-callback-outbox.mjs";

test("removes owner-control callback keyboards and marks the operations-center redirect", () => {
  const { payload, changedCallbacks } = rewritePayloadCallbacks({
    keyboard: {
      inline_keyboard: [[
        { text: "재검증", callback_data: "task:proposal_123:reverify" },
        { text: "보완 요청", callback_data: "task:proposal_123:request_revision" },
        { text: "최종 승인", callback_data: "task:proposal_123:final_approve" },
        { text: "승인", callback_data: "proposal:proposal_123:approve" }
      ]]
    }
  });

  assert.equal(changedCallbacks, 4);
  assert.equal("keyboard" in payload, false);
  assert.equal(payload.ownerActionRedirect, true);
});

test("dry-run lists candidates without patching", async () => {
  const calls = [];
  const result = await repairButtonCallbackOutbox(env(), {}, async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return jsonResponse(200, [row("row-1"), row("row-2")]);
  });

  assert.equal(result.apply, false);
  assert.equal(result.candidates.length, 2);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  const formatted = formatRepairButtonCallbackResult(result);
  assert.match(formatted, /mode=dry-run/);
  assert.match(formatted, /--apply --id <candidate_id>/);
  assert.equal(formatted.includes("service_role_SECRET_VALUE"), false);
});

test("apply requires explicit selected id", async () => {
  await assert.rejects(
    () => repairButtonCallbackOutbox(env(), { apply: true }, async () => jsonResponse(200, [])),
    /apply-requires-explicit-id/
  );
});

test("apply patches only selected candidate", async () => {
  const calls = [];
  const result = await repairButtonCallbackOutbox(env(), { apply: true, ids: ["row-2"] }, async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (init.method === "PATCH") return jsonResponse(204, null);
    return jsonResponse(200, [row("row-1"), row("row-2")]);
  });

  assert.equal(result.candidates.length, 1);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.match(patch.url, /row-2/);
  assert.equal(patch.body.status, "retry_pending");
  assert.equal(patch.body.last_error, "manual-retry-after-short-callback-fix");
  assert.equal(JSON.stringify(patch.body.payload).includes("callback_data"), false);
  assert.equal(patch.body.payload.ownerActionRedirect, true);
});

function env() {
  return { SUPABASE_URL: "https://example.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "service_role_SECRET_VALUE" };
}

function row(id) {
  return {
    huai_outbox_id: id,
    attempts: 4,
    payload: {
      keyboard: {
        inline_keyboard: [[
          { text: "보완 요청", callback_data: `task:proposal_${id}:request_revision` },
          { text: "최종 승인", callback_data: `task:proposal_${id}:final_approve` }
        ]]
      }
    }
  };
}

function jsonResponse(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
