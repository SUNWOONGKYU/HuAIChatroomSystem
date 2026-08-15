// room_id 필터 회귀 커버리지 보강 (V1 코드 리뷰 지적 대응).
// 아래 테스트는 room-isolation.test.ts 에 아직 없는 경로를 겨냥한다:
//  1) write contamination — insertTaskForProposal/insertProposalIfMissing 의 INSERT 가
//     실제로 올바른 room_id 를 찍는지 (outbox/prompt 내용이 아니라 저장된 행 자체를 검사).
//  2) fetchOwnerTelegramUserId 가 room_id 로 필터되어 방장 오인식이 나지 않는지.
//  3) fetchLastWorkCreatedAt 이 room_id 로 필터되어 다른 방의(더 늦은) 커트라인을 쓰지
//     않는지 — 구조적 검사(쿼리에 room_id=eq. 가 실리는가) + 종단간 검사(그 결과 실제로
//     대화창이 안 잘리는가) 두 축. 경계값(gt. vs gte.) 고정 테스트도 같이 둔다.
//  4) /trace 의 huai_events 조회 자체도 room_id=eq. 를 달고 나가는지 (심층 방어).
// MiniSupabaseFake 는 URL 의 필터를 실제로 파싱해 적용하므로, room_id 필터가 빠지면
// 이 테스트들은 진짜로 빨간불이 된다.
import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";
import { MiniSupabaseFake } from "./mini-supabase-fake.js";

const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_A = "1001";
const CHAT_B = "2002";

function makeStore(fake: MiniSupabaseFake): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: fake.fetchImpl
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

// 소대장 판단(leader-planning) 흐름을 트리거하는 커밋. hydrateLeaderPlanningRows 는
// target_kind 를 가리지 않고 payload.executionRequest.attemptId 가 "leader-planning-" 로
// 시작하는 outbox 행이면 무조건 turns 를 채워 넣는다 — 그래서 target 은 무엇이든 상관없다.
function leaderPlanningCommit(chatId: string, updateId: string) {
  return {
    message: {
      input: { kind: "message" as const, envelope: envelope(chatId, updateId, "논의 정리해줘") },
      idempotencyKey: "telegram-update:bot:" + updateId,
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{
        target: { kind: "local_gateway" as const, gatewayId: "gateway-1" },
        idempotencyKey: "gateway:leader-planning:" + updateId,
        payload: {
          triggeringText: "논의 정리해줘",
          telegramChatId: chatId,
          executionRequest: {
            attemptId: "leader-planning-" + updateId,
            taskId: "leader-planning-placeholder-" + updateId,
            prompt: ""
          }
        }
      }]
    }
  };
}

test("write contamination: insertTaskForProposal/insertProposalIfMissing 이 승인이 발생한 방의 room_id 를 찍는다", async () => {
  const fake = new MiniSupabaseFake();
  const proposalId = "proposal_11111111-1111-4111-8111-111111111111";
  seedTwoRooms(fake);
  fake.seed("huai_events", [
    { event_id: "evt-own-room", room_id: ROOM_A, event_type: "proposal_created", payload: { proposalId, title: "우리 방 작업", rawText: "우리 방 작업 요청" }, created_at: "2026-08-15T00:00:01.000Z" }
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
        idempotencyKey: "gateway:execution:write-contamination",
        payload: { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }
      }]
    }
  };

  await store.commitTelegramInputResult(commit);

  const proposalUuid = proposalId.slice("proposal_".length);
  const insertedTask = (fake.tables["huai_tasks"] ?? []).find((row) => row.proposal_id === proposalUuid);
  const insertedProposal = (fake.tables["huai_task_proposals"] ?? []).find((row) => row.proposal_id === proposalUuid);

  assert.ok(insertedTask, "huai_tasks 에 승인된 작업이 삽입되어야 한다");
  assert.ok(insertedProposal, "huai_task_proposals 에 제안 행이 삽입되어야 한다");
  assert.equal(insertedTask?.room_id, ROOM_A);
  assert.equal(insertedProposal?.room_id, ROOM_A);
});

test("fetchOwnerTelegramUserId 가 room_id 로 필터되어 다른 방의 owner id 로 방장을 오인식하지 않는다", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  // 쿼리에 order= 가 없어 room_id 필터가 빠지면 배열 삽입 순서가 그대로 결과가 된다.
  // room B 것을 먼저 심어서, 필터가 빠지는 순간 limit=1 이 room B 의 owner 를 집어가게
  // 만든다(room A 를 먼저 심으면 우연히 여전히 A 가 나와서 회귀 테스트가 무의미해진다).
  fake.seed("huai_room_members", [
    { room_id: ROOM_B, telegram_user_id: 9999, role: "owner", status: "active" },
    { room_id: ROOM_A, telegram_user_id: 5001, role: "owner", status: "active" }
  ]);
  fake.seed("huai_telegram_updates", [{
    telegram_chat_id: CHAT_A,
    received_at: "2026-08-15T00:00:00.000Z",
    raw_update: { message: { text: "방장 발언입니다", from: { id: 5001, first_name: "방장이름", is_bot: false } } }
  }]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(leaderPlanningCommit(CHAT_A, "1"));
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown>;
  const prompt = String(executionRequest.prompt);

  assert.match(prompt, /\[방장\] 방장 발언입니다/);
});

// 구조적 검사 — fetchLastWorkCreatedAt 이 실제로 보내는 huai_events 쿼리 URL 에
// room_id=eq. 가 실려 있는지 직접 확인한다. 아래 종단간 테스트와 다른 축을 본다:
// 이건 "이 쿼리가 room_id 를 보내는가"만 보고, since 커트라인이 실제로 대화창을
// 걸러내는 결과까지는 안 본다(그건 필터 파라미터가 room B 걸로 바뀌어도 이 요청
// 자체는 여전히 문법적으로 정상이라 이 검사만으론 못 잡는다 — 그래서 둘 다 남긴다).
test("fetchLastWorkCreatedAt 이 보내는 huai_events 쿼리에 room_id=eq. 필터가 실린다 (구조적 검사)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  fake.seed("huai_room_members", [
    { room_id: ROOM_A, telegram_user_id: 5001, role: "owner", status: "active" }
  ]);
  fake.seed("huai_events", [
    { event_id: "evt-approved-a", room_id: ROOM_A, event_type: "owner_task_approved", created_at: "2026-08-15T00:00:00.000Z" }
  ]);
  fake.seed("huai_telegram_updates", [{
    telegram_chat_id: CHAT_A,
    received_at: "2026-08-15T01:00:00.000Z",
    raw_update: { message: { text: "새 논의 시작", from: { id: 5001, first_name: "방장", is_bot: false } } }
  }]);
  const store = makeStore(fake);

  await store.commitTelegramInputResult(leaderPlanningCommit(CHAT_A, "1"));

  const lastWorkRequest = fake.requests.find((request) =>
    new URL(request.url).pathname === "/rest/v1/huai_events" && request.method === "GET" && request.url.includes("event_type=eq.owner_task_approved"));
  assert.ok(lastWorkRequest, "owner_task_approved 조회 요청이 있어야 한다");
  assert.match(lastWorkRequest!.url, new RegExp("room_id=eq\\." + ROOM_A));
});

// 종단간(end-to-end) 검증 — 원래 설계. mini-supabase-fake.ts 가 gt./gte. 를 구현한
// 뒤 승격했다(Alpha, 문자열 비교 기반, timestamptz 컬럼 전용). room B 에 room A 보다
// *더 늦은* owner_task_approved 커트라인을 심는다. room_id 필터가 정상이면 room A 는
// 자기 커트라인(00:00)만 보고, 그 이후(01:00)의 대화는 포함된다. 필터가 빠지면
// order=created_at.desc 정렬 때문에 room B 의 더 늦은 커트라인(02:00)이 뽑히고,
// 01:00 시각 메시지는 "02:00 보다 이후"가 아니라서 huai_telegram_updates 쿼리에서
// 통째로 사라진다 — 방장이 방금 나눈 대화를 소대장이 못 본 채로 판단하게 된다.
test("fetchLastWorkCreatedAt 이 room_id 로 필터되어 다른 방의(더 늦은) 커트라인이 이 방 대화창을 잘라먹지 않는다 (종단간)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  fake.seed("huai_room_members", [
    { room_id: ROOM_A, telegram_user_id: 5001, role: "owner", status: "active" }
  ]);
  fake.seed("huai_events", [
    { event_id: "evt-approved-a", room_id: ROOM_A, event_type: "owner_task_approved", created_at: "2026-08-15T00:00:00.000Z" },
    { event_id: "evt-approved-b", room_id: ROOM_B, event_type: "owner_task_approved", created_at: "2026-08-15T02:00:00.000Z" }
  ]);
  fake.seed("huai_telegram_updates", [{
    telegram_chat_id: CHAT_A,
    received_at: "2026-08-15T01:00:00.000Z", // room A 커트라인(00:00) 이후, room B 커트라인(02:00) 이전
    raw_update: { message: { text: "새 논의 시작", from: { id: 5001, first_name: "방장", is_bot: false } } }
  }]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(leaderPlanningCommit(CHAT_A, "1"));
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown>;
  const prompt = String(executionRequest.prompt);

  assert.match(prompt, /새 논의 시작/);
});

// 경계값 고정 — since 는 owner_task_approved 이벤트(시스템 이벤트)의 시각이지 채팅
// 메시지가 아니다. 그 시각과 정확히 같은 시각에 도착한 메시지까지 포함하면 안 되므로
// 프로덕션은 gte.(이상) 가 아니라 gt.(초과)를 쓴다(supabase-store.ts:352). 이 테스트는
// 그 경계 선택을 고정한다 — gte. 로 잘못 바뀌면 이 테스트가 적색이 된다.
test("fetchRecentRoomTurns 는 커트라인과 정확히 같은 시각의 메시지는 포함하지 않는다 (gt. 경계값 고정)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  fake.seed("huai_room_members", [
    { room_id: ROOM_A, telegram_user_id: 5001, role: "owner", status: "active" }
  ]);
  fake.seed("huai_events", [
    { event_id: "evt-approved-a", room_id: ROOM_A, event_type: "owner_task_approved", created_at: "2026-08-15T00:00:00.000Z" }
  ]);
  fake.seed("huai_telegram_updates", [{
    telegram_chat_id: CHAT_A,
    received_at: "2026-08-15T00:00:00.000Z", // 커트라인과 정확히 같은 시각
    raw_update: { message: { text: "경계값 메시지", from: { id: 5001, first_name: "방장", is_bot: false } } }
  }]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(leaderPlanningCommit(CHAT_A, "1"));
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown>;
  const prompt = String(executionRequest.prompt);

  assert.equal(prompt.includes("경계값 메시지"), false);
});

test("/trace 는 huai_events 조회에도 room_id=eq. 필터를 함께 건다 (심층 방어)", async () => {
  const fake = new MiniSupabaseFake();
  const taskId = "cccccccc-1234-4abc-8abc-abcdefabcdef";
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [{ task_id: taskId, room_id: ROOM_A, title: "우리 작업" }]);
  const store = makeStore(fake);

  await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/trace", [taskId], { text: "placeholder", query: { kind: "trace", taskId } }, "telegram:query:trace:defense-in-depth")
  );

  const eventsRequest = fake.requests.find((request) => new URL(request.url).pathname === "/rest/v1/huai_events" && request.method === "GET");
  assert.ok(eventsRequest, "huai_events 에 대한 GET 요청이 있어야 한다");
  assert.match(eventsRequest!.url, new RegExp("room_id=eq\\." + ROOM_A));
});
