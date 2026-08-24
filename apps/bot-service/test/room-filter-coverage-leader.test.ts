// V1 코드 리뷰에서 지적된 회귀 공백을 메운다: room_id 로 필터하는 쿼리 중 다음 세 개는
// 필터를 실수로 지워도 빨간불이 되는 테스트가 없었다.
//   1) fetchLeaderActor — 다른 방의 CLI 세션을 이어받는 세션 하이재킹 위험
//   2) fetchRoomFacts — 다른 방의 진행 중 작업 제목이 AI 프롬프트로 새어나가는 위험
//   3) fetchActiveExecutionActorsByRole — 다른 방의 액터에게 실행이 배정되는 위험
// room-isolation.test.ts 의 패턴(MiniSupabaseFake·makeStore·envelope·seedTwoRooms)을 그대로 재사용한다 —
// 이 목업은 URL 의 eq. 필터를 실제로 파싱해 적용하므로, 프로덕션 코드에서 room_id 필터를
// 빼면 이 테스트들은 진짜로 빨간불이 된다.
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
  return new TelegramUpdateEnvelope("bot", "leader_bot", "leader", updateId, chatId, "10", "9001", false, text, undefined);
}

function seedTwoRooms(fake: MiniSupabaseFake): void {
  fake.seed("huai_rooms", [
    { room_id: ROOM_A, telegram_chat_id: CHAT_A },
    { room_id: ROOM_B, telegram_chat_id: CHAT_B }
  ]);
}

function leaderPlanningCommit(chatId: string, updateId: string, triggeringText: string, attemptId: string, idempotencyKey: string) {
  return {
    message: {
      input: {
        kind: "message" as const,
        envelope: envelope(chatId, updateId, triggeringText)
      },
      idempotencyKey: "telegram-update:bot:" + updateId,
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [],
      outbox: [{
        target: { kind: "local_gateway" as const, gatewayId: "gateway-1" },
        idempotencyKey,
        payload: {
          executionRequest: { attemptId, prompt: "placeholder" },
          triggeringText
        }
      }]
    }
  };
}

test("fetchLeaderActor 가 room_id 로 필터되어 다른 방의 CLI 세션을 이어받지 않는다 (세션 하이재킹 차단)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  // 쿼리에 order= 가 없어 room_id 필터가 빠지면 배열 삽입 순서가 그대로 결과가 된다.
  // room B 것을 먼저 심어서, 필터가 빠지는 순간 limit=1 이 room B 걸 집어가게 만든다
  // (room A 를 먼저 심으면 우연히 여전히 A 가 나와서 이 회귀 테스트가 무의미해진다).
  fake.seed("huai_ai_actors", [
    { actor_id: "actor-leader-b", room_id: ROOM_B, role: "leader", cli_session_id: "session-B", status: "active" },
    { actor_id: "actor-leader-a", room_id: ROOM_A, role: "leader", cli_session_id: "session-A", status: "active" }
  ]);
  const store = makeStore(fake);

  const commit = leaderPlanningCommit(CHAT_A, "1", "방 상태 알려줘", "leader-planning-1", "gateway:leader-planning:1");
  const result = await store.commitTelegramInputResult(commit);
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown>;

  assert.equal(executionRequest.actorId, "actor-leader-a");
  assert.equal(executionRequest.resumeSessionId, "session-A");
  assert.notEqual(executionRequest.actorId, "actor-leader-b");
  assert.notEqual(executionRequest.resumeSessionId, "session-B");
});

test("fetchRoomFacts 가 room_id 로 필터되어 다른 방의 진행 중 작업이 리더 프롬프트로 새지 않는다", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [
    { task_id: "11111111-1111-4111-8111-111111111111", room_id: ROOM_A, title: "우리 방 작업", status: "in_progress" },
    { task_id: "22222222-2222-4222-8222-222222222222", room_id: ROOM_B, title: "다른 방 비밀 작업", status: "in_progress" }
  ]);
  const store = makeStore(fake);

  const commit = leaderPlanningCommit(CHAT_A, "1", "방 상태 알려줘", "leader-planning-2", "gateway:leader-planning:2");
  const result = await store.commitTelegramInputResult(commit);
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown> | undefined;
  const prompt = String(executionRequest?.prompt ?? "");

  assert.match(prompt, /우리 방 작업/);
  assert.equal(prompt.includes("다른 방 비밀 작업"), false);
});

test("fetchActiveExecutionActorsByRole 가 room_id 로 필터되어 다른 방의 액터에게 실행이 배정되지 않는다 (교차 방 액터 배정 차단)", async () => {
  const fake = new MiniSupabaseFake();
  const proposalId = "proposal_33333333-3333-4333-8333-333333333333";
  seedTwoRooms(fake);
  fake.seed("huai_ai_actors", [
    { actor_id: "actor-claude-a", room_id: ROOM_A, role: "claude_leader", status: "active" },
    { actor_id: "actor-claude-b", room_id: ROOM_B, role: "claude_leader", status: "active" }
  ]);
  fake.seed("huai_events", [
    { event_id: "evt-proposal-a", room_id: ROOM_A, event_type: "proposal_created", payload: { proposalId, title: "우리 방 제안", rawText: "우리 방 요청 내용", requestedActorRole: "claude_leader" }, created_at: "2026-08-15T00:00:00.000Z" }
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
        idempotencyKey: "gateway:execution:cross-actor",
        payload: { executionRequest: { taskId: proposalId, prompt: "Execute approved task " + proposalId } }
      }]
    }
  };

  const result = await store.commitTelegramInputResult(commit);
  const executionRequest = (result.outbox[0]?.payload as Record<string, unknown>).executionRequest as Record<string, unknown>;

  assert.equal(executionRequest.actorId, "actor-claude-a");
  assert.notEqual(executionRequest.actorId, "actor-claude-b");
});
