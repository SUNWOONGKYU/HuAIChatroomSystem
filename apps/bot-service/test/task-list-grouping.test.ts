import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";

const ROOM_ID = "00000000-0000-0000-0000-000000000010";

// commitTelegramInputResult 는 매 호출마다 telegram_chat_id 로 room_id 를 먼저 해석한다.
function roomResolutionResponse(): Response {
  return jsonResponse(200, [{ room_id: ROOM_ID }]);
}

function makeStore(fetchImpl: typeof fetch, now?: () => Date, miniAppDirectLinkBaseUrl?: string): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key-for-test", fetchImpl, now, miniAppDirectLinkBaseUrl });
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

// PostgREST 의 `Prefer: count=exact` 응답이 함께 실어 보내는 Content-Range 헤더를 모사한다.
// "0-{shown-1}/{total}" 형식.
function jsonResponseWithRange(status: number, body: unknown[], total: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "content-range": `0-${Math.max(0, body.length - 1)}/${total}` }
  });
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

test("그룹 헤더 + 세부 상태 라벨이 모두 나오고, 그룹 순서가 TASK_STATUS_GROUP_ORDER 를 따른다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [
      { task_id: "22222222-2222-4222-8222-222222222222", title: "진행 중 작업", status: "in_progress", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "차단된 작업", status: "blocked", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" },
      { task_id: "33333333-3333-4333-8333-333333333333", title: "검증 대기 작업", status: "verification_pending", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;

  // 그룹 헤더
  assert.match(text, /⚠️ 조치 필요/);
  assert.match(text, /▶️ 진행 중/);
  assert.match(text, /⏳ 대기 중/);
  // 세부 상태 라벨 (blocked 는 세부 라벨이 그룹 라벨과 글자가 같아 위 그룹 헤더 검사로
  // 이미 만족되므로 별도로 반복하지 않는다 — V1 지적)
  assert.match(text, /실행 중/);
  assert.match(text, /검증 대기/);

  const actionNeededIdx = text.indexOf("⚠️ 조치 필요");
  const inProgressIdx = text.indexOf("▶️ 진행 중");
  const waitingIdx = text.indexOf("⏳ 대기 중");
  assert.ok(actionNeededIdx >= 0 && inProgressIdx >= 0 && waitingIdx >= 0, "모든 그룹 헤더가 존재해야 함");
  assert.ok(actionNeededIdx < inProgressIdx, "action_needed 가 in_progress 보다 먼저 나와야 함");
  assert.ok(inProgressIdx < waitingIdx, "in_progress 가 waiting 보다 먼저 나와야 함");
});

test("경과시간이 주입한 now 를 기준으로 정확히 계산된다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, [
      { task_id: "22222222-2222-4222-8222-222222222222", title: "이틀 전 작업", status: "in_progress", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T03:00:00.000Z", created_at: "2026-08-13T03:00:00.000Z" }
    ]),
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "세 시간 전 작업", status: "blocked", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-15T00:00:00.000Z", created_at: "2026-08-15T00:00:00.000Z" },
      { task_id: "33333333-3333-4333-8333-333333333333", title: "방금 작업", status: "verification_pending", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-15T02:59:40.000Z", created_at: "2026-08-15T02:59:40.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl, () => new Date("2026-08-15T03:00:00.000Z"));

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;
  const lines = text.split("\n");

  const threeHourLineIdx = lines.findIndex((line) => line.includes("세 시간 전 작업"));
  const twoDayLineIdx = lines.findIndex((line) => line.includes("이틀 전 작업"));
  const justNowLineIdx = lines.findIndex((line) => line.includes("방금 작업"));
  assert.ok(threeHourLineIdx >= 0 && twoDayLineIdx >= 0 && justNowLineIdx >= 0);

  assert.match(lines[threeHourLineIdx + 1] ?? "", /3시간 전/);
  assert.match(lines[twoDayLineIdx + 1] ?? "", /2일 전/);
  assert.match(lines[justNowLineIdx + 1] ?? "", /방금/);
});

test("비어있는 그룹은 출력되지 않는다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, []),
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "완료된 작업 1", status: "completed", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" },
      { task_id: "22222222-2222-4222-8222-222222222222", title: "완료된 작업 2", status: "completed", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;

  assert.match(text, /✅ 완료/);
  assert.equal(text.includes("🗳️ 승인 대기"), false);
  assert.equal(text.includes("⚠️ 조치 필요"), false);
  assert.equal(text.includes("▶️ 진행 중"), false);
  assert.equal(text.includes("⏳ 대기 중"), false);
  assert.equal(text.includes("⏸️ 일시정지"), false);
  assert.equal(text.includes("🚫 종료됨"), false);
});

test("작업이 0건일 때 정확한 문구가 나온다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, []),
    jsonResponse(200, []),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;
  assert.equal(text, "작업 목록\n현재 등록된 작업이 없습니다.");

  const actorsRequest = calls.requests.find((request) => request.url.includes("/huai_ai_actors"));
  assert.equal(actorsRequest, undefined, "작업이 없으면 담당자 조회 요청 자체가 없어야 함");
});

test("담당자 없는 task 는 \"미배정\"으로 표시되고, 담당자 조회 자체가 스킵된다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, []),
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "담당자 없는 작업", status: "blocked", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;
  assert.match(text, /미배정/);

  const actorsRequest = calls.requests.find((request) => request.url.includes("/huai_ai_actors"));
  assert.equal(actorsRequest, undefined, "담당자가 아무도 없으면 huai_ai_actors 조회를 하지 않아야 함");
});

test("알 수 없는 role 이 와도 원본 role 문자열로 폴백한다(깨지지 않는다)", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponse(200, []),
    jsonResponse(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "미지의 역할 작업", status: "blocked", priority: "normal", assignee_actor_id: "actor-mystery", updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ]),
    jsonResponse(200, [{ actor_id: "actor-mystery", role: "some_future_role" }]),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await assert.doesNotReject(
    store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }))
  );

  const text = calls.requests[4]?.body[0].payload.text as string;
  assert.match(text, /some_future_role/);
});

// V1 결함 2: 헤더가 "총 N건"이라면서 실제로는 safeLimit(기본 10)으로 잘린 rows.length 만 세고
// 있었다. 방에 25건 있어도 "총 10건"으로 보였다 — 방장이 방 전체를 다 봤다고 착각한다.
// PostgREST 의 count=exact 로 받은 Content-Range 총 건수와 비교해 "더 있음"을 밝힌다.
test("방에 표시 한도보다 많은 작업이 있으면 '더 있음'을 명시한다(총 건수 오표기 방지)", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    task_id: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    title: `작업 ${i + 1}`,
    status: "in_progress",
    priority: "normal",
    assignee_actor_id: null,
    updated_at: "2026-08-13T01:00:00.000Z",
    created_at: "2026-08-13T00:00:00.000Z"
  }));
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponseWithRange(200, rows, 25), // 방엔 실제로 25건 있는데 limit=30 으로 10건만 옴(in_progress 전량)
    jsonResponse(200, []), // non-in_progress: 0건
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;
  assert.match(text, /최근 10건/);
  assert.match(text, /전체 25건/);
  assert.match(text, /15건 더 있음/);
  assert.equal(text.includes("총 10건"), false, "실제보다 적은 총 건수를 '총'이라고 오표기하면 안 된다");
});

test("표시된 것이 방의 전부일 때는 여전히 '총 N건'으로 정확히 표기한다", async () => {
  const rows = [
    { task_id: "11111111-1111-4111-8111-111111111111", title: "작업 1", status: "in_progress", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
  ];
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponseWithRange(200, rows, 1), // 방에도 딱 1건뿐이다 — 보여준 게 전부
    jsonResponse(200, []), // non-in_progress: 0건
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const text = calls.requests[3]?.body[0].payload.text as string;
  assert.match(text, /총 1건/);
  assert.equal(text.includes("더 있음"), false);
});

// "작업 현황판 열기" 버튼(Direct Link Mini App). web_app 타입이 아니라 url 타입 — Telegram 공식
// 문서(InlineKeyboardButton.web_app: "Available only in private chats")상 web_app 버튼은
// 그룹에서 안 눌린다. BOT_SERVICE_MINIAPP_DIRECT_LINK 로 베이스 링크를 받아 ?startapp=<roomId>
// 를 붙인다.
test("BOT_SERVICE_MINIAPP_DIRECT_LINK 가 설정되면 /tasks 응답에 '작업 현황판 열기' url 버튼이 붙는다", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponseWithRange(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "작업 1", status: "in_progress", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ], 1),
    jsonResponse(200, []),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl, undefined, "https://t.me/leader_chatroom_bot/board");

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const keyboard = calls.requests[3]?.body[0].payload.keyboard;
  assert.ok(keyboard, "keyboard 필드가 있어야 한다");
  const button = keyboard.inline_keyboard[0][0];
  assert.equal(button.text, "작업 현황판 열기");
  assert.equal(button.url, `https://t.me/leader_chatroom_bot/board?startapp=${ROOM_ID}`);
  assert.equal("callback_data" in button, false);
  assert.equal("web_app" in button, false);
});

// V1 스타일 요구사항: 미설정 시 기존 동작과 완전히 동일해야 한다 — payload 에 keyboard
// 필드 자체가 생기면 안 된다(값이 없는 게 아니라 키 자체가 없어야, 기존과 완전히
// 같은 payload 모양이 나간다).
test("BOT_SERVICE_MINIAPP_DIRECT_LINK 가 미설정이면 /tasks 응답에 keyboard 필드가 아예 없다 (기존 동작 완전 보존)", async () => {
  const calls = makeSupabaseFetch([
    roomResolutionResponse(),
    jsonResponseWithRange(200, [
      { task_id: "11111111-1111-4111-8111-111111111111", title: "작업 1", status: "in_progress", priority: "normal", assignee_actor_id: null, updated_at: "2026-08-13T01:00:00.000Z", created_at: "2026-08-13T00:00:00.000Z" }
    ], 1),
    jsonResponse(200, []),
    jsonResponse(201, [outboxRow({ text: "placeholder" })])
  ]);
  const store = makeStore(calls.fetchImpl); // miniAppDirectLinkBaseUrl 안 넘김

  await store.commitTelegramInputResult(makeOutboxCommit("telegram:query:tasks", { text: "placeholder", query: { kind: "tasks", limit: 10 } }));

  const payload = calls.requests[3]?.body[0].payload;
  assert.equal("keyboard" in payload, false, "미설정 시 keyboard 키 자체가 없어야 한다");
});

test("BOT_SERVICE_MINIAPP_DIRECT_LINK 가 https://t.me/ 로 시작하지 않으면 생성 시점에 던진다", () => {
  assert.throws(
    () => new SupabaseBotServiceStore({
      url: "https://example.supabase.co",
      serviceRoleKey: "service-role-key-for-test",
      miniAppDirectLinkBaseUrl: "https://example.com/miniapp"
    }),
    /invalid-env:BOT_SERVICE_MINIAPP_DIRECT_LINK/
  );
});
