import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";

test("hydrates /tasks outbox from Supabase task rows", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "Telegram UX 개선", status: "running", priority: "high", assignee_actor_id: "actor-codex", updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "작업 목록" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "작업 목록 조회 요청을 접수했습니다.", query: { kind: "tasks", limit: 10 } }));

  assert.match(calls.requests[0]?.url ?? "", /\/huai_tasks\?room_id=eq\./);
  assert.match(calls.requests[1]?.body[0].payload.text, /작업 목록/);
  assert.match(calls.requests[1]?.body[0].payload.text, /Telegram UX 개선/);
  assert.match(calls.requests[1]?.body[0].payload.text, /실행 중/);
});

test("hydrates /task outbox from Supabase task detail", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeSupabaseFetch([
    jsonResponse(200, [
      { task_id: taskId, title: "감사 흐름 조정", status: "verified", priority: "normal", purpose: "불필요한 자동 감사 제거", scope: "Telegram 버튼 흐름", completion_criteria: "직접 요청만 감사", updated_at: "2026-08-13T02:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "작업 상세" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:task", { text: "작업 상세 조회 요청을 접수했습니다: " + taskId, query: { kind: "task", taskId } }));

  assert.match(calls.requests[0]?.url ?? "", /task_id=eq\.22222222/);
  assert.match(calls.requests[1]?.body[0].payload.text, /작업 상세/);
  assert.match(calls.requests[1]?.body[0].payload.text, /감사 흐름 조정/);
  assert.match(calls.requests[1]?.body[0].payload.text, /검증 완료/);
});

function makeStore(fetchImpl: typeof fetch): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key-for-test", roomId: "00000000-0000-0000-0000-000000000010", fetchImpl });
}

function makeSupabaseFetch(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call");
    return response;
  };
  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: body === null ? undefined : { "content-type": "application/json" } });
}

function outboxRow(payload: Record<string, unknown>) {
  return { huai_outbox_id: "outbox-query", event_id: null, idempotency_key: "telegram:query", target_kind: "telegram_bot", target: JSON.stringify({ kind: "telegram_bot", botRole: "platoon_leader", telegramChatId: "1001" }), payload, status: "pending", attempts: 0, created_at: "2026-08-13T00:00:00.000Z" };
}

function makeOutboxCommit(idempotencyKey: string, payload: Record<string, unknown>) {
  return {
    message: { input: { kind: "command" as const, envelope: new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", "1", "1001", "10", "2001", false, "/tasks", undefined), command: { name: "/tasks" as const, args: [] } }, idempotencyKey: "telegram-update:bot:1", receivedAt: "2026-08-13T00:00:00.000Z" },
    result: { accepted: true as const, authorization: { allowed: true as const }, events: [], outbox: [{ target: { kind: "telegram_bot" as const, botRole: "platoon_leader" as const, telegramChatId: "1001" }, idempotencyKey, payload }] }
  };
}

test("hydrates /search outbox from Supabase task rows", async () => {
  const calls = makeSupabaseFetch([
    jsonResponse(200, [
      { task_id: "33333333-3333-4333-8333-333333333333", title: "버튼 UX 개선", status: "scheduled", priority: "normal", assignee_actor_id: "actor-codex", updated_at: "2026-08-13T03:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "작업 검색" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:search", { text: "작업 검색 요청을 접수했습니다: 버튼", query: { kind: "search", term: "버튼" } }));

  assert.match(calls.requests[0]?.url ?? "", /or=\(title\.ilike\./);
  assert.match(calls.requests[1]?.body[0].payload.text, /작업 검색: 버튼/);
  assert.match(calls.requests[1]?.body[0].payload.text, /버튼 UX 개선/);
});


test("hydrates /trace outbox from event artifact and verification rows", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeSupabaseFetch([
    jsonResponse(200, [{ event_type: "meaningful_intermediate_ready", created_at: "2026-08-13T04:00:00.000Z" }]),
    jsonResponse(200, [{ uri: "supabase://bucket/report.md?token=SECRET", version: "v1", is_final: true, created_at: "2026-08-13T04:01:00.000Z" }]),
    jsonResponse(200, [{ verdict: "pass", target_version: "attempt-audit", created_at: "2026-08-13T04:02:00.000Z" }]),
    jsonResponse(201, [outboxRow({ text: "작업 이력" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:trace", { text: "작업 이력 조회 요청을 접수했습니다: " + taskId, query: { kind: "trace", taskId } }));

  const text = calls.requests[3]?.body[0].payload.text;
  assert.match(calls.requests[0]?.url ?? "", /huai_events/);
  assert.match(calls.requests[1]?.url ?? "", /huai_artifacts/);
  assert.match(calls.requests[2]?.url ?? "", /huai_verifications/);
  assert.match(text, /작업 이력/);
  assert.match(text, /meaningful_intermediate_ready/);
  assert.match(text, /supabase:\/\/bucket\/report\.md/);
  assert.equal(text.includes("SECRET"), false);
  assert.match(text, /pass/);
});
