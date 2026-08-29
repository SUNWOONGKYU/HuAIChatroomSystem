import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore } from "../src/index.js";

const TASK_ID = "002be156-a197-4d8c-8558-7fbb4603282f";
const GATEWAY_ID = "4b529428-f44e-4235-a0ba-d6e1525beef6";

test("leasing a runnable approved execution queues a scheduled task before gateway work", async () => {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    requests.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/rpc/lease_huai_outbox")) {
      return new Response(JSON.stringify([{
        huai_outbox_id: "outbox-1",
        idempotency_key: "gateway:execution:task-1",
        target: JSON.stringify({ kind: "local_gateway", gatewayId: GATEWAY_ID }),
        payload: { executionRequest: { taskId: TASK_ID, attemptId: "attempt-1", adapterType: "codex" } },
        status: "processing",
        attempts: 1
      }]), { status: 200 });
    }
    if (url.includes("/huai_task_dependencies")) return new Response("[]", { status: 200 });
    if (url.includes("/huai_tasks") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify([{ status: "scheduled" }]), { status: 200 });
    }
    if (url.includes("/huai_tasks") && init?.method === "PATCH") return new Response("[{}]", { status: 200 });
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const store = new SupabaseOutboxStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-key",
    gatewayId: GATEWAY_ID,
    fetchImpl
  });
  const leased = await store.leasePendingLocalGateway(1, "2026-08-28T00:05:00.000Z");

  assert.equal(leased.length, 1);
  const patch = requests.find((request) => request.method === "PATCH");
  assert.equal(patch?.body && (patch.body as { status?: string }).status, "queued_for_gateway");
  assert.equal(requests.some((request) => request.url.includes("/huai_task_dependencies")), true);
});
