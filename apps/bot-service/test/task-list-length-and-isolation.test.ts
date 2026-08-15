// /tasks 전용 회귀 테스트 2건:
//   1) room 격리 — 다른 방 task 가 /tasks 결과에 섞이지 않고, 총 건수도 우리 방 것만 센다.
//   2) 길이 초과 안전성 — 결과가 텔레그램 3900자 청크 한도를 넘어도 각 task 의 shortId 가
//      쪼개지거나 중복/누락되지 않고 정확히 한 청크에 온전히 담긴다.
// MiniSupabaseFake 는 URL 의 필터를 실제로 파싱해 적용하므로, room_id 필터를 빼면
// 이 테스트는 진짜로 빨간불이 된다 (큐잉 방식 목업으로는 증명 불가능한 부분).
import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";
import { MiniSupabaseFake } from "./mini-supabase-fake.js";
import { splitTelegramText, TELEGRAM_TEXT_CHUNK_LIMIT } from "../src/outbox.js";

const ROOM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_A = "1001";
const CHAT_B = "2002";

const ROOM_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHAT_C = "3003";

function makeStore(fake: MiniSupabaseFake, now?: () => Date): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-key-for-test",
    fetchImpl: fake.fetchImpl,
    now
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

test("/tasks 는 다른 방 task 를 섞지 않고, 총 건수도 우리 방 것만 센다 (room 격리)", async () => {
  const fake = new MiniSupabaseFake();
  seedTwoRooms(fake);
  fake.seed("huai_tasks", [
    { task_id: "task-room-a-0000000001", room_id: ROOM_A, title: "우리 방 작업1", status: "in_progress" },
    { task_id: "task-room-a-0000000002", room_id: ROOM_A, title: "우리 방 작업2", status: "scheduled" },
    { task_id: "task-room-b-0000000001", room_id: ROOM_B, title: "다른 방 비밀 작업", status: "blocked" }
  ]);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(
    commandCommit(CHAT_A, "1", "/tasks", [], { text: "작업 목록 조회 요청을 접수했습니다.", query: { kind: "tasks", limit: 10 } }, "telegram:query:tasks:isolation")
  );
  const text = String(result.outbox[0]?.payload.text);

  assert.match(text, /우리 방 작업1/);
  assert.match(text, /우리 방 작업2/);
  assert.equal(text.includes("다른 방 비밀 작업"), false);
  // 필터가 빠지면 3건이 잡힌다 — 총 2건이어야 room 필터가 결과 집합 자체를 줄였다는 증거가 된다.
  assert.match(text, /총 2건/);
  assert.equal(text.includes("총 3건"), false);

  const tasksRequest = fake.requests.find((request) => request.method === "GET" && new URL(request.url).pathname === "/rest/v1/huai_tasks");
  assert.ok(tasksRequest, "huai_tasks 조회 요청이 있어야 한다");
  assert.match(tasksRequest!.url, new RegExp("room_id=eq\\." + ROOM_A));
});

// 텔레그램 메시지는 마크다운 렌더링이 없고 하드 청크 한도가 3900자다
// (TELEGRAM_TEXT_CHUNK_LIMIT, apps/bot-service/src/outbox.ts). renderTaskListQuery 자체는
// 자르지 않는다 — 실제 분할은 전송 시점에 outbox.ts 의 splitTelegramText 가 담당한다.
// V1 지적: 예전엔 이 함수가 export 안 돼 있어서 여기서 알고리즘을 수동으로 복제해
// 썼다 — 프로덕션이 바뀌어도 이 테스트는 계속 초록으로 남는 취약점이었다. 이제
// export 해서 실물을 그대로 가져다 쓴다.

test("/tasks 결과가 텔레그램 3900자 한도를 넘어도 쪼개진 각 청크에서 task 가 안전하게 읽힌다 (길이 초과)", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_rooms", [{ room_id: ROOM_C, telegram_chat_id: CHAT_C }]);

  const taskCount = 18;
  // 3개 이상의 서로 다른 상태 그룹에 걸치도록 순환시킨다 (in_progress/waiting/action_needed/completed/paused).
  const statuses = ["in_progress", "scheduled", "blocked", "completed", "verification_pending", "paused_by_owner"];
  const longTasks = Array.from({ length: taskCount }, (_, i) => {
    const index = String(i + 1).padStart(3, "0");
    // 첫 8글자가 task 마다 유일하도록 인덱스를 앞쪽에 둔다 (shortTaskId 는 12자 초과 시 앞 8자만 사용).
    const taskId = "T" + index + "-" + "f".repeat(28);
    const title = "제목패딩용문자열-" + index + "-" + "가".repeat(170); // 40자+ 훨씬 웃도는 긴 제목
    return { task_id: taskId, room_id: ROOM_C, title, status: statuses[i % statuses.length] };
  });
  fake.seed("huai_tasks", longTasks);
  const store = makeStore(fake);

  const result = await store.commitTelegramInputResult(
    commandCommit(CHAT_C, "1", "/tasks", [], { text: "작업 목록 조회 요청을 접수했습니다.", query: { kind: "tasks", limit: 20 } }, "telegram:query:tasks:overflow")
  );
  const text = String(result.outbox[0]?.payload.text);

  // 시나리오가 실제로 초과 상황인지 먼저 확인한다 — 아니면 이 테스트는 의미가 없다.
  assert.ok(text.length > TELEGRAM_TEXT_CHUNK_LIMIT, `테스트 목적상 렌더링 결과가 ${TELEGRAM_TEXT_CHUNK_LIMIT}자를 넘어야 하는데 실제로는 ${text.length}자였다`);

  const chunks = splitTelegramText(text);

  // 진짜로 여러 메시지로 쪼개졌는지 확인한다 (우연히 한 청크에 다 들어가면 시나리오가 무의미하다).
  assert.ok(chunks.length >= 2, `청크가 최소 2개 이상이어야 하는데 ${chunks.length}개였다`);

  // 각 청크는 텔레그램 한도를 넘지 않아야 한다.
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_TEXT_CHUNK_LIMIT, `청크 길이 ${chunk.length}가 한도 ${TELEGRAM_TEXT_CHUNK_LIMIT}를 넘었다`);
  }

  // 핵심 증명: 각 task 의 shortId(앞 8자)가 정확히 한 청크에 온전히 담겨야 한다 —
  // 쪼개지지도, 중복되지도, 누락되지도 않아야 "쪼개져도 읽힌다"가 성립한다.
  for (const task of longTasks) {
    const shortId = task.task_id.slice(0, 8);
    const chunksContainingIt = chunks.filter((chunk) => chunk.includes(shortId));
    assert.equal(chunksContainingIt.length, 1, `shortId ${shortId} 는 정확히 1개 청크에만 있어야 하는데 ${chunksContainingIt.length}개에서 발견됐다`);
  }
});
