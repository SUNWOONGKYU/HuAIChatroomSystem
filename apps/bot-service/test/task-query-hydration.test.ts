import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";

const ROOM_ID = "00000000-0000-0000-0000-000000000010";

// commitTelegramInputResult 는 매 호출마다 telegram_chat_id 로 room_id 를 먼저 해석한다.
function roomResolutionResponse(): Response {
  return jsonResponse(200, [{ room_id: ROOM_ID }]);
}

test("hydrates /tasks outbox from Supabase task rows", async () => {
  // 작업 목록은 조회를 두 번 한다.
  //
  // 진행 중(in_progress) 작업은 오래 돌면서 updated_at 이 밀려, 하나의
  // `order=updated_at.desc&limit=N` 창에서 뒤로 떨어져 나간다. 그러면 방장이 /tasks 를
  // 쳤을 때 지금 돌고 있는 작업이 목록에 안 보인다 — 라이브에서 "진행상황이 안 보인다"로
  // 제기된 결함이다. 그래서 진행 중은 따로 뽑아 항상 포함시키고, 나머지를 남은 자리에 채운다.
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "Telegram UX 개선", status: "in_progress", priority: "high", assignee_actor_id: "actor-codex", updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(200, []),
    jsonResponse(200, [{ actor_id: "actor-codex", role: "codex_leader" }]),
    jsonResponse(201, [outboxRow({ text: "작업 목록" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "작업 목록 조회 요청을 접수했습니다.", query: { kind: "tasks", limit: 10 } }));

  // 조회가 둘로 갈라졌으므로 방 격리 조건이 양쪽 모두에 걸려야 한다. 한쪽만 걸리면
  // 그 쪽으로 다른 방 작업이 새어 들어온다.
  assert.match(calls.requests[1]?.url ?? "", /\/huai_tasks\?room_id=eq\./);
  assert.match(calls.requests[1]?.url ?? "", /status=eq\.in_progress/);
  assert.match(calls.requests[2]?.url ?? "", /\/huai_tasks\?room_id=eq\./);
  assert.match(calls.requests[2]?.url ?? "", /status=neq\.in_progress/);

  const text = calls.requests[4]?.body[0].payload.text;
  assert.match(text, /작업 목록/);
  assert.match(text, /Telegram UX 개선/);
  assert.match(text, /진행 중/); // 그룹 헤더
  assert.match(text, /실행 중/); // 세부 상태 라벨
  assert.match(text, /CodexBot/); // 담당자 표시명
});

test("hydrates /task outbox from Supabase task detail", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [
      { task_id: taskId, title: "감사 흐름 조정", status: "commander_completion_pending", priority: "normal", purpose: "불필요한 자동 감사 제거", scope: "Telegram 버튼 흐름", completion_criteria: "직접 요청만 감사", updated_at: "2026-08-13T02:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "작업 상세" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:task", { text: "작업 상세 조회 요청을 접수했습니다: " + taskId, query: { kind: "task", taskId } }));

  assert.match(calls.requests[1]?.url ?? "", /task_id=eq\.22222222/);
  assert.match(calls.requests[1]?.url ?? "", /room_id=eq\./);
  assert.match(calls.requests[2]?.body[0].payload.text, /작업 상세/);
  assert.match(calls.requests[2]?.body[0].payload.text, /감사 흐름 조정/);
  assert.match(calls.requests[2]?.body[0].payload.text, /리더 완료 확인 대기/);
});

function makeStore(fetchImpl: typeof fetch): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key-for-test", fetchImpl });
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
  return { huai_outbox_id: "outbox-query", event_id: null, idempotency_key: "telegram:query", target_kind: "telegram_bot", target: JSON.stringify({ kind: "telegram_bot", botRole: "leader", telegramChatId: "1001" }), payload, status: "pending", attempts: 0, created_at: "2026-08-13T00:00:00.000Z" };
}

function makeOutboxCommit(idempotencyKey: string, payload: Record<string, unknown>) {
  return {
    message: { input: { kind: "command" as const, envelope: new TelegramUpdateEnvelope("bot", "leader_bot", "leader", "1", "1001", "10", "2001", false, "/tasks", undefined), command: { name: "/tasks" as const, args: [] } }, idempotencyKey: "telegram-update:bot:1", receivedAt: "2026-08-13T00:00:00.000Z" },
    result: { accepted: true as const, authorization: { allowed: true as const }, events: [], outbox: [{ target: { kind: "telegram_bot" as const, botRole: "leader" as const, telegramChatId: "1001" }, idempotencyKey, payload }] }
  };
}

test("hydrates /search outbox from Supabase task rows", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [
      { task_id: "33333333-3333-4333-8333-333333333333", title: "버튼 UX 개선", status: "scheduled", priority: "normal", assignee_actor_id: "actor-codex", updated_at: "2026-08-13T03:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "작업 검색" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:search", { text: "작업 검색 요청을 접수했습니다: 버튼", query: { kind: "search", term: "버튼" } }));

  assert.match(calls.requests[1]?.url ?? "", /or=\(title\.ilike\./);
  assert.match(calls.requests[2]?.body[0].payload.text, /작업 검색: 버튼/);
  assert.match(calls.requests[2]?.body[0].payload.text, /버튼 UX 개선/);
});

// humanTaskStatus() 를 없애고 TASK_STATUS_META 를 단일 출처로 통일했다. /search 는 별도
// 상태 라벨 어서션이 없었어서(제목/검색어만 확인) 이 통일이 실제로 여기까지 적용됐는지
// 아무 것도 증명하지 못하고 있었다 — 상태 라벨 전용 회귀를 추가한다.
test("hydrates /search outbox with human-readable status label (not raw snake_case)", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [
      { task_id: "44444444-4444-4444-8444-444444444444", title: "검증 대기 작업", status: "verification_pending", priority: "normal", assignee_actor_id: "actor-codex", updated_at: "2026-08-13T03:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "작업 검색" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:search", { text: "작업 검색 요청을 접수했습니다: 검증", query: { kind: "search", term: "검증" } }));

  const text = calls.requests[2]?.body[0].payload.text;
  assert.match(text, /검증 대기/);
  assert.equal(text.includes("verification_pending"), false, "raw snake_case 가 /search 에 새면 안 된다");
});


test("hydrates /trace outbox from event artifact and verification rows", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [{ task_id: taskId }]), // taskBelongsToRoom 가드
    jsonResponse(200, [{ event_type: "meaningful_intermediate_ready", created_at: "2026-08-13T04:00:00.000Z" }]),
    jsonResponse(200, [{ uri: "supabase://bucket/report.md?token=SECRET", version: "v1", is_final: true, created_at: "2026-08-13T04:01:00.000Z" }]),
    jsonResponse(200, [{ verdict: "pass", target_version: "attempt-audit", created_at: "2026-08-13T04:02:00.000Z" }]),
    jsonResponse(201, [outboxRow({ text: "작업 이력" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:trace", { text: "작업 이력 조회 요청을 접수했습니다: " + taskId, query: { kind: "trace", taskId } }));

  const text = calls.requests[5]?.body[0].payload.text;
  assert.match(calls.requests[1]?.url ?? "", /huai_tasks\?task_id=eq\..*room_id=eq\./);
  assert.match(calls.requests[2]?.url ?? "", /huai_events/);
  assert.match(calls.requests[3]?.url ?? "", /huai_artifacts/);
  assert.match(calls.requests[4]?.url ?? "", /huai_verifications/);
  assert.match(text, /작업 이력/);
  assert.match(text, /meaningful_intermediate_ready/);
  assert.match(text, /supabase:\/\/bucket\/report\.md/);
  assert.equal(text.includes("SECRET"), false);
  assert.match(text, /pass/);
});
