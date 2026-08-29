import assert from "node:assert/strict";
import test from "node:test";
import { buildBotServiceRuntimeFromEnvAsync } from "../src/local-runtime.js";
import { loadSupabaseBotServiceRuntimeConfig } from "../src/supabase-runtime-loader.js";
import { makeTelegramUpdateIdempotencyKey } from "../src/index.js";
import { TelegramUpdateEnvelope, type TelegramInboundQueueMessage } from "../../../packages/contracts/src/index.js";

const roomIdA = "00000000-0000-0000-0000-000000000010";
const roomIdB = "00000000-0000-0000-0000-000000000020";
const chatIdA = "1001";
const chatIdB = "1002";
const codexActorIdA = "00000000-0000-0000-0000-000000000103";
const codexActorIdB = "00000000-0000-0000-0000-000000000203";

test("normalizes legacy antigravity actor and gateway values to gemini_web", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([], {
      roomAActors: [actor(roomIdA, "legacy-gemini-actor", "claude_leader", "antigravity")],
      roomAGateways: [{
        room_id: roomIdA,
        gateway_id: "legacy-gemini-gateway",
        status: "online",
        allowed_project_roots: ["C:\\repo"],
        allowed_adapters: ["antigravity", "gemini_web"]
      }]
    })
  });

  const room = loaded.rooms.find((candidate) => candidate.roomId === roomIdA);
  assert.equal(room?.actors[0]?.adapterType, "gemini_web");
  assert.deepEqual(room?.gateways[0]?.allowedAdapters, ["gemini_web", "gemini_web"]);
});

test("loads every active room in one call, not just one", async () => {
  const fetchCalls: string[] = [];
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls)
  });

  assert.equal(loaded.rooms.length, 2);
  assert.deepEqual(new Set(loaded.rooms.map((room) => room.roomId)), new Set([roomIdA, roomIdB]));
  assert.ok(fetchCalls.some((url) => url.includes("/huai_rooms?status=eq.active")));
});

// 아웃박스 리스는 room 조건 없이 전역이다(lease_huai_outbox). 이 목록이 활성 방
// 전체의 합집합이 아니면, 다른 방으로 나갈 메시지가 outbox.ts 의
// allowedChatIds.includes() 판정에서 전부 unauthorized-outbound-chat 으로
// 영구 폐기된다 — 다방 지원에서 가장 치명적인 회귀라 반드시 여기서 잡는다.
test("unions allowedChatIds across every active room (regression guard for outbox dead-lettering)", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([])
  });

  assert.deepEqual(new Set(loaded.config.allowedChatIds), new Set([chatIdA, chatIdB]));
});

test("keeps each room's membership, actors and gateways scoped to that room", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([])
  });

  const roomA = loaded.rooms.find((room) => room.roomId === roomIdA);
  const roomB = loaded.rooms.find((room) => room.roomId === roomIdB);
  assert.ok(roomA && roomB);

  assert.equal(roomA!.authorization.memberships[0]?.telegramUserId, "2001");
  assert.equal(roomB!.authorization.memberships[0]?.telegramUserId, "2002");

  assert.equal(roomA!.actors.find((actor) => actor.role === "codex_leader")?.actorId, codexActorIdA);
  assert.equal(roomB!.actors.find((actor) => actor.role === "codex_leader")?.actorId, codexActorIdB);

  assert.equal(roomA!.gateways[0]?.gatewayId, "gateway-a");
  assert.deepEqual(roomA!.gateways[0]?.allowedProjectRoots, ["C:/Dev/RoomA"]);
  assert.equal(roomB!.gateways[0]?.gatewayId, "gateway-b");
  assert.deepEqual(roomB!.gateways[0]?.allowedProjectRoots, ["C:/Dev/RoomB"]);
});

// 인증은 telegramChatId + telegramUserId 로 매칭되므로(authorizeTelegramInput),
// 전체 방의 멤버십을 평평하게 합쳐도 방을 잘못 넘나들 수 없다. 합치는 과정에서
// 한쪽 방의 멤버가 사라지지 않는지 확인한다.
test("flattens authorization memberships from every room without losing any", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([])
  });

  const userIds = new Set(loaded.authorization.memberships.map((member) => member.telegramUserId));
  assert.deepEqual(userIds, new Set(["2001", "2002"]));
});

// 봇은 room 과 무관한 공용 계정이다. 방이 몇 개든 telegram_bot_id·webhook secret 은
// 하나만 잡혀야 한다 — 방마다 중복 등록되거나 서로 다른 시크릿으로 갈라지면 안 된다.
test("resolves each bot to a single telegram_bot_id and webhook secret regardless of room count", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([])
  });

  assert.equal(loaded.config.botsByUsername.size, 4);
  assert.equal(loaded.config.botsByUsername.get("codex_bot")?.telegramBotId, "00000000-0000-0000-0000-000000000203-shared");
  assert.equal(loaded.config.botsByUsername.get("codex_bot")?.webhookSecret, "codex-secret");
});

// 방 A 에만 있는 actor role 이라도 봇 조회 범위는 활성 방 전체의 합집합이어야 한다.
// 방 B 에는 auditor actor 가 없어도, 방 A 가 auditor 를 쓰고 있으면 auditor_bot 웹훅은
// 여전히 열려 있어야 한다.
test("unions active actor roles across rooms for the telegram bot lookup", async () => {
  const fetchCalls: string[] = [];
  const roomBActorsWithoutAuditor = [
    actor(roomIdB, "00000000-0000-0000-0000-000000000201", "leader", "orchestrator"),
    actor(roomIdB, "00000000-0000-0000-0000-000000000202", "claude_leader", "claude_code"),
    actor(roomIdB, codexActorIdB, "codex_leader", "codex")
    // auditor 없음
  ];
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls, { roomBActors: roomBActorsWithoutAuditor })
  });

  assert.equal(loaded.config.botsByUsername.has("auditor_bot"), true);
  const botsCall = fetchCalls.find((url) => url.includes("/huai_telegram_bots?"));
  assert.match(botsCall ?? "", /auditor/);
});

// 방 하나의 데이터가 비정상(멤버 0명·게이트웨이 0개)이어도 나머지 방은 정상 로드돼야 한다.
// 20방 규모에서 방 하나의 시딩 미비가 전체 부팅을 막으면 안 된다는 요구를,
// 로더 단계(빈 하위 리소스에 대해 예외를 던지지 않는 것)에서 검증한다.
test("keeps other rooms loading fine when one room has no members or gateways yet", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([], { roomBMembers: [], roomBGateways: [] })
  });

  const roomA = loaded.rooms.find((room) => room.roomId === roomIdA);
  const roomB = loaded.rooms.find((room) => room.roomId === roomIdB);
  assert.equal(roomA?.authorization.memberships.length, 1);
  assert.equal(roomB?.authorization.memberships.length, 0);
  assert.equal(roomB?.gateways.length, 0);
});

test("returns an empty runtime without throwing when no room is active", async () => {
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch([], { activeRooms: [] })
  });

  assert.deepEqual(loaded.rooms, []);
  assert.deepEqual(loaded.config.allowedChatIds, []);
  assert.equal(loaded.config.botsByUsername.size, 0);
});

test("fails when a database webhook secret ref is missing from env", async () => {
  await assert.rejects(
    () => loadSupabaseBotServiceRuntimeConfig({
      url: "https://example.supabase.co",
      serviceRoleKey: "test-service-role-key",
      env: {},
      fetchImpl: fakeRuntimeFetch([])
    }),
    /missing-env:BOT_SERVICE_LEADER_WEBHOOK_SECRET/
  );
});

// 봇은 room 과 무관한 공통 계정(role 하나에 실제 Telegram 봇 계정 하나)이라
// actor_id 로는 못 찾는다. role 기준 조회로 되돌아가지 않으면(예: actor_id=in. 로
// 회귀) 다른 방에서는 봇 조회가 0건이 되어 모든 update 가 unknown-bot 으로 무시된다 —
// 이 회귀를 여기서 잡는다.
test("requests telegram bots by active actor role, never by actor_id", async () => {
  const fetchCalls: string[] = [];
  await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls)
  });

  const botsCall = fetchCalls.find((url) => url.includes("/huai_telegram_bots?"));
  assert.ok(botsCall, "expected a /huai_telegram_bots request");
  assert.match(botsCall, /role=in\.\(/);
  assert.match(botsCall, /status=eq\.active/);
  assert.doesNotMatch(botsCall, /actor_id=in\./);
});

// bots 테이블에 아직 아무 행도 없어도(초기 시딩 전, 혹은 role 이 전부 걸러진 경우)
// 예외 없이 빈 맵으로 진행해야 한다 — routeTelegramUpdate 가 unknown-bot 으로
// 처리할 수 있도록.
test("resolves to an empty bot map without throwing when the bots table has no matching rows", async () => {
  const fetchCalls: string[] = [];
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls, { bots: [] })
  });

  assert.equal(loaded.config.botsByUsername.size, 0);
  assert.ok(fetchCalls.some((url) => url.includes("/huai_telegram_bots?")));
});

// 활성 방 전체에 active actor 가 하나도 없으면 role 집합이 비므로, 애초에
// huai_telegram_bots 조회를 나가지 않는 조기 반환 경로(roles.length === 0)를 탄다.
test("skips the telegram bots lookup entirely when no room has an active actor", async () => {
  const fetchCalls: string[] = [];
  const allInactive = (roomId: string, ids: [string, string, string, string]) => [
    actor(roomId, ids[0], "leader", "orchestrator", "inactive"),
    actor(roomId, ids[1], "claude_leader", "claude_code", "disabled"),
    actor(roomId, ids[2], "codex_leader", "codex", "inactive"),
    actor(roomId, ids[3], "auditor", "auditor", "disabled")
  ];
  const loaded = await loadSupabaseBotServiceRuntimeConfig({
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    env: secretEnv(),
    fetchImpl: fakeRuntimeFetch(fetchCalls, {
      roomAActors: allInactive(roomIdA, [
        "00000000-0000-0000-0000-000000000101",
        "00000000-0000-0000-0000-000000000102",
        codexActorIdA,
        "00000000-0000-0000-0000-000000000104"
      ]),
      roomBActors: allInactive(roomIdB, [
        "00000000-0000-0000-0000-000000000201",
        "00000000-0000-0000-0000-000000000202",
        codexActorIdB,
        "00000000-0000-0000-0000-000000000204"
      ])
    })
  });

  assert.equal(loaded.config.botsByUsername.size, 0);
  assert.equal(fetchCalls.some((url) => url.includes("/huai_telegram_bots?")), false);
});

// 서버 부팅 경로(buildBotServiceRuntimeFromEnvAsync)도 다방을 로드해야 한다.
// 이 경로는 telegram_chat_id 하나로 방 하나만 골라 로드하던 예전 계약을
// 더 이상 쓰지 않는다 — Supabase env 만 있으면 활성 방 전체를 로드한다.
test("boots the async server runtime with every active room, not a single selected one", async () => {
  const runtime = await buildBotServiceRuntimeFromEnvAsync({
    ...secretEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
  }, { fetchImpl: fakeRuntimeFetch([]) });

  assert.equal(runtime.storeKind, "supabase");
  assert.deepEqual(new Set(runtime.config.allowedChatIds), new Set([chatIdA, chatIdB]));
  assert.equal(runtime.config.botsByUsername.get("leader_bot")?.botRole, "leader");

  const queued = await runtime.processQueuedInputs();
  assert.deepEqual(queued, []);
});

// 방 A 의 chat_id 로 온 메시지와 방 B 의 chat_id 로 온 메시지가 각각 큐를 거쳐
// 끝까지 드레인되는지 확인한다(다방 드레인 파이프라인이 방을 섞다가 죽지 않는다는
// 스모크 테스트). "어느 방의 실행 기본값이 실제로 선택됐는가"의 정밀한 회귀 방지는
// runtime-selection.test.ts 의 buildExecutionDefaultsForRoom 단위 테스트가 맡는다 —
// 여기서 관측 발화(kind: "observation")를 쓰는 이유는 실행 기본값을 orchestrator 가
// 소비하지 않는 경로라 persistence 계층(실제 SupabaseBotServiceStore)의 이벤트/아웃박스
// 하이드레이션 네트워크 호출을 끌어들이지 않고도 드레인 경로 자체를 안전하게 왕복시킬
// 수 있기 때문이다.
test("drains queued messages from multiple rooms without one room's processing breaking another", async () => {
  const fetchCalls: string[] = [];
  const runtime = await buildBotServiceRuntimeFromEnvAsync({
    ...secretEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader"
  }, { fetchImpl: fakeRuntimeFetch(fetchCalls) });

  await runtime.webhookPorts.inboundQueue.enqueue(observationQueueItem(chatIdA, "2001"));
  await runtime.webhookPorts.inboundQueue.enqueue(observationQueueItem(chatIdB, "2002"));

  const processed = await runtime.processQueuedInputs();
  assert.equal(processed.length, 2);
});

// 이 방(B)에 codex_leader actor 가 없으면(A-5 회귀 차단), 그 방만 실행 기본값 없이
// 규칙 기반 경로로 떨어지고 방 A 는 정상적으로 실행 기본값을 받는다 — 프로세스 전체가
// 죽지 않는다.
test("keeps room A's execution defaults intact when room B is missing the configured actor role", async () => {
  const roomBActorsWithoutCodex = [
    actor(roomIdB, "00000000-0000-0000-0000-000000000201", "leader", "orchestrator"),
    actor(roomIdB, "00000000-0000-0000-0000-000000000202", "claude_leader", "claude_code")
    // codex_leader 없음 -> missing-runtime-actor
  ];
  const runtime = await buildBotServiceRuntimeFromEnvAsync({
    ...secretEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader"
  }, { fetchImpl: fakeRuntimeFetch([], { roomBActors: roomBActorsWithoutCodex }) });

  // 프로세스가 죽지 않고 부팅됐다는 것 자체가 A-5 의 핵심 단언이다.
  assert.equal(runtime.storeKind, "supabase");
  assert.deepEqual(new Set(runtime.config.allowedChatIds), new Set([chatIdA, chatIdB]));
});

// Delta 분대가 orchestrator 를 고쳐(내 지적 2 의 Q3 후속) executionDefaults 없는 방의
// 승인이 더 이상 예외를 던지지 않고 "이 방은 아직 실행 준비가 되지 않았습니다" 안내를
// accepted:true 로 돌려주도록 바뀌었다. 그 결과 방 B 의 /approve 는 이제 실패가 아니라
// 정상 처리(processed)다 — 다만 실행 대신 안내만 나간다. "처리됐다"만 확인하면 조용히
// 아무 것도 안 보낸 것과 구분이 안 되므로, 실제로 안내 텍스트가 huai_outbox 로 나갔는지
// 까지 확인한다. 핵심 취지(방 B 때문에 방 A 메시지가 유실되지 않는다)는 그대로 유지한다.
test("a room approval command sends a visible operations-center notice without losing a sibling room's message", async () => {
  const roomBActorsWithoutCodex = [
    actor(roomIdB, "00000000-0000-0000-0000-000000000201", "leader", "orchestrator"),
    actor(roomIdB, "00000000-0000-0000-0000-000000000202", "claude_leader", "claude_code")
    // codex_leader 없음 -> executionDefaults 는 undefined 로 뜬다(A-5).
  ];
  const telegramUpdatePatches: Array<Record<string, unknown>> = [];
  const outboxInserts: Array<Record<string, unknown>> = [];
  const runtime = await buildBotServiceRuntimeFromEnvAsync({
    ...secretEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader"
  }, { fetchImpl: fakeRuntimeFetch([], { roomBActors: roomBActorsWithoutCodex, telegramUpdatePatches, outboxInserts }) });

  // 방 B(실행 기본값 없음)의 승인 명령을 먼저 큐에 넣고, 방 A(정상)의 관측 메시지를
  // 그 뒤에 줄 세운다.
  await runtime.webhookPorts.inboundQueue.enqueue(approveCommandQueueItem(chatIdB, "2002", "task-x"));
  await runtime.webhookPorts.inboundQueue.enqueue(observationQueueItem(chatIdA, "2001"));

  const processed = await runtime.processQueuedInputs();
  assert.equal(processed.length, 2, "both messages must be drained");

  assert.equal(telegramUpdatePatches.length, 2);
  const [roomBOutcome, roomAOutcome] = telegramUpdatePatches;
  assert.equal(roomBOutcome?.status, "processed", "room B's approval is handled normally now — no exception, no crash");
  assert.equal(roomAOutcome?.status, "processed", "room A's message must still complete regardless of room B's outcome");

  const noticeTexts = outboxInserts.map((row) => (row.payload as { text?: string } | undefined)?.text ?? "");
  assert.ok(
    noticeTexts.some((text) => text.includes("협업 운영센터에서만 처리합니다")),
    "room B must receive the operations-center notice"
  );
});

// processQueuedInputs 의 드레인 for 루프가 메시지 단위로 예외를 잡지 않으면, 한
// 메시지의 실패가 루프 전체를 멈추고 — 이미 큐에서 빠져나온(drained) 뒤쪽 메시지,
// 즉 방 B 뒤에 줄 서 있던 방 A 의 메시지까지 재시도 없이 통째로 유실된다. 방 하나의
// 실패가 다른 방을 끌고 죽으면 A-5 의 격리 목적 자체가 무너지므로, 이 테스트는 그
// 경계를 정확히 찌른다.
//
// 실패 트리거로는 huai_events insert 네트워크 장애를 주입한다(missing-execution-
// defaults 같은 orchestrator 비즈니스 예외가 아니라). 처음엔 후자를 썼는데, Delta
// 분대가 orchestrator 를 고쳐 missing-execution-defaults 가 더 이상 던지지 않고
// "실행 준비 안 됨" 안내로 정상 처리되게 바뀌면서, 그 조건에 기댄 버전은 통과는
// 했지만 실은 이 테스트 파일에 없던 /huai_events 스텁이 404 를 내서 우연히 실패
// 상태가 된 것뿐이었다(가짜 초록불) — orchestrator 비즈니스 규칙이 바뀔 때마다
// 같이 깨지거나 조용히 의미를 잃는 회귀 테스트였던 셈이다. 네트워크 장애는 orchestrator
// 규칙과 무관하게 항상 유효한 실패 원인이라 이걸로 바꿨다.
test("a network failure processing one room's message does not swallow a sibling room's message", async () => {
  const telegramUpdatePatches: Array<Record<string, unknown>> = [];
  const runtime = await buildBotServiceRuntimeFromEnvAsync({
    ...secretEnv(),
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    BOT_SERVICE_EXECUTION_ACTOR_ROLE: "codex_leader"
  }, { fetchImpl: fakeRuntimeFetch([], { failEventsInsertForRoomId: roomIdB, telegramUpdatePatches }) });

  // 방 B(huai_events insert 가 장애나는 방)의 승인 명령을 먼저 큐에 넣고, 방 A(정상)의
  // 관측 메시지를 그 뒤에 줄 세운다 — 배치 중단 버그가 있었다면 방 A 는 절대 처리되지 못한다.
  await runtime.webhookPorts.inboundQueue.enqueue(newTaskCommandQueueItem(chatIdB, "2002", "task-x"));
  await runtime.webhookPorts.inboundQueue.enqueue(observationQueueItem(chatIdA, "2001"));

  const processed = await runtime.processQueuedInputs();
  assert.equal(processed.length, 2, "both messages must be drained even though the first one throws internally");

  assert.equal(telegramUpdatePatches.length, 2, "both messages must reach a terminal PATCH (failed or processed)");
  const [roomBOutcome, roomAOutcome] = telegramUpdatePatches;
  assert.equal(roomBOutcome?.status, "failed", "room B's poison message must be marked failed, not silently dropped");
  assert.equal(roomAOutcome?.status, "processed", "room A's message must still complete even though it was queued behind room B's failure");
});

// 사람끼리의 대화(kind: "observation")를 만든다. orchestrator 가 이 kind 를
// 이벤트/아웃박스 없이 즉시 통과시키므로(handleTelegramInput), persistence 계층이
// commitTelegramInputResult 에서 실제로 만드는 네트워크 호출은
// resolveRoomIdByChatId(방 조회) 와 markTelegramUpdateProcessed 뿐이다 — 이벤트/아웃박스가
// 비어 있으면 huai_events·huai_outbox 하이드레이션 단계는 전부 조기 반환한다. 그래서 이
// 파일의 fakeRuntimeFetch 에 그 하이드레이션 전체를 갖추지 않고도 드레인 파이프라인을
// 안전하게 왕복시킬 수 있다.
function newTaskCommandQueueItem(chatId: string, telegramUserId: string, taskText: string): TelegramInboundQueueMessage {
  const envelope = TelegramUpdateEnvelope.parse(
    "00000000-0000-0000-0000-000000000201-shared",
    "leader_bot",
    "leader",
    {
      update_id: Number(`${chatId}2`),
      message: {
        message_id: 2,
        chat: { id: Number(chatId) },
        from: { id: Number(telegramUserId), is_bot: false, username: "owner" },
        text: `/newtask ${taskText}`
      }
    }
  );
  return {
    input: { kind: "command", envelope, command: { name: "/newtask", args: [taskText] } },
    idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope),
    receivedAt: new Date().toISOString()
  };
}

function approveCommandQueueItem(chatId: string, telegramUserId: string, taskId: string): TelegramInboundQueueMessage {
  const envelope = TelegramUpdateEnvelope.parse(
    "00000000-0000-0000-0000-000000000201-shared",
    "leader_bot",
    "leader",
    {
      update_id: Number(`${chatId}2`),
      message: {
        message_id: 2,
        chat: { id: Number(chatId) },
        from: { id: Number(telegramUserId), is_bot: false, username: "owner" },
        text: `/approve ${taskId}`
      }
    }
  );
  return {
    input: { kind: "command", envelope, command: { name: "/approve", args: [taskId] } },
    idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope),
    receivedAt: new Date().toISOString()
  };
}

function observationQueueItem(chatId: string, telegramUserId: string): TelegramInboundQueueMessage {
  const envelope = TelegramUpdateEnvelope.parse(
    "00000000-0000-0000-0000-000000000201-shared",
    "leader_bot",
    "leader",
    {
      update_id: Number(`${chatId}1`),
      message: {
        message_id: 1,
        chat: { id: Number(chatId) },
        from: { id: Number(telegramUserId), is_bot: false, username: "member" },
        text: "그냥 하는 얘기예요"
      }
    }
  );
  return {
    input: { kind: "observation", envelope },
    idempotencyKey: makeTelegramUpdateIdempotencyKey(envelope),
    receivedAt: new Date().toISOString()
  };
}

function secretEnv(): NodeJS.ProcessEnv {
  return {
    BOT_SERVICE_LEADER_WEBHOOK_SECRET: "leader-secret",
    BOT_SERVICE_CLAUDE_WEBHOOK_SECRET: "claude-secret",
    BOT_SERVICE_CODEX_WEBHOOK_SECRET: "codex-secret",
    BOT_SERVICE_AUDITOR_WEBHOOK_SECRET: "auditor-secret"
  };
}

type RoomFixture = { room_id: string; telegram_chat_id: string; status: string };
type MemberFixture = { room_id: string; telegram_user_id: string; role: string; permissions: string[]; status: string };
type ActorFixture = { room_id: string; actor_id: string; role: string; adapter_type: string; status: string };
type GatewayFixture = {
  room_id: string;
  gateway_id: string;
  status: string;
  allowed_project_roots: string[];
  allowed_adapters: string[];
};
type BotFixture = { telegram_bot_id: string; bot_username: string; role: string; webhook_secret_ref: string; status: string };

function defaultRooms(): RoomFixture[] {
  return [
    { room_id: roomIdA, telegram_chat_id: chatIdA, status: "active" },
    { room_id: roomIdB, telegram_chat_id: chatIdB, status: "active" }
  ];
}

function defaultMembers(roomId: string, telegramUserId: string): MemberFixture[] {
  return [{ room_id: roomId, telegram_user_id: telegramUserId, role: "owner", permissions: ["task:create", "task:read"], status: "active" }];
}

function defaultActors(roomId: string, ids: { leader: string; claude: string; codex: string; auditor: string }): ActorFixture[] {
  return [
    actor(roomId, ids.leader, "leader", "orchestrator"),
    actor(roomId, ids.claude, "claude_leader", "claude_code"),
    actor(roomId, ids.codex, "codex_leader", "codex"),
    actor(roomId, ids.auditor, "auditor", "auditor")
  ];
}

function defaultGateway(roomId: string, gatewayId: string, projectRoot: string): GatewayFixture[] {
  return [{
    room_id: roomId,
    gateway_id: gatewayId,
    status: "online",
    allowed_project_roots: [projectRoot],
    allowed_adapters: ["codex", "claude_code"]
  }];
}

// 봇은 room 과 무관한 공용 계정이라, 두 방이 같은 role 을 써도 telegram_bot_id 와
// webhook secret 은 하나로 수렴해야 한다(방마다 별개 행이 아니다).
function defaultBots(): BotFixture[] {
  return [
    bot("00000000-0000-0000-0000-000000000201-shared", "leader_bot", "leader", "env:BOT_SERVICE_LEADER_WEBHOOK_SECRET"),
    bot("00000000-0000-0000-0000-000000000202-shared", "claude_bot", "claude_leader", "env:BOT_SERVICE_CLAUDE_WEBHOOK_SECRET"),
    bot("00000000-0000-0000-0000-000000000203-shared", "codex_bot", "codex_leader", "env:BOT_SERVICE_CODEX_WEBHOOK_SECRET"),
    bot("00000000-0000-0000-0000-000000000204-shared", "auditor_bot", "auditor", "env:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET")
  ];
}

function fakeRuntimeFetch(
  calls: string[],
  overrides: {
    activeRooms?: RoomFixture[];
    roomAMembers?: MemberFixture[];
    roomBMembers?: MemberFixture[];
    roomAActors?: ActorFixture[];
    roomBActors?: ActorFixture[];
    roomAGateways?: GatewayFixture[];
    roomBGateways?: GatewayFixture[];
    bots?: BotFixture[];
    // markTelegramUpdateProcessed/markTelegramUpdateFailed 가 실제로 친 PATCH 바디를
    // 그대로 밀어 넣는다 — "메시지가 성공/실패 어느 쪽으로 마감됐는가"를 테스트에서
    // 직접 관측하기 위한 훅.
    telegramUpdatePatches?: Array<Record<string, unknown>>;
    // 특정 방(room_id)에서 온 이벤트만 huai_events insert 를 실패시킨다 — 진짜 네트워크
    // 장애를 흉내내서, 배치 격리가 orchestrator 의 특정 비즈니스 예외(missing-execution-
    // defaults 등, 나중에 바뀔 수 있다)에 우연히 기대지 않고 "어떤 이유로든 한 메시지가
    // 실패해도 나머지는 계속된다"를 증명하게 한다.
    failEventsInsertForRoomId?: string;
    // insertOutboxRowsIdempotently 가 실제로 POST 한 huai_outbox 행을 그대로 밀어 넣는다.
    // "처리됐다(processed)"만으로는 조용히 아무 것도 안 보낸 것과 구분이 안 되므로,
    // 실제로 어떤 텍스트가 나갔는지 테스트에서 직접 확인하기 위한 훅이다.
    outboxInserts?: Array<Record<string, unknown>>;
  } = {}
): typeof fetch {
  const rooms = overrides.activeRooms ?? defaultRooms();
  const members = [
    ...(overrides.roomAMembers ?? defaultMembers(roomIdA, "2001")),
    ...(overrides.roomBMembers ?? defaultMembers(roomIdB, "2002"))
  ];
  const actors = [
    ...(overrides.roomAActors ?? defaultActors(roomIdA, {
      leader: "00000000-0000-0000-0000-000000000101",
      claude: "00000000-0000-0000-0000-000000000102",
      codex: codexActorIdA,
      auditor: "00000000-0000-0000-0000-000000000104"
    })),
    ...(overrides.roomBActors ?? defaultActors(roomIdB, {
      leader: "00000000-0000-0000-0000-000000000201",
      claude: "00000000-0000-0000-0000-000000000202",
      codex: codexActorIdB,
      auditor: "00000000-0000-0000-0000-000000000204"
    }))
  ];
  const gateways = [
    ...(overrides.roomAGateways ?? defaultGateway(roomIdA, "gateway-a", "C:/Dev/RoomA")),
    ...(overrides.roomBGateways ?? defaultGateway(roomIdB, "gateway-b", "C:/Dev/RoomB"))
  ];
  const botRows = overrides.bots ?? defaultBots();
  const telegramUpdatePatches = overrides.telegramUpdatePatches;

  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);

    if (href.includes("/huai_rooms?")) {
      // 두 가지 호출자가 이 엔드포인트를 쓴다:
      //  1) 이 파일의 로더 — 활성 방 전체를 status=eq.active 로 나열한다.
      //  2) SupabaseBotServiceStore.resolveRoomIdByChatId — commitTelegramInputResult 가
      //     이벤트를 room_id 에 묶기 위해 telegram_chat_id 로 방 하나를 되찾는다
      //     (다방에서 store 가 room 고정이 아니게 된 이후의 설계).
      if (href.includes("telegram_chat_id=eq.")) {
        const match = href.match(/telegram_chat_id=eq\.([^&]*)/);
        const chatId = match ? decodeURIComponent(match[1]) : undefined;
        const room = rooms.find((candidate) => candidate.telegram_chat_id === chatId);
        return jsonResponse(room ? [{ room_id: room.room_id }] : []);
      }
      assert.match(href, /status=eq\.active/, "active-room listing must filter by status=eq.active, not a single room_id");
      return jsonResponse(rooms);
    }

    if (href.includes("/huai_room_members?")) {
      const roomIds = parseRoomIdInFilter(href);
      const selectFields = parseSelectFields(href);
      return jsonResponse(members.filter((row) => roomIds.includes(row.room_id)).map((row) => projectFields(row, selectFields)));
    }

    if (href.includes("/huai_ai_actors?")) {
      const roomIds = parseRoomIdInFilter(href);
      const selectFields = parseSelectFields(href);
      return jsonResponse(actors.filter((row) => roomIds.includes(row.room_id)).map((row) => projectFields(row, selectFields)));
    }

    if (href.includes("/huai_gateway_instances?")) {
      const roomIds = parseRoomIdInFilter(href);
      const selectFields = parseSelectFields(href);
      return jsonResponse(gateways.filter((row) => roomIds.includes(row.room_id)).map((row) => projectFields(row, selectFields)));
    }

    if (href.includes("/huai_telegram_updates")) {
      // markTelegramUpdateProcessed/markTelegramUpdateFailed 가 PATCH 로 치는 곳.
      // 이 파일의 관측(observation) 큐 아이템들은 이벤트/아웃박스를 만들지 않으므로
      // 정상 케이스에선 이 호출이 유일한 후속 네트워크 왕복이다.
      if (init?.body && telegramUpdatePatches) {
        telegramUpdatePatches.push(JSON.parse(String(init.body)));
      }
      return jsonResponse({}, 200);
    }

    if (href.includes("/huai_events")) {
      const body = JSON.parse(String(init?.body ?? "[]")) as Array<{ room_id: string }>;
      if (overrides.failEventsInsertForRoomId && body.some((row) => row.room_id === overrides.failEventsInsertForRoomId)) {
        return jsonResponse({ error: "simulated-network-failure" }, 500);
      }
      return jsonResponse(body.map((row, index) => ({ ...row, event_id: `event-${index}`, created_at: new Date().toISOString() })));
    }

    if (href.includes("/huai_approvals")) {
      // recordApprovals 가 owner_task_approved 등 승인성 이벤트에서 치는 곳.
      // 이 파일의 테스트들은 승인 원장 자체를 검증하지 않으므로 항상 성공시킨다.
      return jsonResponse({}, 200);
    }

    if (href.includes("/huai_outbox")) {
      const body = JSON.parse(String(init?.body ?? "[]")) as Array<Record<string, unknown>>;
      overrides.outboxInserts?.push(...body);
      return jsonResponse(body.map((row, index) => ({
        huai_outbox_id: `outbox-${index}`,
        status: "pending",
        attempts: 0,
        created_at: new Date().toISOString(),
        ...row
      })));
    }

    if (href.includes("/huai_telegram_bots?")) {
      // 실제 PostgREST 처럼 role=in.(...)&status=eq.active 쿼리를 그대로 적용해서
      // 걸러준다. 코드가 actor_id=in. 로 되돌아가면 여기서 role 필터를 못 찾아
      // 예외를 던진다(그 자체가 회귀 신호).
      const requestedRoles = parseRoleInFilter(href);
      const filtered = botRows.filter(
        (row) => row.status === "active" && requestedRoles.includes(row.role)
      );
      const selectFields = parseSelectFields(href);
      return jsonResponse(filtered.map((row) => projectFields(row, selectFields)));
    }

    return jsonResponse({ error: "unexpected path" }, 404);
  }) as typeof fetch;
}

function parseRoomIdInFilter(href: string): string[] {
  const match = href.match(/room_id=in\.\(([^)]*)\)/);
  if (!match) throw new Error(`expected room_id=in.(...) filter in request url: ${href}`);
  return decodeURIComponent(match[1])
    .split(",")
    .map((value) => value.replace(/^"|"$/g, ""));
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

function actor(room_id: string, actor_id: string, role: string, adapter_type: string, status = "active"): ActorFixture {
  return { room_id, actor_id, role, adapter_type, status };
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
