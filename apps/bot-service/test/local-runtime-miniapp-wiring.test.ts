// 회귀 계급: "인터페이스에 옵셔널 필드를 추가했지만 실제 런타임 생성 지점이 안 넘긴다."
// SupabaseStoreConfig.miniAppDirectLinkBaseUrl 은 옵셔널이라 컴파일러가 못 잡았고,
// local-runtime.ts:153(buildSupabaseBotServiceRuntimeFromDatabase 안의 실제 프로덕션
// 생성 지점)이 값을 안 넘겨서 라이브에서 버튼이 끝까지 안 붙었다. store 를 직접
// 생성하는 테스트(task-list-grouping.test.ts 등)는 값을 항상 명시적으로 넘기므로
// 이 배선 누락을 못 잡는다 — 그래서 여기서는 실제 런타임 빌더 함수를
// env 와 함께 그대로 호출해서, 거기서 나온 store 가 진짜로 버튼을 붙이는지 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope, type TelegramInboundQueueMessage } from "../../../packages/contracts/src/index.js";
import { buildSupabaseBotServiceRuntimeFromDatabase } from "../src/local-runtime.js";
import { MiniSupabaseFake } from "./mini-supabase-fake.js";

const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_A = "1001";
const OWNER_USER_ID = "5001";

function seedRoomWithOwner(fake: MiniSupabaseFake): void {
  fake.seed("huai_rooms", [{ room_id: ROOM_A, telegram_chat_id: CHAT_A, status: "active" }]);
  fake.seed("huai_room_members", [
    { room_id: ROOM_A, telegram_user_id: Number(OWNER_USER_ID), role: "owner", permissions: [], status: "active" }
  ]);
}

function tasksCommandMessage(): TelegramInboundQueueMessage {
  return {
    input: {
      kind: "command",
      envelope: new TelegramUpdateEnvelope("bot", "platoon_bot", "platoon_leader", "1", CHAT_A, "10", OWNER_USER_ID, false, "/tasks", undefined),
      command: { name: "/tasks", args: [] }
    },
    idempotencyKey: "telegram-update:bot:1",
    receivedAt: "2026-08-15T00:00:00.000Z"
  };
}

function buildEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-test",
    ...overrides
  };
}

test("buildSupabaseBotServiceRuntimeFromDatabase 로 만든 실제 런타임이 BOT_SERVICE_MINIAPP_DIRECT_LINK 를 store 에 실제로 전달한다 (배선 회귀)", async () => {
  const fake = new MiniSupabaseFake();
  seedRoomWithOwner(fake);
  const env = buildEnv({ BOT_SERVICE_MINIAPP_DIRECT_LINK: "https://t.me/leader_chatroom_bot/board" });

  // store 를 직접 만들지 않는다 — task-list-grouping.test.ts 등은 이렇게 해서
  // "store 에 값을 넘기면 붙는다"만 증명했다. 여기서는 프로덕션이 실제로 부르는
  // 런타임 빌더를 그대로 태운다.
  const runtime = await buildSupabaseBotServiceRuntimeFromDatabase(env, { fetchImpl: fake.fetchImpl });
  await runtime.webhookPorts.inboundQueue.enqueue(tasksCommandMessage());
  await runtime.processQueuedInputs();

  const outboxRows = fake.tables["huai_outbox"] ?? [];
  const tasksRow = outboxRows.find((row) => {
    const payload = row.payload as Record<string, unknown> | undefined;
    return typeof payload?.text === "string" && payload.text.includes("작업 목록");
  });

  assert.ok(tasksRow, "/tasks 응답 outbox 행이 있어야 한다");
  const keyboard = (tasksRow!.payload as Record<string, unknown>).keyboard as { inline_keyboard: Array<Array<{ text: string; url: string }>> } | undefined;
  assert.ok(keyboard, "실제 런타임 경로로 만든 store 는 keyboard 를 붙여야 한다");
  assert.equal(keyboard!.inline_keyboard[0][0].text, "작업판 열기");
  assert.match(keyboard!.inline_keyboard[0][0].url, new RegExp("^https://t\\.me/leader_chatroom_bot/board\\?startapp=" + ROOM_A + "$"));
});

test("BOT_SERVICE_MINIAPP_DIRECT_LINK 가 미설정이면 실제 런타임 경로에서도 keyboard 가 안 붙는다 (기존 동작 보존)", async () => {
  const fake = new MiniSupabaseFake();
  seedRoomWithOwner(fake);
  const env = buildEnv(); // BOT_SERVICE_MINIAPP_DIRECT_LINK 없음

  const runtime = await buildSupabaseBotServiceRuntimeFromDatabase(env, { fetchImpl: fake.fetchImpl });
  await runtime.webhookPorts.inboundQueue.enqueue(tasksCommandMessage());
  await runtime.processQueuedInputs();

  const outboxRows = fake.tables["huai_outbox"] ?? [];
  const tasksRow = outboxRows.find((row) => {
    const payload = row.payload as Record<string, unknown> | undefined;
    return typeof payload?.text === "string" && payload.text.includes("작업 목록");
  });

  assert.ok(tasksRow, "/tasks 응답 outbox 행이 있어야 한다");
  assert.equal("keyboard" in (tasksRow!.payload as object), false);
});
