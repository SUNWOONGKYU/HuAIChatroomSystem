// Delta 분대가 packages/orchestrator 의 실행 아웃박스 멱등키에서 updateId 를 뺐다
// (gateway:execution:<entityId>, packages/orchestrator/src/index.ts:540). Delta 는
// buildMultiAiExecutionRows/buildRoleExecutionRow(supabase-store.ts) 를 읽고 base 키가
// 뭐든 항상 :claude/:codex 접미가 붙어 2행이 나온다고 판단했지만, 이 파일이 다른 분대
// 소유라 직접 돌려보지 못했다. 여기서 실제로 새 키 형식으로 돌려서 확인한다:
//   1) 2행이 실제로 나오는가 (idempotency_key 가 서로 다른가)
//   2) 그 2행이 huai_outbox 에 실제로 둘 다 들어가는가 (unique 충돌 없이)
import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";
import { MiniSupabaseFake } from "./mini-supabase-fake.js";

const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_A = "1001";

function makeStore(fake: MiniSupabaseFake): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: fake.fetchImpl
  });
}

function envelope(chatId: string, updateId: string): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", updateId, chatId, "10", "9001", false, undefined, undefined);
}

test("multi_ai_review 승인은 새 키 형식(gateway:execution:<entityId>, updateId 없음)에서도 claude/codex 2행을 만들고 둘 다 huai_outbox 에 들어간다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_rooms", [{ room_id: ROOM_A, telegram_chat_id: CHAT_A }]);
  const proposalId = "proposal_11111111-1111-4111-8111-111111111111";
  // Delta 가 바꾼 실제 형식: gateway:execution:<entityId> — updateId 세그먼트가 없다(콜론 2개).
  const baseIdempotencyKey = "gateway:execution:" + proposalId;
  fake.seed("huai_events", [{
    event_id: "evt-proposal",
    room_id: ROOM_A,
    event_type: "proposal_created",
    payload: { proposalId, rawText: "ClaudeBot과 CodexBot이 각각 의견 내고 AuditBot이 검증해", intent: "multi_ai_review" },
    created_at: "2026-08-15T00:00:00.000Z"
  }]);
  fake.seed("huai_ai_actors", [
    { actor_id: "actor-claude", room_id: ROOM_A, role: "claude_leader", adapter_type: "claude_code", status: "active" },
    { actor_id: "actor-codex", room_id: ROOM_A, role: "codex_leader", adapter_type: "codex", status: "active" }
  ]);
  const store = makeStore(fake);

  const commit = {
    message: {
      input: {
        kind: "callback" as const,
        envelope: envelope(CHAT_A, "1"),
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
        idempotencyKey: baseIdempotencyKey,
        payload: { executionRequest: { taskId: proposalId, actorId: "actor-codex", adapterType: "codex", prompt: "Execute approved task " + proposalId } }
      }]
    }
  };

  const result = await store.commitTelegramInputResult(commit);

  // 1) outbox 응답 자체가 2건이어야 한다.
  assert.equal(result.outbox.length, 2, "claude/codex 2행이 나와야 한다");
  const keys = result.outbox.map((item) => item.idempotencyKey).sort();
  assert.deepEqual(keys, [baseIdempotencyKey + ":claude", baseIdempotencyKey + ":codex"]);

  // 2) 실제로 huai_outbox 테이블에 둘 다 들어갔는지 확인한다 (unique 제약 충돌 없이).
  const outboxRows = fake.tables["huai_outbox"] ?? [];
  assert.equal(outboxRows.length, 2, "huai_outbox 에 두 행이 실제로 삽입돼야 한다");
  const insertedKeys = outboxRows.map((row) => row.idempotency_key).sort();
  assert.deepEqual(insertedKeys, [baseIdempotencyKey + ":claude", baseIdempotencyKey + ":codex"]);

  const claudeRow = outboxRows.find((row) => row.idempotency_key === baseIdempotencyKey + ":claude");
  const codexRow = outboxRows.find((row) => row.idempotency_key === baseIdempotencyKey + ":codex");
  const claudeRequest = (claudeRow?.payload as Record<string, unknown>)?.executionRequest as Record<string, unknown>;
  const codexRequest = (codexRow?.payload as Record<string, unknown>)?.executionRequest as Record<string, unknown>;
  assert.equal(claudeRequest?.adapterType, "claude_code");
  assert.equal(claudeRequest?.reportBotRole, "claude_leader");
  assert.equal(codexRequest?.adapterType, "codex");
  assert.equal(codexRequest?.reportBotRole, "codex_leader");
});
