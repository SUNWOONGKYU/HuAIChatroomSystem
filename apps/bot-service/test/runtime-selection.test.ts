import assert from "node:assert/strict";
import test from "node:test";
import { buildBotServiceRuntimeFromEnv, buildExecutionDefaultsForRoom } from "../src/local-runtime.js";
import { type LoadedSupabaseRoom } from "../src/supabase-runtime-loader.js";

test("uses local runtime when Supabase env is absent", () => {
  const runtime = buildBotServiceRuntimeFromEnv(baseEnv());

  assert.equal(runtime.storeKind, "local");
});

test("uses Supabase runtime when required Supabase env is present", () => {
  const runtime = buildBotServiceRuntimeFromEnv({
    ...baseEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010"
  });

  assert.equal(runtime.storeKind, "supabase");
  assert.equal(typeof runtime.outboxStore?.leasePending, "function");
});


test("fails loudly when Supabase env is partially configured", () => {
  assert.throws(
    () => buildBotServiceRuntimeFromEnv({
      ...baseEnv(),
      SUPABASE_URL: "https://example.supabase.co"
    }),
    /missing-env:SUPABASE_SERVICE_ROLE_KEY/
  );
});
// A-4: 방 하나의 실행 기본값은 그 방 자신의 actor/gateway 데이터에서만 나와야 한다.
// 두 방이 서로 다른 actor/gateway/project path 를 가지면 결과도 서로 달라야 한다 —
// 안 그러면 "고객 A 방이 고객 B 폴더에서 작업한다" 는 사고가 조용히 일어난다.
test("derives distinct execution defaults per room from that room's own actors and gateways", () => {
  const roomA = room({
    roomId: "room-a",
    telegramChatId: "1001",
    actorId: "actor-a",
    gatewayId: "gateway-a",
    projectRoot: "C:/Dev/RoomA"
  });
  const roomB = room({
    roomId: "room-b",
    telegramChatId: "1002",
    actorId: "actor-b",
    gatewayId: "gateway-b",
    projectRoot: "C:/Dev/RoomB"
  });

  const defaultsA = buildExecutionDefaultsForRoom({ BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader" }, roomA);
  const defaultsB = buildExecutionDefaultsForRoom({ BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader" }, roomB);

  assert.equal(defaultsA?.roomId, "room-a");
  assert.equal(defaultsA?.actorId, "actor-a");
  assert.equal(defaultsA?.gatewayId, "gateway-a");
  assert.equal(defaultsA?.projectPath, "C:/Dev/RoomA");

  assert.equal(defaultsB?.roomId, "room-b");
  assert.equal(defaultsB?.actorId, "actor-b");
  assert.equal(defaultsB?.gatewayId, "gateway-b");
  assert.equal(defaultsB?.projectPath, "C:/Dev/RoomB");
});

// A-5: 이 방에 설정된 role(BOT_SERVICE_EXECUTION_ACTOR_ROLE)의 actor 가 없으면
// 예전에는 던져서 부팅 전체를 죽였다. 이제는 undefined 를 돌려주고 그 방만
// 실행 기본값(리더 자동 판단) 없이 동작한다 — 예외를 던지지 않는다는 것 자체가
// 이 테스트의 핵심 단언이다.
test("returns undefined instead of throwing when the configured actor role is missing from the room", () => {
  const roomWithoutCodexLeader = room({
    roomId: "room-c",
    telegramChatId: "1003",
    actorId: "actor-c",
    gatewayId: "gateway-c",
    projectRoot: "C:/Dev/RoomC",
    actorRole: "claude_leader"
  });

  assert.doesNotThrow(() => {
    const defaults = buildExecutionDefaultsForRoom({ BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader" }, roomWithoutCodexLeader);
    assert.equal(defaults, undefined);
  });
});

// A-4: DB 게이트웨이가 있으면 env 오버라이드보다 DB 값이 우선한다(격하된 기본값).
// 이게 뒤집히면 모든 방이 env 에 설정된 같은 게이트웨이·같은 폴더로 몰린다.
test("prefers this room's own DB gateway over the global env override when both are present", () => {
  const roomWithGateway = room({
    roomId: "room-d",
    telegramChatId: "1004",
    actorId: "actor-d",
    gatewayId: "gateway-d",
    projectRoot: "C:/Dev/RoomD"
  });

  const defaults = buildExecutionDefaultsForRoom({
    BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader",
    BOT_SERVICE_EXECUTION_GATEWAY_ID: "env-gateway",
    BOT_SERVICE_EXECUTION_PROJECT_PATH: "C:/Env/Override"
  }, roomWithGateway);

  assert.equal(defaults?.gatewayId, "gateway-d");
  assert.equal(defaults?.projectPath, "C:/Dev/RoomD");
});

// A-4: 이 방에 DB 게이트웨이 데이터가 아예 없으면(시딩 전 등) env 오버라이드를
// 기본값으로 쓴다 — 완전히 제거하지 않고 "DB 에 값이 없을 때만 쓰는 기본값" 으로
// 격하한 설계의 반대쪽 절반이다.
test("falls back to the env override only when this room has no DB gateway at all", () => {
  const roomWithoutGateway: LoadedSupabaseRoom = {
    roomId: "room-e",
    telegramChatId: "1005",
    authorization: { memberships: [] },
    actors: [{ actorId: "actor-e", role: "codex_leader", adapterType: "codex", status: "active" }],
    gateways: []
  };

  const defaults = buildExecutionDefaultsForRoom({
    BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader",
    BOT_SERVICE_EXECUTION_GATEWAY_ID: "env-gateway",
    BOT_SERVICE_EXECUTION_PROJECT_PATH: "C:/Env/Override"
  }, roomWithoutGateway);

  assert.equal(defaults?.gatewayId, "env-gateway");
  assert.equal(defaults?.projectPath, "C:/Env/Override");
});

function room(input: {
  roomId: string;
  telegramChatId: string;
  actorId: string;
  gatewayId: string;
  projectRoot: string;
  actorRole?: "leader" | "claude_leader" | "codex_leader" | "auditor";
}): LoadedSupabaseRoom {
  return {
    roomId: input.roomId,
    telegramChatId: input.telegramChatId,
    authorization: { memberships: [] },
    actors: [{
      actorId: input.actorId,
      role: input.actorRole ?? "codex_leader",
      adapterType: "codex",
      status: "active"
    }],
    gateways: [{
      gatewayId: input.gatewayId,
      status: "online",
      allowedProjectRoots: [input.projectRoot],
      allowedAdapters: ["codex", "claude_code"]
    }]
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BOT_SERVICE_ALLOWED_CHAT_IDS: "1001",
    BOT_SERVICE_LEADER_BOT_USERNAME: "leader_bot",
    BOT_SERVICE_LEADER_BOT_ID: "00000000-0000-0000-0000-000000000001",
    BOT_SERVICE_LEADER_WEBHOOK_SECRET: "leader-secret",
    BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_bot",
    BOT_SERVICE_CLAUDE_BOT_ID: "00000000-0000-0000-0000-000000000002",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "claude-secret",
    BOT_SERVICE_CODEX_BOT_USERNAME: "codex_bot",
    BOT_SERVICE_CODEX_BOT_ID: "00000000-0000-0000-0000-000000000003",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "codex-secret",
    BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_bot",
    BOT_SERVICE_AUDITOR_BOT_ID: "00000000-0000-0000-0000-000000000004",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "auditor-secret"
  };
}
