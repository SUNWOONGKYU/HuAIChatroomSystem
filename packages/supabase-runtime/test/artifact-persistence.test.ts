import assert from "node:assert/strict";
import test from "node:test";
import { isDeliverableDocument, localArtifactPath, SupabaseOutboxStore, artifactUri, collectedArtifactsFromEvents } from "../src/index.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";

const TASK_ID = "44444444-4444-4444-8444-444444444444";
const ACTOR_ID = "55555555-5555-4555-8555-555555555555";

test("completed gateway result inserts huai_artifacts rows and one artifact_saved event", async () => {
  const calls = makeFetchSequence();
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
  const calls = makeFetchSequence(undefined, { existingArtifact: true });
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
  const calls = makeFetchSequence();
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
  const calls = makeFetchSequence();
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

// 순서 고정 큐는 구현에 호출이 하나 늘 때마다 깨진다. URL 로 응답을 정한다.
function makeFetchSequence(_responses?: Response[], options: { existingArtifact?: boolean } = {}) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.split("/rest/v1")[1] ?? url;
    if (path.includes("huai_rooms")) return jsonResponse(200, [{ telegram_chat_id: "1001" }]);
    if (path.includes("huai_tasks") && method === "GET") return jsonResponse(200, [{ status: "in_progress" }]);
    if (path.includes("huai_artifacts") && method === "GET") {
      return jsonResponse(200, options.existingArtifact ? [{ artifact_id: "existing" }] : []);
    }
    if (path.includes("huai_events") && method === "POST") {
      const key = JSON.parse(String(init?.body)).idempotency_key;
      return jsonResponse(201, [eventRow(key, "x")]);
    }
    return jsonResponse(200, []);
  };
  return { fetchImpl, requests };
}

// 방장 제기 — "만들어 줬으면 연결을 시켜줘야 되는데". 웹 산출물은 배포해서 링크로 열 수
// 있게 됐지만(Phase 2), 문서는 브라우저에서 안 열리므로 파일 자체를 방에 올려야 한다.
test("문서 산출물만 방에 파일로 올린다", () => {
  assert.equal(isDeliverableDocument("사건보고서.hwpx"), true);
  assert.equal(isDeliverableDocument("C:\work\평가표.xlsx"), true);
  assert.equal(isDeliverableDocument("결과.pdf"), true);
  // 웹 산출물은 배포해서 링크로 연다 — 파일로 또 보내면 같은 것이 두 번 온다.
  assert.equal(isDeliverableDocument("egg-crack-sound-game.html"), false);
  // 소스는 결과물이 아니라 작업 그 자체다. 방에 뿌리면 잡음이 된다.
  assert.equal(isDeliverableDocument("packages/orchestrator/src/index.ts"), false);
  assert.equal(isDeliverableDocument("README.md"), false);
});

test("file:// 로 기록된 산출물에서 이 PC 경로를 되돌린다", () => {
  const request = { projectPath: "C:/work", } as never;
  assert.equal(
    localArtifactPath({ path: "a.pdf", sizeBytes: 1, checksum: "c", version: "v", uri: "file:///C:/Dev/HuAIChatroomSystem/%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf" }, request),
    "C:/Dev/HuAIChatroomSystem/보고서.pdf"
  );
  // 공개 주소로 올라간 산출물은 이 PC 경로가 아니다 — 파일 전달 대상이 아니다.
  assert.equal(
    localArtifactPath({ path: "a.html", sizeBytes: 1, checksum: "c", version: "v", uri: "https://huai-artifacts.vercel.app/a.html" }, request),
    undefined
  );
});

// 라이브 결함 — 달걀 게임 작업이 끝나자 방에 올라온 "결과물"이 egg-game-broken.png 였다.
// 작업자가 헤드리스 브라우저로 확인하며 찍은 디버그 스크린샷이다.
test("작업 중 부산물은 결과물로 보내지 않는다", () => {
  assert.equal(isDeliverableDocument("supabase/miniapp-web/egg-game-broken.png"), false);
  assert.equal(isDeliverableDocument("shot-debug.png"), false);
  assert.equal(isDeliverableDocument("layout-before.png"), false);
  assert.equal(isDeliverableDocument("node_modules/pkg/logo.png"), false);
  assert.equal(isDeliverableDocument("dist/report.pdf"), false);
  assert.equal(isDeliverableDocument(".cache/thumb.jpg"), false);
});

test("진짜 결과물은 그대로 보낸다", () => {
  assert.equal(isDeliverableDocument("개인회생_신청서.hwpx"), true);
  assert.equal(isDeliverableDocument("supabase/miniapp-web/게임화면.png"), true);
  assert.equal(isDeliverableDocument("DCF_평가결과.xlsx"), true);
});
