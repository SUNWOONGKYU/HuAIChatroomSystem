import assert from "node:assert/strict";
import test from "node:test";
import { LocalGatewaySupabaseOutboxStore } from "../src/supabase-store.js";

test("leases local gateway outbox rows through lease_huai_outbox", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(200, [
      {
        outbox_id: "outbox-1",
        idempotency_key: "gateway:attempt-1",
        target: JSON.stringify({ kind: "local_gateway", gatewayId: "primary" }),
        payload: { executionRequest: { attemptId: "attempt-1" } },
        status: "processing",
        attempts: 1
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  const rows = await store.leasePendingLocalGateway(5, "2026-08-10T00:01:00.000Z");

  assert.match(calls.requests[0]?.url ?? "", /\/rest\/v1\/rpc\/lease_huai_outbox$/);
  assert.equal(calls.requests[0]?.body.p_target_kind, "local_gateway");
  assert.equal(rows[0]?.outboxId, "outbox-1");
  assert.equal(rows[0]?.target.kind, "local_gateway");
});

test("accepts huai_outbox_id rows returned by applied schema", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(200, [
      {
        huai_outbox_id: "00000000-0000-0000-0000-000000000001",
        idempotency_key: "gateway:attempt-1",
        target: JSON.stringify({ kind: "local_gateway", gatewayId: "primary" }),
        payload: { executionRequest: { attemptId: "attempt-1" } },
        status: "processing",
        attempts: 2
      }
    ])
  ]);
  const store = makeStore(calls.fetchImpl);

  const rows = await store.leasePendingLocalGateway(5, "2026-08-10T00:01:00.000Z");

  assert.equal(rows[0]?.outboxId, "00000000-0000-0000-0000-000000000001");
});

test("marks sent through RPC and masks retry errors by huai_outbox_id", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(200, true),
    jsonResponse(200, [{ huai_outbox_id: "outbox-1" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.markSent("outbox-1", { telegramMessageId: "attempt-1" });
  await store.markRetry("outbox-1", "Bearer top.secret bot123:SECRET", "2026-08-10T00:02:00.000Z");

  assert.match(calls.requests[0]?.url ?? "", /\/rest\/v1\/rpc\/mark_huai_outbox_sent$/);
  assert.equal(calls.requests[0]?.body.p_huai_outbox_id, "outbox-1");
  assert.match(calls.requests[1]?.url ?? "", /\/rest\/v1\/huai_outbox\?huai_outbox_id=eq\.outbox-1&status=eq\.processing$/);
  assert.equal(String(calls.requests[1]?.body.last_error).includes("top.secret"), false);
  assert.equal(String(calls.requests[1]?.body.last_error).includes("SECRET"), false);
});

function makeStore(fetchImpl: typeof fetch): LocalGatewaySupabaseOutboxStore {
  return new LocalGatewaySupabaseOutboxStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl
  });
}

function makeSupabaseFetch(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries())
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call");
    return response;
  };
  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { "content-type": "application/json" }
  });
}

test("does not send raw result fields to mark_huai_outbox_sent", async () => {
  const calls = makeSupabaseFetch([jsonResponse(200, true)]);
  const store = makeStore(calls.fetchImpl);

  await store.markSent("outbox-raw", {
    telegramMessageId: "123",
    raw: { token: "bot123456:SECRET_TOKEN" }
  });

  assert.deepEqual(calls.requests[0]?.body.p_send_result, { telegramMessageId: "123" });
});


test("throws when mark sent updates no processing row", async () => {
  const calls = makeSupabaseFetch([jsonResponse(200, false)]);
  const store = makeStore(calls.fetchImpl);

  await assert.rejects(
    () => store.markSent("outbox-stale", { telegramMessageId: "123" }),
    /outbox-state-conflict:mark-sent/
  );
});

test("throws when retry patch updates no processing row", async () => {
  const calls = makeSupabaseFetch([jsonResponse(200, [])]);
  const store = makeStore(calls.fetchImpl);

  await assert.rejects(
    () => store.markRetry("outbox-stale", "stale", "2026-08-10T00:02:00.000Z"),
    /outbox-state-conflict:patch/
  );
});

test("defers local gateway rows while blocking task dependencies are unfinished", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const predecessorId = "11111111-1111-4111-8111-111111111111";
  const calls = makeSupabaseFetch([
    jsonResponse(200, [
      {
        huai_outbox_id: "outbox-waiting",
        idempotency_key: "gateway:attempt-waiting",
        target: JSON.stringify({ kind: "local_gateway", gatewayId: "primary" }),
        payload: { executionRequest: { taskId, attemptId: "attempt-waiting" } },
        status: "processing",
        attempts: 1
      }
    ]),
    jsonResponse(200, [{ predecessor_task_id: predecessorId, dependency_type: "blocks", is_blocking: true }]),
    jsonResponse(200, [{ task_id: predecessorId, status: "in_progress" }]),
    jsonResponse(200, [{ huai_outbox_id: "outbox-waiting" }])
  ]);
  const store = makeStore(calls.fetchImpl);

  const rows = await store.leasePendingLocalGateway(5, "2026-08-10T00:01:00.000Z");

  assert.equal(rows.length, 0);
  assert.match(calls.requests[1]?.url ?? "", /huai_task_dependencies/);
  assert.match(calls.requests[2]?.url ?? "", /huai_tasks/);
  assert.match(calls.requests[3]?.url ?? "", /huai_outbox\?huai_outbox_id=eq\.outbox-waiting&status=eq\.processing/);
  assert.equal(calls.requests[3]?.body.status, "retry_pending");
  assert.equal(calls.requests[3]?.body.last_error, "waiting-dependencies");
});
// 라이브 결함 회귀 — 방마다 게이트웨이를 하나씩 띄우자 서로 남의 일을 집어갔다.
// 개발방 작업을 상증세법·DCF 게이트웨이가 먼저 집고 project-path-not-allowed 로 실패시켰다.
test("게이트웨이는 자기 앞으로 온 행만 리스한다", async () => {
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  const store = new LocalGatewaySupabaseOutboxStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "k",
    fetchImpl,
    gatewayId: "16e2c574-3acb-45c0-a86b-0efd1f492b2d"
  });

  await store.leasePendingLocalGateway(5, "2026-08-16T00:00:00.000Z");

  assert.equal(bodies[0].p_gateway_id, "16e2c574-3acb-45c0-a86b-0efd1f492b2d");
  assert.equal(bodies[0].p_target_kind, "local_gateway");
});

test("게이트웨이 지정이 없으면 예전처럼 전부 대상", async () => {
  // bot-service 의 텔레그램 발신 리스에는 게이트웨이 개념이 없다. 조건을 걸면 안 된다.
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  const store = new LocalGatewaySupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "k", fetchImpl });

  await store.leasePendingLocalGateway(5, "2026-08-16T00:00:00.000Z");

  assert.equal("p_gateway_id" in bodies[0], false);
});
