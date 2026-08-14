import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore, artifactUri, collectedArtifactsFromEvents } from "../src/index.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";

test("completed gateway result inserts huai_artifacts rows and one artifact_saved event", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-art:completed", "meaningful_intermediate_ready")]),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(200, []),
    jsonResponse(201, []),
    jsonResponse(201, [eventRow("artifact-saved:attempt-art", "artifact_saved")])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [
      artifactEvent("docs/report.md", "file:///C:/work/docs/report.md", "sha-1"),
      artifactEvent("src/changed.ts", "file:///C:/work/src/changed.ts", "sha-2")
    ],
    occurredAt: "2026-08-14T00:00:00.000Z"
  });

  const inserts = calls.requests.filter((request) => request.method === "POST" && /huai_artifacts$/.test(request.url));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].body.task_id, TASK_ID);
  assert.equal(inserts[0].body.uri, "file:///C:/work/docs/report.md");
  assert.equal(inserts[0].body.version, "attempt-art");
  assert.equal(inserts[0].body.checksum, "sha-1");
  assert.equal(inserts[0].body.author_actor_id, ACTOR_ID);
  assert.equal(inserts[0].body.is_final, false);

  const savedEvent = calls.requests.find((request) => request.body?.idempotency_key === "artifact-saved:attempt-art");
  assert.equal(savedEvent?.body.event_type, "artifact_saved");
  assert.equal(savedEvent?.body.task_id, TASK_ID);
  assert.equal(savedEvent?.body.payload.artifactCount, 2);
});

test("already stored artifact is not inserted again and emits no artifact_saved event", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-art:completed", "meaningful_intermediate_ready")]),
    jsonResponse(201, []),
    jsonResponse(200, [{ artifact_id: "existing-artifact" }])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [artifactEvent("docs/report.md", "file:///C:/work/docs/report.md", "sha-1")],
    occurredAt: "2026-08-14T00:00:00.000Z"
  });

  assert.equal(calls.requests.filter((request) => request.method === "POST" && /huai_artifacts$/.test(request.url)).length, 0);
  assert.equal(calls.requests.some((request) => request.body?.idempotency_key === "artifact-saved:attempt-art"), false);
});

test("non-uuid task ids skip artifact persistence", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-art:completed", "meaningful_intermediate_ready")]),
    jsonResponse(201, [])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: { ...makeRequest(), taskId: "proposal-1" },
    status: "completed",
    events: [artifactEvent("docs/report.md", "file:///C:/work/docs/report.md", "sha-1")],
    occurredAt: "2026-08-14T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => /huai_artifacts/.test(request.url)), false);
});

test("failed executions never persist artifacts", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:attempt-art:failed", "execution_delayed_or_failed")]),
    jsonResponse(201, [])
  ]);
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl: calls.fetchImpl });

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "failed",
    errorKind: "exit-code-1",
    events: [artifactEvent("docs/report.md", "file:///C:/work/docs/report.md", "sha-1")],
    occurredAt: "2026-08-14T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => /huai_artifacts/.test(request.url)), false);
});

test("duplicate artifact_collected events for the same uri and version collapse to one row", () => {
  const collected = collectedArtifactsFromEvents([
    artifactEvent("docs/report.md", "file:///C:/work/docs/report.md", "sha-1"),
    artifactEvent("docs/report.md", "file:///C:/work/docs/report.md", "sha-1")
  ]);
  assert.equal(collected.length, 1);
});

test("artifact uri falls back to project path and masks secrets", () => {
  const request = makeRequest();
  assert.equal(
    artifactUri({ path: "docs/report.md", sizeBytes: 1, checksum: "sha", version: "attempt-art" }, request),
    "C:/work/docs/report.md"
  );
  const sensitiveValue = "SHOULD-NOT-PERSIST";
  const masked = artifactUri(
    { path: "x", sizeBytes: 1, checksum: "sha", version: "attempt-art", uri: `https://host/file?token=${sensitiveValue}` },
    request
  );
  assert.equal(masked.includes(sensitiveValue), false);
  assert.match(masked, /token=<redacted>/);
});

function artifactEvent(path: string, uri: string, checksum: string): GatewayEvent {
  return {
    type: "artifact_collected",
    taskId: TASK_ID,
    attemptId: "attempt-art",
    artifact: { path, sizeBytes: 12, checksum, version: "attempt-art", uri }
  };
}

function makeRequest(): ExecutionRequest {
  return {
    roomId: "room-1",
    taskId: TASK_ID,
    attemptId: "attempt-art",
    actorId: ACTOR_ID,
    requestedBy: "2001",
    adapterType: "codex",
    projectPath: "C:/work",
    prompt: "do work",
    timeoutMs: 30_000,
    idempotencyKey: "exec-art",
    createdAt: "2026-08-14T00:00:00.000Z"
  };
}

function eventRow(idempotencyKey: string, eventType: string) {
  return {
    event_id: "event-" + idempotencyKey,
    room_id: "room-1",
    task_id: TASK_ID,
    event_type: eventType,
    idempotency_key: idempotencyKey,
    payload: {},
    created_at: "2026-08-14T00:00:00.000Z"
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeFetchSequence(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call");
    return response;
  };
  return { fetchImpl, requests };
}
