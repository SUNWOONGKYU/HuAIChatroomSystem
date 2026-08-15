import assert from "node:assert/strict";
import test from "node:test";
import { migrateTargetFromResponse, planChatIdRepairs } from "./repair-migrated-chat-ids.mjs";

test("Telegram 이 알려준 새 chat_id 를 그대로 읽는다", () => {
  const response = {
    ok: false,
    description: "Bad Request: group chat was upgraded to a supergroup chat",
    parameters: { migrate_to_chat_id: -1004428017336 }
  };
  assert.equal(migrateTargetFromResponse(response), -1004428017336);
});

test("승격 안내가 없는 실패에서는 새 id 를 지어내지 않는다", () => {
  assert.equal(migrateTargetFromResponse({ ok: false, description: "Bad Request: chat not found" }), undefined);
  assert.equal(migrateTargetFromResponse({ ok: true }), undefined);
  assert.equal(migrateTargetFromResponse(undefined), undefined);
  assert.equal(migrateTargetFromResponse({ parameters: { migrate_to_chat_id: "-100442" } }), undefined);
});

test("승격된 방만 고친다", () => {
  const repairs = planChatIdRepairs([
    { roomId: "r1", purpose: "정상", currentChatId: -1004334034373, migrateToChatId: undefined, reachable: true },
    { roomId: "r2", purpose: "승격됨", currentChatId: -5335989333, migrateToChatId: -1004428017336, reachable: false }
  ]);

  assert.deepEqual(repairs, [{ roomId: "r2", purpose: "승격됨", from: -5335989333, to: -1004428017336 }]);
});

test("도달 불가여도 원인이 승격이 아니면 건드리지 않는다", () => {
  // 봇이 안 들어간 방, 삭제된 방은 chat_id 가 틀린 게 아니다. 여기서 뭔가 쓰면
  // 멀쩡한 값을 망가뜨린다.
  const repairs = planChatIdRepairs([
    { roomId: "r3", purpose: "봇 없음", currentChatId: -5000, migrateToChatId: undefined, reachable: false }
  ]);

  assert.deepEqual(repairs, []);
});

test("이미 새 id 로 저장돼 있으면 다시 쓰지 않는다", () => {
  const repairs = planChatIdRepairs([
    { roomId: "r4", purpose: "이미 갱신됨", currentChatId: -1004428017336, migrateToChatId: -1004428017336, reachable: false }
  ]);

  assert.deepEqual(repairs, []);
});

test("라이브에서 나온 세 방을 전부 계획에 담는다", () => {
  const repairs = planChatIdRepairs([
    { roomId: "a", purpose: "개인회생신청", currentChatId: -5335989333, migrateToChatId: -1004428017336 },
    { roomId: "b", purpose: "상증세법주식가치평가", currentChatId: -5320333638, migrateToChatId: -1004315119076 },
    { roomId: "c", purpose: "DCF기업가치평가", currentChatId: -5107250279, migrateToChatId: -1004321704366 }
  ]);

  assert.deepEqual(repairs.map((r) => r.to), [-1004428017336, -1004315119076, -1004321704366]);
});
