import assert from "node:assert/strict";
import test from "node:test";
import { buildBotServiceRuntimeFromEnvAsync } from "../src/local-runtime.js";
import { loadSupabaseBotServiceRuntimeConfig } from "../src/supabase-runtime-loader.js";

const roomId = "00000000-0000-0000-0000-000000000010";
const codexActorId = "00000000-0000-0000-0000-000000000103";

test("loads authorization and bot runtime from Supabase room id", async () => {
  const fetchCalls: string[] = [];
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    roomId,
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls)
  });

  assert.deepEqual(loaded.config.allowedChatIds, ["1001"]);
  assert.equal(loaded.authorization.memberships[0]?.telegramUserId, "2001");
  assert.equal(loaded.authorization.memberships[0]?.role, "owner");
  assert.deepEqual(loaded.authorization.memberships[0]?.permissions, ["task:create", "task:read"]);
  assert.equal(loaded.config.botsByUsername.get("codex_bot")?.webhookSecret, "codex-secret");
  assert.equal(loaded.actors.find((actor) => actor.role === "codex_leader")?.actorId, codexActorId);
  assert.equal(loaded.gateways[0]?.gatewayId, "gateway-local");
  assert.deepEqual(loaded.gateways[0]?.allowedProjectRoots, ["C:/Dev/HuAIChatroomSystem"]);
  assert.ok(fetchCalls.some((url) => url.includes("/huai_rooms?room_id=eq.")));
});

test("loads runtime by telegram chat id for server startup path", async () => {
  const runtime = await buildBotServiceRuntimeFromEnvAsync({
    ...secretEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_TELEGRAM_CHAT_ID: "1001"
  }, { fetchImpl: fakeRuntimeFetch([]) });

  assert.equal(runtime.storeKind, "supabase");
  assert.deepEqual(runtime.config.allowedChatIds, ["1001"]);
  assert.equal(runtime.config.botsByUsername.get("platoon_bot")?.botRole, "platoon_leader");

  const queued = await runtime.processQueuedInputs();
  assert.deepEqual(queued, []);
});

test("fails when a database webhook secret ref is missing from env", async () => {
  await assert.rejects(
    () => loadSupabaseBotServiceRuntimeConfig({
      url: "https://example.supabase.co",
      serviceRoleKey: "test-service-role-key",
      roomId,
      env: {},
      fetchImpl: fakeRuntimeFetch([])
    }),
    /missing-env:BOT_SERVICE_PLATOON_WEBHOOK_SECRET/
  );
});

// 봇은 room 과 무관한 공통 계정이라 actor_id 로는 찾을 수 없다(다른 방에서는 이 방의
// actor 를 가리키지 않는다). role 기준 조회로 되돌아가지 않으면(예: actor_id=in. 로
// 회귀) 다른 방에서는 봇 조회가 0건이 되어 모든 update 가 unknown-bot 으로 무시된다 —
// 이 회귀를 여기서 잡는다.
test("requests telegram bots by active actor role, never by actor_id", async () => {
  const fetchCalls: string[] = [];
  await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    roomId,
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls)
  });

  const botsCall = fetchCalls.find((url) => url.includes("/huai_telegram_bots?"));
  assert.ok(botsCall, "expected a /huai_telegram_bots request");
  assert.match(botsCall, /role=in\.\(/);
  assert.match(botsCall, /status=eq\.active/);
  assert.doesNotMatch(botsCall, /actor_id=in\./);
});

// 이 방의 auditor actor 가 active 가 아니면 auditor role 은 요청에도, 결과에도
// 나오면 안 된다 — 봇 조회가 "이 방에서 지금 활동 중인 role" 로 범위가 좁혀져야 한다.
test("excludes a bot role whose actor in this room is not active", async () => {
  const fetchCalls: string[] = [];
  const actorsWithInactiveAuditor = [
    actor("00000000-0000-0000-0000-000000000101", "platoon_leader", "orchestrator"),
    actor("00000000-0000-0000-0000-000000000102", "claude_leader", "claude_code"),
    actor(codexActorId, "codex_leader", "codex"),
    actor("00000000-0000-0000-0000-000000000104", "auditor", "auditor", "inactive")
  ];

  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    roomId,
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls, { actors: actorsWithInactiveAuditor })
  });

  assert.equal(loaded.config.botsByUsername.size, 3);
  assert.equal(loaded.config.botsByUsername.has("auditor_bot"), false);
  const botsCall = fetchCalls.find((url) => url.includes("/huai_telegram_bots?"));
  assert.doesNotMatch(botsCall ?? "", /auditor/);
});

// bots 테이블에 아직 아무 행도 없어도(초기 시딩 전, 혹은 role 이 전부 걸러진 경우)
// 예외 없이 빈 맵으로 진행해야 한다 — routeTelegramUpdate 가 unknown-bot 으로
// 처리할 수 있도록.
test("resolves to an empty bot map without throwing when the bots table has no matching rows", async () => {
  const fetchCalls: string[] = [];
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    roomId,
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls, { bots: [] })
  });

  assert.equal(loaded.config.botsByUsername.size, 0);
  assert.ok(fetchCalls.some((url) => url.includes("/huai_telegram_bots?")));
});

// 이 방에 active actor 가 하나도 없으면 role 집합이 비므로, 애초에
// huai_telegram_bots 조회를 나가지 않는 조기 반환 경로(roles.length === 0)를 탄다.
test("skips the telegram bots lookup entirely when no actor in the room is active", async () => {
  const fetchCalls: string[] = [];
  const allInactiveActors = [
    actor("00000000-0000-0000-0000-000000000101", "platoon_leader", "orchestrator", "inactive"),
    actor("00000000-0000-0000-0000-000000000102", "claude_leader", "claude_code", "disabled"),
    actor(codexActorId, "codex_leader", "codex", "inactive"),
    actor("00000000-0000-0000-0000-000000000104", "auditor", "auditor", "disabled")
  ];

  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    roomId,
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls, { actors: allInactiveActors })
  });

  assert.equal(loaded.config.botsByUsername.size, 0);
  assert.equal(fetchCalls.some((url) => url.includes("/huai_telegram_bots?")), false);
});

function secretEnv(): NodeJS.ProcessEnv {
  return {
    BOT_SERVICE_PLATOON_WEBHOOK_SECRET: "platoon-secret",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "claude-secret",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "codex-secret",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "auditor-secret"
  };
}

type ActorFixture = { actor_id: string; role: string; adapter_type: string; status: string };
type BotFixture = { telegram_bot_id: string; bot_username: string; role: string; webhook_secret_ref: string; status: string };

function defaultActors(): ActorFixture[] {
  return [
    actor("00000000-0000-0000-0000-000000000101", "platoon_leader", "orchestrator"),
    actor("00000000-0000-0000-0000-000000000102", "claude_leader", "claude_code"),
    actor(codexActorId, "codex_leader", "codex"),
    actor("00000000-0000-0000-0000-000000000104", "auditor", "auditor")
  ];
}

function defaultBots(): BotFixture[] {
  return [
    bot("00000000-0000-0000-0000-000000000201", "platoon_bot", "platoon_leader", "env:BOT_SERVICE_PLATOON_WEBHOOK_SECRET"),
    bot("00000000-0000-0000-0000-000000000202", "claude_bot", "claude_leader", "env:BOT_SERVICE_CLAUDE_WEBHOOK_SECRET"),
    bot("00000000-0000-0000-0000-000000000203", "codex_bot", "codex_leader", "env:BOT_SERVICE_CODEX_WEBHOOK_SECRET"),
    bot("00000000-0000-0000-0000-000000000204", "auditor_bot", "auditor", "env:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET")
  ];
}

function fakeRuntimeFetch(
  calls: string[],
  overrides: { actors?: ActorFixture[]; bots?: BotFixture[] } = {}
): typeof fetch {
  const actorRows = overrides.actors ?? defaultActors();
  const botRows = overrides.bots ?? defaultBots();

  return (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/huai_rooms?")) {
      return jsonResponse([{ room_id: roomId, telegram_chat_id: "1001", status: "active" }]);
    }
    if (href.includes("/huai_room_members?")) {
      return jsonResponse([
        {
          telegram_user_id: "2001",
          role: "owner",
          permissions: ["task:create", "task:read"],
          status: "active"
        }
      ]);
    }
    if (href.includes("/huai_ai_actors?")) {
      return jsonResponse(actorRows);
    }
    if (href.includes("/huai_gateway_instances?")) {
      return jsonResponse([
        {
          gateway_id: "gateway-local",
          status: "online",
          allowed_project_roots: ["C:/Dev/HuAIChatroomSystem"],
          allowed_adapters: ["codex", "claude_code"]
        }
      ]);
    }
    if (href.includes("/huai_telegram_bots?")) {
      // 실제 PostgREST 처럼 role=in.(...)&status=eq.active 쿼리를 그대로 적용해서
      // 걸러준다. 코드가 actor_id=in. 로 되돌아가면 여기서 role 필터를 못 찾아
      // 예외를 던진다(그 자체가 회귀 신호).
      const requestedRoles = parseRoleInFilter(href);
      const filtered = botRows.filter(
        (row) => row.status === "active" && requestedRoles.includes(row.role)
      );
      // select= 로 요청한 컬럼만 투영해서 돌려준다. 이걸 무시하고 항상 전체
      // 행을 돌려주면, select 목록에서 컬럼이 빠지는 회귀(예: role 누락)를
      // 이 fake fetch 가 가려버려서 진짜 PostgREST 앞에서만 터진다.
      const selectFields = parseSelectFields(href);
      return jsonResponse(filtered.map((row) => projectFields(row, selectFields)));
    }
    return jsonResponse({ error: "unexpected path" }, 404);
  }) as typeof fetch;
}

function parseRoleInFilter(href: string): string[] {
  const match = href.match(/role=in\.\(([^)]*)\)/);
  if (!match) throw new Error(`expected role=in.(...) filter in bots request url: ${href}`);
  return decodeURIComponent(match[1])
    .split(",")
    .map((value) => value.replace(/^"|"$/g, ""));
}

function parseSelectFields(href: string): string[] {
  const match = href.match(/[?&]select=([^&]*)/);
  if (!match) throw new Error(`expected a select= projection in request url: ${href}`);
  return decodeURIComponent(match[1]).split(",");
}

function projectFields<T extends Record<string, unknown>>(row: T, fields: string[]): Partial<T> {
  const projected: Partial<T> = {};
  for (const field of fields) {
    if (field in row) projected[field as keyof T] = row[field as keyof T];
  }
  return projected;
}

function actor(actor_id: string, role: string, adapter_type: string, status = "active"): ActorFixture {
  return { actor_id, role, adapter_type, status };
}

function bot(telegram_bot_id: string, bot_username: string, role: string, webhook_secret_ref: string): BotFixture {
  return { telegram_bot_id, bot_username, role, webhook_secret_ref, status: "active" };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
