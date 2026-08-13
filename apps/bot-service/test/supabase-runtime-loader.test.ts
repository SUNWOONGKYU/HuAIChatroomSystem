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

function secretEnv(): NodeJS.ProcessEnv {
  return {
    BOT_SERVICE_PLATOON_WEBHOOK_SECRET: "platoon-secret",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "claude-secret",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "codex-secret",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "auditor-secret"
  };
}

function fakeRuntimeFetch(calls: string[]): typeof fetch {
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
      return jsonResponse([
        actor("00000000-0000-0000-0000-000000000101", "platoon_leader", "orchestrator"),
        actor("00000000-0000-0000-0000-000000000102", "claude_leader", "claude_code"),
        actor(codexActorId, "codex_leader", "codex"),
        actor("00000000-0000-0000-0000-000000000104", "auditor", "auditor")
      ]);
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
      return jsonResponse([
        bot("00000000-0000-0000-0000-000000000201", "platoon_bot", "00000000-0000-0000-0000-000000000101", "env:BOT_SERVICE_PLATOON_WEBHOOK_SECRET"),
        bot("00000000-0000-0000-0000-000000000202", "claude_bot", "00000000-0000-0000-0000-000000000102", "env:BOT_SERVICE_CLAUDE_WEBHOOK_SECRET"),
        bot("00000000-0000-0000-0000-000000000203", "codex_bot", codexActorId, "env:BOT_SERVICE_CODEX_WEBHOOK_SECRET"),
        bot("00000000-0000-0000-0000-000000000204", "auditor_bot", "00000000-0000-0000-0000-000000000104", "env:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET")
      ]);
    }
    return jsonResponse({ error: "unexpected path" }, 404);
  }) as typeof fetch;
}

function actor(actor_id: string, role: string, adapter_type: string) {
  return { actor_id, role, adapter_type, status: "active" };
}

function bot(telegram_bot_id: string, bot_username: string, actor_id: string, webhook_secret_ref: string) {
  return { telegram_bot_id, bot_username, actor_id, webhook_secret_ref, status: "active" };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
