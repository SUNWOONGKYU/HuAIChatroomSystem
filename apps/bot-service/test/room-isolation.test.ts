// 다방 지원 회귀 테스트. supabase-store.ts 가 프로세스 1개로 여러 방을 처리하도록 바뀌었다 —
// chat_id 로 room_id 를 해석하고, 그 room 소유가 아닌 데이터는 새어 나가면 안 된다.
// MiniSupabaseFake 는 URL 의 필터를 실제로 파싱해 적용하므로, 프로덕션 코드에서 room_id
// 필터를 빼면 이 테스트들은 진짜로 빨간불이 된다 (큐잉 방식 목업으로는 증명 불가능한 부분).
import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";
import { MiniSupabaseFake } from "./mini-supabase-fake.js";

const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_A = "1001";
const CHAT_B = "2002";

function makeStore(fake: MiniSupabaseFake, miniAppDirectLinkBaseUrl?: string): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: fake.fetchImpl,
    miniAppDirectLinkBaseUrl
  });
}

function envelope(chatId: string, updateId: string, text: string | undefined): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", updateId, chatId, "10", "9001", false, text, undefined);
}

function seedTwoRooms(fake: MiniSupabaseFake): void {
  fake.seed("huai_rooms", [
    { room_id: ROOM_A, telegram_chat_id: CHAT_A },
    { room_id: ROOM_B, telegram_chat_id: CHAT_B }
  ]);
}

function commandCommit(chatId: string, updateId: string, commandName: string, args: string[], outboxPayload: Record<string, unknown>, idempotencyKey: string) {
  return {
    message: {
      input: {
        kind: "command" as const,
        envelope: envelope(chatId, updateId, commandName + " " + args.join(" ")),
        command: { name: commandName as never, args }
      },
      idempotencyKey: "telegram-update:bot:" + updateId,
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{ target: { kind: "telegram_bot" as const, botRole: "platoon_leader" as const, telegramChatId: chatId }, idempotencyKey, payload: outboxPayload }]
    }
  };
}

test("서로 다른 chat_id 로 커밋하면 각각 다른 room_id 로 이벤트가 기록된다", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  const store = makeStore(fake);

  const commitFor = (chatId: string, updateId: string) => ({
    message: {
      input: { kind: "message" as const, envelope: envelope(chatId, updateId, "안녕") },
      idempotencyKey: "telegram-update:bot:" + updateId,
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [{ eventType: "proposal_created" as const, idempotencyKey: "evt:" + updateId, payload: { proposalId: "test-" + updateId } }],
      outbox: []
    }
  });

  await store.commitTelegramInputResult(commitFor(CHAT_A, "1"));
  await store.commitTelegramInputResult(commitFor(CHAT_B, "2"));

  const events = fake.tables["huai_events"] ?? [];
  assert.equal(events.length, 2);
  const roomIdsUsed = new Set(events.map((row) => row.room_id));
  assert.deepEqual(roomIdsUsed, new Set([ROOM_A, ROOM_B]));
});

test("chat_id -> room_id 해석이 캐시되어 같은 chat 재요청 시 huai_rooms 조회가 다시 안 나간다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_rooms", [{ room_id: ROOM_A, telegram_chat_id: CHAT_A }]);
  const store = makeStore(fake);

  const commit = (updateId: string) => ({
    message: { input: { kind: "message" as const, envelope: envelope(CHAT_A, updateId, "안녕") }, idempotencyKey: "telegram-update:bot:" + updateId, receivedAt: "2026-08-15T00:00:00.000Z" },
    result: { accepted: true as const, authorization: { allowed: true as const }, events: [], outbox: [] }
  });

  await store.commitTelegramInputResult(commit("1"));
  await store.commitTelegramInputResult(commit("2"));

  assert.equal(fake.countRequestsTo("huai_rooms"), 1);
});

test("알 수 없는 chat_id 면 임의의 방에 쓰지 않고 명확히 실패한다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_rooms", [{ room_id: ROOM_A, telegram_chat_id: CHAT_A }]);
  const store = makeStore(fake);

  const commit = {
    message: { input: { kind: "message" as const, envelope: envelope("9999", "1", "안녕") }, idempotencyKey: "telegram-update:bot:1", receivedAt: "2026-08-15T00:00:00.000Z" },
    result: { accepted: true as const, authorization: { allowed: true as const }, events: [], outbox: [] }
  };

  await assert.rejects(() => store.commitTelegramInputResult(commit), /room-not-found-for-chat:9999/);
  assert.equal((fake.tables["huai_events"] ?? []).length, 0);
});

test("/task 다른 방 task uuid 를 조회하면 존재하지 않는 task 와 동일한 '없음' 응답이 온다 (유출 차단)", async () => {
  const fake = new MiniSupabaseFake();
  const otherRoomTaskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const missingTaskId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [{
    task_id: otherRoomTaskId,
    room_id: ROOM_B,
    title: "다른 방 비밀 작업",
    status: "running",
    purpose: "유출되면 안 되는 목적",
    scope: "유출되면 안 되는 범위",
    completion_criteria: "유출되면 안 되는 완료 기준"
  }]);
  const store = makeStore(fake);

  const crossRoomResult = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/task", [otherRoomTaskId], { text: "작업 상세 조회 요청을 접수했습니다: " + otherRoomTaskId, query: { kind: "task", taskId: otherRoomTaskId } }, "telegram:query:task:cross")
  );
  const missingResult = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "2", "/task", [missingTaskId], { text: "작업 상세 조회 요청을 접수했습니다: " + missingTaskId, query: { kind: "task", taskId: missingTaskId } }, "telegram:query:task:missing")
  );

  const crossRoomText = String(crossRoomResult.outbox[0]?.payload.text);
  const missingText = String(missingResult.outbox[0]?.payload.text);

  assert.equal(crossRoomText.includes("다른 방 비밀 작업"), false);
  assert.equal(crossRoomText.includes("유출되면 안 되는"), false);
  assert.match(crossRoomText, /해당 작업을 찾지 못했습니다/);
  // 존재하지 않는 task 와 문구가 완전히 동일해야 한다 (다른 방 task 라는 사실 자체가 새면 안 된다).
  assert.equal(crossRoomText.replace(otherRoomTaskId, "X"), missingText.replace(missingTaskId, "X"));
});

test("/trace 다른 방 task uuid 를 조회하면 이벤트·산출물·검증 이력이 노출되지 않는다 (유출 차단)", async () => {
  const fake = new MiniSupabaseFake();
  const taskId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [{ task_id: taskId, room_id: ROOM_B, title: "다른 방 작업" }]);
  fake.seed("huai_events", [{ event_id: "evt-1", room_id: ROOM_B, task_id: taskId, event_type: "meaningful_intermediate_ready", created_at: "2026-08-15T00:00:00.000Z" }]);
  fake.seed("huai_artifacts", [{ artifact_id: "art-1", task_id: taskId, uri: "supabase://secret-bucket/report.md", version: "v1", is_final: true, created_at: "2026-08-15T00:00:00.000Z" }]);
  fake.seed("huai_verifications", [{ verification_id: "ver-1", task_id: taskId, verdict: "pass", target_version: "attempt-1", created_at: "2026-08-15T00:00:00.000Z" }]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/trace", [taskId], { text: "작업 이력 조회 요청을 접수했습니다: " + taskId, query: { kind: "trace", taskId } }, "telegram:query:trace:cross")
  );
  const text = String(result.outbox[0]?.payload.text);

  assert.equal(text.includes("meaningful_intermediate_ready"), false);
  assert.equal(text.includes("secret-bucket"), false);
  assert.equal(text.includes("pass"), false);
  assert.match(text, /이벤트:\n- 없음/);
  assert.match(text, /산출물:\n- 없음/);
  assert.match(text, /검증:\n- 없음/);
});

test("/trace 는 자기 방 task 의 이벤트·산출물·검증 이력은 정상적으로 보여준다 (양성 대조)", async () => {
  const fake = new MiniSupabaseFake();
  const taskId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [{ task_id: taskId, room_id: ROOM_A, title: "우리 방 작업" }]);
  fake.seed("huai_events", [{ event_id: "evt-2", room_id: ROOM_A, task_id: taskId, event_type: "meaningful_intermediate_ready", created_at: "2026-08-15T00:00:00.000Z" }]);
  fake.seed("huai_artifacts", [{ artifact_id: "art-2", task_id: taskId, uri: "supabase://own-bucket/report.md", version: "v1", is_final: true, created_at: "2026-08-15T00:00:00.000Z" }]);
  fake.seed("huai_verifications", [{ verification_id: "ver-2", task_id: taskId, verdict: "pass", target_version: "attempt-1", created_at: "2026-08-15T00:00:00.000Z" }]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/trace", [taskId], { text: "작업 이력 조회 요청을 접수했습니다: " + taskId, query: { kind: "trace", taskId } }, "telegram:query:trace:own")
  );
  const text = String(result.outbox[0]?.payload.text);

  assert.match(text, /meaningful_intermediate_ready/);
  assert.match(text, /own-bucket/);
  assert.match(text, /pass/);
});

// V1 결함1: /task·/trace·/tasks 는 전부 유출 차단 테스트가 있었는데 /search 만 빠져 있었다
// (renderTaskSearchQuery 의 room_id=eq. 를 제거해도 bot-service 전 스위트가 초록이었다).
// 검색은 title 뿐 아니라 purpose/scope 도 or=(...) 로 함께 매치하므로, 같은 검색어를
// 두 방에 "서로 다른 필드"로 걸쳐 심어서 한 번의 검색으로 유출 차단과 양성 대조를 동시에
// 증명한다: room A 는 purpose 로 매치되고(자기 방 결과가 실제로 나온다), room B 는
// title 로 매치된다(room 필터가 없으면 room B 의 제목이 그대로 새어나갔을 것이다).
test("/search 는 검색어가 다른 방 task 의 title/purpose/scope 에 걸려도 그 방 결과를 새지 않고, 자기 방 결과는 정상적으로 찾아준다 (유출 차단 + 양성 대조)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [
    {
      task_id: "11111111-1111-4111-8111-111111111111",
      room_id: ROOM_A,
      title: "회원가입 폼 수정",
      purpose: "이메일 인증 버튼 정렬이 깨짐",
      scope: "회원가입 화면",
      status: "in_progress",
      priority: "normal",
      updated_at: "2026-08-15T01:00:00.000Z",
      created_at: "2026-08-15T00:00:00.000Z"
    },
    {
      task_id: "22222222-2222-4222-8222-222222222222",
      room_id: ROOM_B,
      title: "결제 버튼 정렬 오류",
      purpose: "유출되면 안 되는 목적",
      scope: "유출되면 안 되는 범위",
      status: "in_progress",
      priority: "normal",
      updated_at: "2026-08-15T01:00:00.000Z",
      created_at: "2026-08-15T00:00:00.000Z"
    }
  ]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/search", ["정렬"], { text: "작업 검색 요청을 접수했습니다: 정렬", query: { kind: "search", term: "정렬" } }, "telegram:query:search:leak-check")
  );
  const text = String(result.outbox[0]?.payload.text);

  // 양성 대조 — 검색어가 purpose 에만 걸려도 자기 방 결과는 정상적으로 나와야 한다.
  // (이게 없으면 쿼리가 항상 빈 결과를 내도 "유출 없음" 어서션만으로는 통과해버린다.)
  assert.match(text, /회원가입 폼 수정/);
  // 유출 차단 — room B 의 task 는 title 에 같은 검색어가 있어도 결과에 나오면 안 된다.
  assert.equal(text.includes("결제 버튼 정렬 오류"), false);
  assert.equal(text.includes("유출되면 안 되는"), false);

  const searchRequest = fake.requests.find((request) => new URL(request.url).pathname === "/rest/v1/huai_tasks" && request.method === "GET");
  assert.ok(searchRequest, "huai_tasks 검색 조회가 있어야 한다");
  assert.match(searchRequest!.url, new RegExp("room_id=eq\\." + ROOM_A));
});

test("fetchProposalExecutionHints 가 room_id 로 필터되어 다른 방의 동명 제안이 섞이지 않는다", async () => {
  const fake = new MiniSupabaseFake();
  const proposalId = "proposal_ffffffff-ffff-4fff-8fff-ffffffffffff";
  seedTwoRooms(fake);
  // 방이 늘면 "최근 200건" 창이 남의 방 제안으로 찰 수 있다는 실패 시나리오를 재현한다.
  // room 필터가 없으면 order=created_at.desc 로 인해 이 다른 방 레코드가 먼저 매칭된다.
  fake.seed("huai_events", [
    { event_id: "evt-other-room", room_id: ROOM_B, event_type: "proposal_created", payload: { proposalId, title: "다른 방의 동명 제안", rawText: "다른 방 요청 내용" }, created_at: "2026-08-15T00:00:02.000Z" },
    { event_id: "evt-own-room", room_id: ROOM_A, event_type: "proposal_created", payload: { proposalId, title: "우리 방 제안", rawText: "우리 방 요청 내용" }, created_at: "2026-08-15T00:00:01.000Z" }
  ]);
  const store = makeStore(fake);

  const commit = {
    message: {
      input: {
        kind: "callback" as const,
        envelope: envelope(CHAT_A, "1", undefined),
        callback: { entity: "proposal" as const, entityId: proposalId, action: "approve" as const }
      },
      idempotencyKey: "telegram-update:bot:1",
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{
        target: { kind: "local_gateway" as const, gatewayId: "gateway-1" },
        idempotencyKey: "gateway:execution:cross",
        payload: { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }
      }]
    }
  };

  const result = await store.commitTelegramInputResult(commit);
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown>;
  assert.match(String(executionRequest.prompt), /우리 방 요청 내용/);
  assert.equal(String(executionRequest.prompt).includes("다른 방 요청 내용"), false);
});

test("fetchApprovalIdForEntity 가 room_id 로 필터되어 다른 방의 동일 entity_ref 승인과 섞이지 않는다", async () => {
  const fake = new MiniSupabaseFake();
  const proposalId = "proposal_99999999-9999-4999-8999-999999999999";
  seedTwoRooms(fake);
  // entity_ref 충돌은 실전에서 사실상 불가능하지만(파생 uuid 16자), 방이 늘면 전제가
  // 바뀐다는 지적에 따라 room_id 필터가 실제로 걸리는지 인위적으로 검증한다.
  fake.seed("huai_approvals", [
    { approval_id: "approval-room-b", room_id: ROOM_B, entity_ref: proposalId, stage: "task_approval", decision: "approved", decider_telegram_user_id: 9001, created_at: "2026-08-15T00:00:00.000Z" },
    { approval_id: "approval-room-a", room_id: ROOM_A, entity_ref: proposalId, stage: "task_approval", decision: "approved", decider_telegram_user_id: 9001, created_at: "2026-08-15T00:00:01.000Z" }
  ]);
  fake.seed("huai_events", [
    { event_id: "evt-proposal-a", room_id: ROOM_A, event_type: "proposal_created", payload: { proposalId, title: "우리 방 제안", rawText: "우리 방 요청 내용" }, created_at: "2026-08-15T00:00:00.000Z" }
  ]);
  const store = makeStore(fake);

  const commit = {
    message: {
      input: {
        kind: "callback" as const,
        envelope: envelope(CHAT_A, "1", undefined),
        callback: { entity: "proposal" as const, entityId: proposalId, action: "approve" as const }
      },
      idempotencyKey: "telegram-update:bot:1",
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{
        target: { kind: "local_gateway" as const, gatewayId: "gateway-1" },
        idempotencyKey: "gateway:execution:approval-cross",
        payload: { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }
      }]
    }
  };

  await store.commitTelegramInputResult(commit);

  const task = (fake.tables["huai_tasks"] ?? []).find((row) => row.proposal_id !== undefined || row.idempotency_key === "task:approved-proposal:" + proposalId);
  assert.equal(task?.approved_by_approval_id, "approval-room-a");
});

// Delta 분대가 huai_outbox 에 room_id 컬럼을 추가하고 lease_huai_outbox 를 방 단위 공평
// 리스로 바꿨다(migration 20260815140000). INSERT 쪽이 room_id 를 안 채우면 새로 들어가는
// 모든 행이 room_id=null 로 한 버킷에 묶여 공평 리스가 무력화된다.
test("outbox INSERT 가 room_id 를 채운다 — 방마다 각자의 room_id 를 갖는다 (공평 리스 전제조건)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  const store = makeStore(fake);

  const commitFor = (chatId: string, updateId: string, idempotencyKey: string) => ({
    message: {
      input: { kind: "message" as const, envelope: envelope(chatId, updateId, "안녕") },
      idempotencyKey: "telegram-update:bot:" + updateId,
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{
        target: { kind: "telegram_bot" as const, botRole: "platoon_leader" as const, telegramChatId: chatId },
        idempotencyKey,
        payload: { text: "hi" }
      }]
    }
  });

  await store.commitTelegramInputResult(commitFor(CHAT_A, "1", "telegram:room-id-check:a"));
  await store.commitTelegramInputResult(commitFor(CHAT_B, "2", "telegram:room-id-check:b"));

  const outboxRows = fake.tables["huai_outbox"] ?? [];
  assert.equal(outboxRows.length, 2);
  const rowA = outboxRows.find((row) => row.idempotency_key === "telegram:room-id-check:a");
  const rowB = outboxRows.find((row) => row.idempotency_key === "telegram:room-id-check:b");
  assert.equal(rowA?.room_id, ROOM_A);
  assert.equal(rowB?.room_id, ROOM_B);
  assert.notEqual(rowA?.room_id, rowB?.room_id);
});

test("다른 방의 task_id 로 승인 이벤트가 와도 그 task 상태는 바뀌지 않는다 (상태 전이 유출 차단)", async () => {
  const fake = new MiniSupabaseFake();
  const taskId = "11111111-1111-4111-8111-111111111111";
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [{ task_id: taskId, room_id: ROOM_B, status: "verification_pending" }]);
  const store = makeStore(fake);

  const commit = {
    message: {
      input: { kind: "command" as const, envelope: envelope(CHAT_A, "1", "/verify " + taskId), command: { name: "/verify" as const, args: [taskId] } },
      idempotencyKey: "telegram-update:bot:1",
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [{ eventType: "owner_final_approved" as const, idempotencyKey: "owner_final_approved:bot:1:" + taskId, payload: { entityId: taskId, telegramUserId: "9001" } }],
      outbox: []
    }
  };

  await store.commitTelegramInputResult(commit);

  const task = (fake.tables["huai_tasks"] ?? []).find((row) => row.task_id === taskId);
  assert.equal(task?.status, "verification_pending");
});

// "작업 현황판 열기" 버튼의 startapp 값은 이 요청이 해석된 room_id 여야 한다 — 다른 방의
// roomId 가 실리면 방장이 눌렀을 때 남의 방 작업 현황판이 열린다(그 자체가 방 경계를 넘는
// 유출이다). 두 방에서 각각 /tasks 를 호출해 버튼의 startapp 값이 서로 다르고 각자의
// room_id 와 정확히 일치하는지 확인한다.
test("'작업 현황판 열기' 버튼의 startapp 값은 각 요청이 해석된 자기 방 room_id 다 (방 격리)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  const store = makeStore(fake, "https://t.me/leader_chatroom_bot/board");

  const resultA = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/tasks", [], { text: "작업 목록 조회 요청을 접수했습니다.", query: { kind: "tasks", limit: 10 } }, "telegram:query:tasks:room-a")
  );
  const resultB = await store.commitTelegramInputResult(
    commandCommit(CHAT_B, "2", "/tasks", [], { text: "작업 목록 조회 요청을 접수했습니다.", query: { kind: "tasks", limit: 10 } }, "telegram:query:tasks:room-b")
  );

  const urlA = (resultA.outbox[0]?.payload as Record<string, unknown>).keyboard as { inline_keyboard: Array<Array<{ url: string }>> } | undefined;
  const urlB = (resultB.outbox[0]?.payload as Record<string, unknown>).keyboard as { inline_keyboard: Array<Array<{ url: string }>> } | undefined;

  assert.match(urlA!.inline_keyboard[0][0].url, new RegExp("startapp=" + ROOM_A + "$"));
  assert.match(urlB!.inline_keyboard[0][0].url, new RegExp("startapp=" + ROOM_B + "$"));
  assert.notEqual(urlA!.inline_keyboard[0][0].url, urlB!.inline_keyboard[0][0].url);
});
