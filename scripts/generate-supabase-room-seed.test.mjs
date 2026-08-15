import assert from "node:assert/strict";
import test from "node:test";
import { generateSupabaseRoomSeed } from "./generate-supabase-room-seed.mjs";

test("generates idempotent room seed without raw bot token values", () => {
  const sql = generateSupabaseRoomSeed(sampleEnv());

  assert.match(sql, /insert into huai_rooms/);
  assert.match(sql, /insert into huai_room_members/);
  assert.equal((sql.match(/insert into huai_ai_actors/g) ?? []).length, 4);
  assert.equal((sql.match(/insert into huai_telegram_bots/g) ?? []).length, 4);
  assert.match(sql, /env:BOT_SERVICE_PLATOON_BOT_TOKEN/);
  assert.match(sql, /env:BOT_SERVICE_AUDITOR_WEBHOOK_SECRET/);
  assert.equal(sql.includes("test-platoon-token"), false);
  assert.equal(sql.includes("test-auditor-token"), false);
  assert.match(sql, /on conflict \(room_id\) do update/);
});

test("uses stable ids for repeated generation", () => {
  assert.equal(generateSupabaseRoomSeed(sampleEnv()), generateSupabaseRoomSeed(sampleEnv()));
});

test("rejects missing and invalid Telegram identifiers", () => {
  assert.throws(() => generateSupabaseRoomSeed({}), /missing-env:BOT_SERVICE_ROOM_ID/);
  assert.throws(
    () => generateSupabaseRoomSeed({ ...sampleEnv(), BOT_SERVICE_TELEGRAM_CHAT_ID: "chat-name" }),
    /invalid-env:BOT_SERVICE_TELEGRAM_CHAT_ID/
  );
});

test("locks the huai_telegram_bots insert/conflict shape for the room-independent bot migration", () => {
  const sql = generateSupabaseRoomSeed(sampleEnv());
  const botLines = botInsertLines(sql);
  assert.equal(botLines.length, 4);

  // username 과 role 이 정확한 짝으로 나온다. role 이 봇의 정체성으로 바뀐 뒤로는
  // 어느 username 에 어느 role 이 붙었는지가 핵심이라, role 집합만 보는 것으로는
  // 짝이 뒤바뀌어도 못 잡는다 (예: platoon_live_bot 이 auditor role 을 받는 경우).
  assert.deepEqual(botLines.map(insertedBotUsernameRolePair), [
    ["platoon_live_bot", "platoon_leader"],
    ["claude_live_bot", "claude_leader"],
    ["codex_live_bot", "codex_leader"],
    ["auditor_live_bot", "auditor"]
  ]);

  for (const line of botLines) {
    assert.match(line, /^insert into huai_telegram_bots \(telegram_bot_id, bot_username, role, actor_id, token_secret_ref, webhook_secret_ref, status\)/);
    // conflict 타깃은 bot_username 이어야 한다 — telegram_bot_id 로 되돌아가면
    // 두 번째 방을 시딩할 때 (roomId 가 빠진) 같은 telegram_bot_id 를 갖는 첫 insert 가
    // 여전히 idempotent 하게 처리되는지를 검증하지 못한다.
    assert.match(line, /on conflict \(bot_username\) do update set/);
    assert.doesNotMatch(line, /on conflict \(telegram_bot_id\)/);
    // actor_id 는 정보성 참조로 격하됐으므로 conflict 시 갱신 대상이면 안 된다 —
    // 갱신 대상이면 나중 방 시딩이 앞선 방의 actor_id 를 덮어쓴다.
    // telegram_bot_id 는 PK 라 애초에 갱신 대상이 될 수 없다.
    // 리터럴 부정 매칭(공백·대소문자에 뚫림) 대신 SET 절의 대입 컬럼 집합을
    // 통째로 비교한다 — 공백 유무·EXCLUDED 대소문자 변형은 물론 미래에 임의
    // 컬럼이 SET 절에 섞여 들어오는 것까지 한 번에 잡는다.
    assert.deepEqual(
      conflictSetColumns(line),
      new Set(["role", "token_secret_ref", "webhook_secret_ref", "status"])
    );
  }
});

test("keeps telegram_bot_id stable across different rooms but gives each room its own actor_id", () => {
  const sqlRoomA = generateSupabaseRoomSeed(sampleEnv());
  const sqlRoomB = generateSupabaseRoomSeed({
    ...sampleEnv(),
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000099"
  });

  // 봇은 room 과 무관한 존재라 roomId 가 달라도 telegram_bot_id 는 같아야 한다
  // (같은 봇 계정을 여러 방에서 공유하는 것이 이번 마이그레이션의 핵심 목적).
  assert.deepEqual(insertedBotIds(sqlRoomA), insertedBotIds(sqlRoomB));
  assert.equal(insertedBotIds(sqlRoomA).length, 4);

  // 반대로 actor 는 방마다 별개여야 한다 (huai_ai_actors 는 room_id + role 로 unique).
  const actorIdsA = insertedActorIds(sqlRoomA);
  const actorIdsB = insertedActorIds(sqlRoomB);
  assert.equal(actorIdsA.length, 4);
  for (const actorId of actorIdsA) {
    assert.equal(actorIdsB.includes(actorId), false);
  }
});

function botInsertLines(sql) {
  return sql.split("\n").filter((line) => line.startsWith("insert into huai_telegram_bots"));
}

function actorInsertLines(sql) {
  return sql.split("\n").filter((line) => line.startsWith("insert into huai_ai_actors"));
}

function insertedBotUsernameRolePair(line) {
  const match = line.match(/values \('[^']+'::uuid, '([^']+)', '([^']+)',/);
  if (!match) throw new Error(`no username/role match in bot insert line: ${line}`);
  return [match[1], match[2]];
}

// "on conflict (...) do update set <col> = excluded.<col>, ..." 절에서 실제로
// 갱신되는 컬럼명 집합을 뽑아낸다. LHS 의 "컬럼 = " 형태만 매치하므로 공백
// 유무나 RHS(excluded/EXCLUDED) 대소문자와 무관하게 정확한 컬럼 집합을 얻는다.
function conflictSetColumns(line) {
  const setClauseMatch = line.match(/do update set (.+);$/i);
  if (!setClauseMatch) throw new Error(`no "do update set" clause found in line: ${line}`);
  const assignments = setClauseMatch[1].match(/(\w+)\s*=/g) ?? [];
  return new Set(assignments.map((assignment) => assignment.replace(/\s*=$/, "")));
}

function insertedUuidValue(line) {
  const match = line.match(/values \('([^']+)'::uuid,/);
  if (!match) throw new Error(`no leading uuid match in line: ${line}`);
  return match[1];
}

function insertedBotIds(sql) {
  return botInsertLines(sql).map(insertedUuidValue);
}

function insertedActorIds(sql) {
  return actorInsertLines(sql).map(insertedUuidValue);
}

function sampleEnv() {
  return {
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010",
    BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
    BOT_SERVICE_OWNER_TELEGRAM_USER_ID: "123456789",
    BOT_SERVICE_EXECUTION_GATEWAY_ID: "gateway-local",
    BOT_SERVICE_EXECUTION_PROJECT_PATH: "C:/Dev/HuAIChatroomSystem",
    BOT_SERVICE_PLATOON_BOT_USERNAME: "platoon_live_bot",
    BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
    BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
    BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot",
    BOT_SERVICE_PLATOON_BOT_TOKEN: "test-platoon-token",
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token"
  };
}