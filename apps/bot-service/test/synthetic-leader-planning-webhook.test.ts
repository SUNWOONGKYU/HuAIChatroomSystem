import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramWebhookHttpServer } from "../src/http.js";
import { processTelegramInboundWithPersistence } from "../src/persistence.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";
import { type TelegramInboundQueueMessage } from "../../../packages/contracts/src/index.js";
import { SupabaseOutboxStore } from "../../../packages/supabase-runtime/src/index.js";

// 운영 Telegram/Supabase를 절대 호출하지 않는 synthetic webhook 시나리오.
// 5001=방장, 9001=참여자이며 모든 턴은 하나의 가상 room에만 기록된다.
const CHAT = "-1005001005001";
const ROOM = "11111111-1111-4111-8111-111111111111";
const SECRET = "synthetic-secret";

test("synthetic webhook 4턴이 최근 대화를 읽은 LeaderBot 계획과 구조화 proposal로 이어진다", async () => {
  const queued: TelegramInboundQueueMessage[] = [];
  const updates: Array<{ raw_update: Record<string, unknown>; received_at: string }> = [];
  const requests: Array<{ method: string; url: string; body?: any }> = [];
  let eventNumber = 0;

  const fetchImpl: typeof fetch = async (url, init) => {
    const method = String(init?.method ?? "GET");
    const requestUrl = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url: requestUrl, body });
    const path = new URL(requestUrl).pathname;

    if (method === "POST" && path.endsWith("/huai_telegram_updates")) {
      updates.push({ raw_update: body.raw_update, received_at: `2026-08-28T00:00:0${updates.length}.000Z` });
      return jsonResponse(201, [{ status: "received" }]);
    }
    if (method === "PATCH" && path.endsWith("/huai_telegram_updates")) return new Response(null, { status: 204 });
    if (method === "GET" && path.endsWith("/huai_rooms")) {
      return jsonResponse(200, requestUrl.includes("select=purpose") ? [{ purpose: "Synthetic 협업방" }] : [{ room_id: ROOM }]);
    }
    if (method === "GET" && path.endsWith("/huai_telegram_updates")) {
      return jsonResponse(200, [...updates].reverse());
    }
    if (method === "GET" && path.endsWith("/huai_room_members")) {
      return jsonResponse(200, requestUrl.includes("role=eq.owner") ? [{ telegram_user_id: "5001" }] : [{ telegram_user_id: "5001" }, { telegram_user_id: "9001" }]);
    }
    if (method === "GET" && path.endsWith("/huai_ai_actors")) {
      return jsonResponse(200, requestUrl.includes("role=eq.leader") ? [{ actor_id: "leader-actor", cli_session_id: "synthetic-session" }] : [{ role: "leader" }]);
    }
    if (method === "GET" && path.endsWith("/huai_tasks")) return jsonResponse(200, []);
    if (method === "POST" && path.endsWith("/huai_events")) {
      const rows = Array.isArray(body) ? body : [body];
      return jsonResponse(201, rows.map((row) => ({ ...row, event_id: `event-${++eventNumber}`, created_at: "2026-08-28T00:00:10.000Z" })));
    }
    if (method === "POST" && path.endsWith("/huai_outbox")) {
      const rows = Array.isArray(body) ? body : [body];
      return jsonResponse(201, rows.map((row, index) => ({ ...row, huai_outbox_id: `outbox-${index + 1}`, status: "pending", attempts: 0, created_at: "2026-08-28T00:00:10.000Z" })));
    }
    throw new Error(`unexpected synthetic REST call: ${method} ${requestUrl}`);
  };

  const persistence = new SupabaseBotServiceStore({ url: "https://synthetic.invalid", serviceRoleKey: "synthetic-only", fetchImpl });
  const server = createTelegramWebhookHttpServer({
    config: {
      allowedChatIds: [CHAT],
      botsByUsername: new Map([["leader_bot", { telegramBotId: "synthetic-leader", botUsername: "leader_bot", botRole: "leader", webhookSecret: SECRET }]])
    },
    ports: { updates: persistence, inboundQueue: { async enqueue(message) { queued.push(message); } } }
  });

  const turns = [
    [9001, "결제 실패율이 올라간 것 같아"],
    [5001, "재시도 로직과 타임아웃을 같이 확인해보자"],
    [9001, "실패 로그도 누락되는지 비교해야 해"],
    [5001, "@leader_bot 위 논의를 바탕으로 원인 조사와 수정 계획을 세워줘"]
  ] as const;

  const port = await listen(server);
  try {
    for (const [index, [userId, text]] of turns.entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook/leader_bot`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify(update(userId, text, index + 1))
      });
      assert.equal(response.status, 200);
    }
    assert.equal(queued.length, 4);

    for (const message of queued) {
      const result = await processTelegramInboundWithPersistence({ message, processorPorts: processorPorts(), persistence });
      assert.equal(result.accepted, true);
    }

    const planningInsert = requests.find((request) => request.method === "POST" && request.url.endsWith("/huai_outbox") && JSON.stringify(request.body).includes("leader-planning"));
    const planningRow = Array.isArray(planningInsert?.body) ? planningInsert.body[0] : planningInsert?.body;
    const planningPrompt = planningRow?.payload?.executionRequest?.prompt as string | undefined;
    assert.match(planningPrompt ?? "", /결제 실패율이 올라간 것 같아/);
    assert.match(planningPrompt ?? "", /재시도 로직과 타임아웃/);
    assert.match(planningPrompt ?? "", /실패 로그도 누락/);
    assert.match(planningPrompt ?? "", /\[방장\]/);
    assert.match(planningPrompt ?? "", /위 논의를 바탕으로/);

    const runtimeRequests: Array<{ method: string; url: string; body?: any }> = [];
    const runtimeFetch: typeof fetch = async (url, init) => {
      const method = String(init?.method ?? "GET");
      const requestUrl = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      runtimeRequests.push({ method, url: requestUrl, body });
      if (method === "GET" && requestUrl.includes("/huai_rooms?room_id=")) return jsonResponse(200, [{ telegram_chat_id: CHAT }]);
      if (method === "POST" && requestUrl.endsWith("/huai_events")) {
        const rows = Array.isArray(body) ? body : [body];
        return jsonResponse(201, rows.map((row) => ({ ...row, event_id: "runtime-event", created_at: "2026-08-28T00:01:00.000Z" })));
      }
      if (method === "POST" && requestUrl.endsWith("/huai_outbox")) return jsonResponse(201, []);
      throw new Error(`unexpected synthetic runtime call: ${method} ${requestUrl}`);
    };
    const runtime = new SupabaseOutboxStore({ url: "https://synthetic.invalid", serviceRoleKey: "synthetic-only", fetchImpl: runtimeFetch });
    await runtime.recordGatewayExecutionResult({
      request: { ...planningRow.payload.executionRequest, actorId: "leader-actor", reportBotRole: "leader" },
      status: "completed",
      events: [{ type: "stdout", taskId: "planning_1", attemptId: "leader-planning-planning_1", text: [
        "DECISION: plan",
        "TITLE: 결제 실패율 원인 조사 및 수정",
        "PURPOSE: 실패 원인을 특정하고 재발을 막는다",
        "SCOPE: 재시도 로직·타임아웃·실패 로그 누락을 조사하고 수정한다",
        "DONE: 원인 보고서 제출, 수정 적용, 관련 테스트 통과",
        "ASSIGNEE: both",
        "REASON: 조사와 구현을 분리 검토한다",
        "VARIANTS: 1",
        "MUTATES: yes"
      ].join("\n") }],
      occurredAt: "2026-08-28T00:01:00.000Z"
    });

    const proposal = runtimeRequests.find((request) => request.method === "POST" && request.url.endsWith("/huai_events") && request.body?.event_type === "proposal_created");
    const payload = proposal?.body?.payload;
    assert.ok(payload, "계획 결과가 proposal_created로 변환되어야 한다");
    assert.ok(payload.title && payload.purpose && payload.scope && payload.completionCriteria, "proposal은 제목·목적·범위·완료조건을 모두 가져야 한다");
  } finally {
    await close(server);
  }
});

function update(userId: number, text: string, updateId: number) {
  return { update_id: 8000 + updateId, message: { message_id: 9000 + updateId, chat: { id: CHAT }, from: { id: userId, is_bot: false }, text } };
}

function processorPorts() {
  return {
    authorization: { memberships: [
      { telegramChatId: CHAT, telegramUserId: "5001", role: "owner" as const, permissions: ["task:create", "task:read"] as const, status: "active" as const },
      { telegramChatId: CHAT, telegramUserId: "9001", role: "human_member" as const, permissions: ["task:create", "task:read"] as const, status: "active" as const }
    ] },
    orchestrator: {
      makeId: (prefix: string) => `${prefix}_1`,
      now: () => "2026-08-28T00:00:00.000Z",
      executionDefaults: { roomId: ROOM, actorId: "leader-actor", adapterType: "codex" as const, projectPath: process.cwd(), timeoutMs: 60_000, gatewayId: "synthetic", promptForTask: (taskId: string) => `run ${taskId}` }
    }
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function listen(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: ReturnType<typeof createTelegramWebhookHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
