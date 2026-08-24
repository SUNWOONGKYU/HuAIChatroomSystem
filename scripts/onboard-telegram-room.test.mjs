import assert from "node:assert/strict";
import test from "node:test";
import { generateSupabaseRoomSeed } from "./generate-supabase-room-seed.mjs";
import { onboardTelegramRoom, formatOnboardResult } from "./onboard-telegram-room.mjs";

// onboard-telegram-room.mjs 는 room-seed-derivation.mjs 를 통해 SQL 생성기와 같은
// uuid 파생 로직을 공유한다. 이 테스트 파일은 실 Supabase/네트워크를 절대 건드리지
// 않는다 — 아래 createFakeSupabase() 가 만드는 인메모리 PostgREST 흉내가 유일한 백엔드다.

const TABLES = ["huai_rooms", "huai_room_members", "huai_ai_actors", "huai_telegram_bots", "huai_gateway_instances"];

test("① 신규 방 정상 온보딩", async () => {
  const { fetchImpl, calls, store } = createFakeSupabase();
  const result = await onboardTelegramRoom(sampleEnv(), [], fetchImpl, fakeFsOps());

  assert.equal(result.ok, true);
  assert.equal(result.stoppedAtStep, null);
  assert.deepEqual(
    result.steps.map((step) => step.id),
    ["validate-project-path", "precheck-room", "upsert-room", "upsert-room-member", "upsert-actors", "upsert-bots", "upsert-gateway", "postverify"]
  );
  // dry-run 이 아니므로 "would-apply"/"skipped" 는 하나도 나오면 안 된다.
  assert.equal(result.steps.every((step) => step.status === "ok"), true);

  assert.ok(result.summary);
  assert.equal(result.summary.bots.length, 4);
  assert.deepEqual(new Set(result.summary.bots.map((bot) => bot.role)), new Set(["leader", "claude_leader", "codex_leader", "auditor"]));
  assert.equal(result.summary.bots.every((bot) => bot.status === "created"), true);

  assert.equal(store.huai_rooms.length, 1);
  assert.equal(store.huai_room_members.length, 1);
  assert.equal(store.huai_ai_actors.length, 4);
  assert.equal(store.huai_telegram_bots.length, 4);
  assert.equal(store.huai_gateway_instances.length, 1);
  // huai_rooms.purpose 는 not null 이고 기본값이 없다 — 실제로 채워졌는지 확인한다.
  assert.equal(store.huai_rooms[0].purpose, "Telegram 협업 room");

  assert.ok(calls.length > 0);
});

test("② 재실행 멱등", async () => {
  const { fetchImpl, store } = createFakeSupabase();
  const fsOps = fakeFsOps();
  const env = sampleEnv();

  const first = await onboardTelegramRoom(env, [], fetchImpl, fsOps);
  assert.equal(first.ok, true);

  const second = await onboardTelegramRoom(env, [], fetchImpl, fsOps);
  assert.equal(second.ok, true);

  assert.equal(store.huai_rooms.length, 1);
  assert.equal(store.huai_room_members.length, 1);
  assert.equal(store.huai_ai_actors.length, 4);
  assert.equal(store.huai_telegram_bots.length, 4);
  assert.equal(store.huai_gateway_instances.length, 1);

  // 두 번째 실행부터는 봇 행이 이미 존재하므로 PATCH 경로(updated)를 타야 한다.
  assert.equal(second.summary.bots.length, 4);
  assert.equal(second.summary.bots.every((bot) => bot.status === "updated"), true);
});

test("③ project-path 없으면 실패", async () => {
  const { fetchImpl, calls } = createFakeSupabase();
  const result = await onboardTelegramRoom(sampleEnv(), [], fetchImpl, fakeFsOps({ exists: false }));

  assert.equal(result.stoppedAtStep, "validate-project-path");
  assert.equal(result.ok, false);
  assert.equal(result.summary, null);
  // 검증 단계에서 멈췄으므로 precheck GET 조차 나가면 안 된다.
  assert.equal(calls.length, 0);
});

test("④ 같은 chat_id가 다른 room_id로 이미 있으면 중단", async () => {
  const env = sampleEnv();
  const otherRoomId = "00000000-0000-0000-0000-0000000000ff";
  const { fetchImpl, calls } = createFakeSupabase({
    seed: {
      huai_rooms: [
        { room_id: otherRoomId, telegram_chat_id: env.BOT_SERVICE_TELEGRAM_CHAT_ID, owner_telegram_user_id: env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID, purpose: "이미 존재하는 방", status: "active" }
      ]
    }
  });

  const result = await onboardTelegramRoom(env, [], fetchImpl, fakeFsOps());

  assert.equal(result.stoppedAtStep, "precheck-room");
  assert.equal(result.ok, false);
  assert.equal(result.summary, null);

  // precheck 의 GET 자체는 발생해도 되지만, 그 이후의 쓰기(POST/PATCH)는 전혀 없어야 한다.
  const writeCalls = calls.filter((call) => call.method === "POST" || call.method === "PATCH");
  assert.equal(writeCalls.length, 0);
});

test("⑤ 중간 단계 실패 시 어디까지 갔는지 보고", async () => {
  const { fetchImpl } = createFakeSupabase({ failWrites: { huai_telegram_bots: true } });
  const result = await onboardTelegramRoom(sampleEnv(), [], fetchImpl, fakeFsOps());

  assert.equal(result.stoppedAtStep, "upsert-bots");
  assert.equal(result.ok, false);

  const stepIds = result.steps.map((step) => step.id);
  assert.deepEqual(stepIds, ["validate-project-path", "precheck-room", "upsert-room", "upsert-room-member", "upsert-actors", "upsert-bots"]);
  for (const id of ["validate-project-path", "precheck-room", "upsert-room", "upsert-room-member", "upsert-actors"]) {
    assert.equal(stepById(result, id).status, "ok");
  }
  const botsStep = stepById(result, "upsert-bots");
  assert.equal(botsStep.status, "failed");
  assert.equal(typeof botsStep.detail, "string");
  assert.ok(botsStep.detail.length > 0);

  // upsert-gateway/postverify 는 시도조차 안 됐으므로 배열에 아예 없어야 한다.
  assert.equal(stepById(result, "upsert-gateway"), undefined);
  assert.equal(stepById(result, "postverify"), undefined);
});

test("⑥ --dry-run 은 쓰기를 안 한다", async () => {
  const { fetchImpl, calls } = createFakeSupabase();
  const result = await onboardTelegramRoom(sampleEnv(), ["--dry-run"], fetchImpl, fakeFsOps());

  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);

  for (const id of ["upsert-room", "upsert-room-member", "upsert-actors", "upsert-bots", "upsert-gateway"]) {
    assert.equal(stepById(result, id).status, "would-apply");
  }
  assert.equal(stepById(result, "postverify").status, "skipped");

  // precheck-room 의 GET 한 건만 나가고, 그 외(봇/게이트웨이 존재확인 GET 포함) 쓰기·조회 전부 없어야 한다.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(tableFromUrl(calls[0].url), "huai_rooms");
});

test("⑦ 인자가 env보다 우선", async () => {
  const envRoomId = "00000000-0000-0000-0000-0000000000e1";
  const argRoomId = "00000000-0000-0000-0000-0000000000a1";
  const env = sampleEnv({ BOT_SERVICE_ROOM_ID: envRoomId });
  const { fetchImpl, calls } = createFakeSupabase();

  await onboardTelegramRoom(env, ["--room-id", argRoomId], fetchImpl, fakeFsOps());

  const roomWrite = calls.find((call) => tableFromUrl(call.url) === "huai_rooms" && call.method === "POST");
  assert.ok(roomWrite, "expected a POST upsert to huai_rooms");
  assert.equal(roomWrite.body.room_id, argRoomId);
  assert.notEqual(roomWrite.body.room_id, envRoomId);
});

test("⑧ 시드 스크립트와 온보딩 CLI가 같은 입력에 대해 동일한 uuid를 만든다", async () => {
  const env = sampleEnv();

  const sql = generateSupabaseRoomSeed(env);
  const sqlActorIds = sqlActorInsertLines(sql).map(sqlInsertedUuidValue).sort();
  const sqlBotIds = sqlBotInsertLines(sql).map(sqlInsertedUuidValue).sort();
  const sqlGatewayId = sqlInsertedUuidValue(sqlGatewayInsertLines(sql)[0]);

  const { fetchImpl, calls } = createFakeSupabase();
  await onboardTelegramRoom(env, [], fetchImpl, fakeFsOps());

  const actorWrite = calls.find((call) => tableFromUrl(call.url) === "huai_ai_actors" && call.method === "POST");
  assert.ok(actorWrite, "expected a bulk POST upsert to huai_ai_actors");
  const cliActorIds = actorWrite.body.map((row) => row.actor_id).sort();

  const botWrites = calls.filter((call) => tableFromUrl(call.url) === "huai_telegram_bots" && call.method === "POST");
  assert.equal(botWrites.length, 4);
  const cliBotIds = botWrites.map((call) => call.body.telegram_bot_id).sort();

  const gatewayWrite = calls.find((call) => tableFromUrl(call.url) === "huai_gateway_instances" && call.method === "POST");
  assert.ok(gatewayWrite, "expected a POST insert to huai_gateway_instances");
  const cliGatewayId = gatewayWrite.body.gateway_id;

  assert.deepEqual(cliActorIds, sqlActorIds);
  assert.deepEqual(cliBotIds, sqlBotIds);
  assert.equal(cliGatewayId, sqlGatewayId);
});

test("unknown-arg 은 진짜 예외로 전파된다 (resolveRoomSeedConfig 상속 동작)", async () => {
  const { fetchImpl, calls } = createFakeSupabase();
  await assert.rejects(
    () => onboardTelegramRoom(sampleEnv(), ["--bogus", "value"], fetchImpl, fakeFsOps()),
    /unknown-arg:--bogus/
  );
  // 설정 해석 단계에서 던져진 예외이므로 네트워크 호출은 전혀 없어야 한다.
  assert.equal(calls.length, 0);
});

test("서비스 롤 키가 요청 바디나 JSON 출력에 절대 새지 않는다", async () => {
  const env = sampleEnv();
  const { fetchImpl, calls } = createFakeSupabase();
  const result = await onboardTelegramRoom(env, [], fetchImpl, fakeFsOps());

  for (const call of calls) {
    if (call.body === undefined) continue;
    assert.equal(JSON.stringify(call.body).includes(env.SUPABASE_SERVICE_ROLE_KEY), false);
  }

  const json = formatOnboardResult(result, true);
  assert.equal(typeof json, "string");
  assert.equal(json.includes(env.SUPABASE_SERVICE_ROLE_KEY), false);
});

test("두 번째 방을 온보딩해도 공유 봇 행의 actor_id 를 덮어쓰지 않는다", async () => {
  // PostgREST merge-duplicates 는 요청 바디에 있는 컬럼을 전부 덮어쓴다. 봇은 room 과
  // 무관하게 공유되므로, room B 를 온보딩할 때 room A 가 이미 등록한 봇 행의 actor_id 가
  // room B 의 actor_id 로 덮여쓰이면 안 된다 — 이게 upsert-bots 가 블라인드 업서트를
  // 쓰지 않고 GET-then-PATCH(안전 컬럼만) 를 쓰는 이유 그 자체다. 이전 8케이스는 전부
  // 같은 room 을 두 번 온보딩하므로(멱등 테스트) actor_id 값이 우연히 같아서 이 결함을
  // 못 잡는다 — room 이 실제로 달라야 잡힌다.
  const { fetchImpl, store, calls } = createFakeSupabase();
  const fsOps = fakeFsOps();

  const roomA = sampleEnv();
  const roomB = sampleEnv({
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-0000000000b1",
    BOT_SERVICE_TELEGRAM_CHAT_ID: "-1009999999999",
    BOT_SERVICE_OWNER_TELEGRAM_USER_ID: "999999999"
  });

  const firstResult = await onboardTelegramRoom(roomA, [], fetchImpl, fsOps);
  assert.equal(firstResult.ok, true);
  const leaderBotAfterA = store.huai_telegram_bots.find((row) => row.role === "leader");
  const actorIdFromRoomA = leaderBotAfterA.actor_id;
  assert.ok(actorIdFromRoomA);

  const callsBeforeRoomB = calls.length;
  const secondResult = await onboardTelegramRoom(roomB, [], fetchImpl, fsOps);
  assert.equal(secondResult.ok, true);

  // 여전히 봇 행은 4개뿐이어야 한다(room 이 달라도 봇은 공유되므로 새로 생기면 안 된다).
  assert.equal(store.huai_telegram_bots.length, 4);
  const leaderBotAfterB = store.huai_telegram_bots.find((row) => row.role === "leader");
  assert.equal(leaderBotAfterB.actor_id, actorIdFromRoomA, "room B 온보딩이 room A 의 actor_id 를 덮어썼다");

  // 계약 자체를 검증한다: PATCH 요청 바디에 actor_id/telegram_bot_id 키가 아예 없어야 한다.
  // (값이 우연히 같아서 통과하는 게 아니라, 애초에 그 컬럼을 보내지 않는지 확인)
  const botPatchesForRoomB = calls.slice(callsBeforeRoomB).filter(
    (call) => tableFromUrl(call.url) === "huai_telegram_bots" && call.method === "PATCH"
  );
  assert.ok(botPatchesForRoomB.length > 0, "room B 온보딩은 이미 존재하는 봇 행에 대해 PATCH 를 보내야 한다");
  for (const patch of botPatchesForRoomB) {
    assert.equal("actor_id" in patch.body, false);
    assert.equal("telegram_bot_id" in patch.body, false);
  }
});

test("이미 online 인 게이트웨이를 재온보딩해도 status 를 offline 으로 되돌리지 않는다", async () => {
  const { fetchImpl, store, calls } = createFakeSupabase();
  const fsOps = fakeFsOps();
  const env = sampleEnv();

  const first = await onboardTelegramRoom(env, [], fetchImpl, fsOps);
  assert.equal(first.ok, true);
  assert.equal(store.huai_gateway_instances.length, 1);

  // 실 운영에서 heartbeat 가 게이트웨이를 'online' 으로 바꾼 상태를 흉내낸다.
  store.huai_gateway_instances[0].status = "online";

  const second = await onboardTelegramRoom(env, [], fetchImpl, fsOps);
  assert.equal(second.ok, true);

  assert.equal(store.huai_gateway_instances.length, 1);
  assert.equal(store.huai_gateway_instances[0].status, "online", "재온보딩이 실 게이트웨이 status 를 되돌렸다");

  const gatewayPatches = calls.filter((call) => tableFromUrl(call.url) === "huai_gateway_instances" && call.method === "PATCH");
  assert.ok(gatewayPatches.length > 0, "두 번째 온보딩은 이미 존재하는 게이트웨이 행에 대해 PATCH 를 보내야 한다");
  for (const patch of gatewayPatches) {
    assert.equal("status" in patch.body, false);
  }
});

// ---------------------------------------------------------------------------
// 테스트 하네스: 인메모리 PostgREST 흉내
// ---------------------------------------------------------------------------

function sampleEnv(overrides = {}) {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-should-never-leak",
    BOT_SERVICE_ROOM_ID: "00000000-0000-0000-0000-000000000010",
    BOT_SERVICE_TELEGRAM_CHAT_ID: "-1001234567890",
    BOT_SERVICE_OWNER_TELEGRAM_USER_ID: "123456789",
    BOT_SERVICE_EXECUTION_GATEWAY_ID: "gateway-local",
    BOT_SERVICE_EXECUTION_PROJECT_PATH: "C:/Dev/HuAIChatroomSystem",
    BOT_SERVICE_LEADER_BOT_USERNAME: "leader_live_bot",
    BOT_SERVICE_CLAUDE_BOT_USERNAME: "claude_live_bot",
    BOT_SERVICE_CODEX_BOT_USERNAME: "codex_live_bot",
    BOT_SERVICE_AUDITOR_BOT_USERNAME: "auditor_live_bot",
    BOT_SERVICE_LEADER_BOT_TOKEN: "test-leader-token",
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token",
    ...overrides
  };
}

// 실 파일시스템을 절대 건드리지 않기 위한 주입용 fsOps. onboardTelegramRoom 의
// validate-project-path 단계는 fsOps.existsSync(path) && fsOps.statSync(path).isDirectory()
// 형태로만 호출한다고 계약서에 명시되어 있다.
function fakeFsOps({ exists = true, isDirectory = true } = {}) {
  return {
    existsSync: () => exists,
    statSync: () => ({ isDirectory: () => isDirectory })
  };
}

function stepById(result, id) {
  return result.steps.find((step) => step.id === id);
}

function tableFromUrl(url) {
  const afterPrefix = url.split("/rest/v1/")[1] ?? "";
  return afterPrefix.split("?")[0];
}

// PostgREST 쿼리스트링을 실제로 파싱한다 (URLSearchParams). 부분 문자열 매칭은
// 필터가 실제로 걸리는지, 값이 맞는지를 검증하지 못한다 — Phase 0 의 실 사고 재발 방지.
function parsePostgrestQuery(url) {
  const queryString = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const result = {};
  for (const [key, value] of new URLSearchParams(queryString)) {
    result[key] = value;
  }
  return result;
}

const NON_FILTER_QUERY_KEYS = new Set(["select", "on_conflict", "order", "limit", "offset"]);

function matchesFilters(row, query) {
  for (const [key, rawValue] of Object.entries(query)) {
    if (NON_FILTER_QUERY_KEYS.has(key)) continue;
    if (rawValue.startsWith("eq.")) {
      const expected = rawValue.slice(3);
      if (String(row[key]) !== expected) return false;
    } else if (rawValue.startsWith("in.(") && rawValue.endsWith(")")) {
      const list = rawValue.slice(4, -1).split(",");
      if (!list.includes(String(row[key]))) return false;
    }
  }
  return true;
}

function project(row, query) {
  if (!query.select) return { ...row };
  const fields = query.select.split(",");
  const projected = {};
  for (const field of fields) projected[field] = row[field];
  return projected;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

// 테이블별 인메모리 배열을 store 로 두고, GET(필터+select)/POST(on_conflict 있으면
// find-or-append 로 merge-duplicates 흉내, 없으면 순수 insert)/PATCH(필터로 찾아
// 바디에 있는 필드만 갱신)를 시뮬레이션한다. 모든 호출은 { url, method, body } 로
// calls 배열에 기록되어 검사할 수 있다.
function createFakeSupabase({ seed = {}, failWrites = {} } = {}) {
  const store = {};
  for (const table of TABLES) store[table] = (seed[table] ?? []).map((row) => ({ ...row }));

  const calls = [];

  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    const table = tableFromUrl(url);
    const query = parsePostgrestQuery(url);

    // "upsert/insert 경로" 만 실패시킨다 — 존재확인 GET 은 그대로 통과시켜서
    // "GET 은 성공, 그 다음 쓰기가 실패" 라는 현실적인 중간 실패를 재현한다.
    if (failWrites[table] && (method === "POST" || method === "PATCH")) {
      return jsonResponse(500, { message: `simulated-failure:${table}` });
    }

    if (!store[table]) return jsonResponse(404, { message: `unknown-table:${table}` });

    if (method === "GET") {
      const rows = store[table].filter((row) => matchesFilters(row, query)).map((row) => project(row, query));
      return jsonResponse(200, rows);
    }

    if (method === "POST") {
      const incoming = Array.isArray(body) ? body : [body];
      const onConflictCols = query.on_conflict ? query.on_conflict.split(",") : null;
      const results = [];
      for (const item of incoming) {
        if (onConflictCols) {
          const existing = store[table].find((row) => onConflictCols.every((col) => String(row[col]) === String(item[col])));
          if (existing) {
            Object.assign(existing, item);
            results.push({ ...existing });
            continue;
          }
        }
        const inserted = { ...item };
        store[table].push(inserted);
        results.push({ ...inserted });
      }
      return jsonResponse(201, results);
    }

    if (method === "PATCH") {
      const matched = store[table].filter((row) => matchesFilters(row, query));
      for (const row of matched) Object.assign(row, body);
      return jsonResponse(200, matched.map((row) => ({ ...row })));
    }

    return jsonResponse(405, { message: `unsupported-method:${method}` });
  };

  return { fetchImpl, calls, store };
}

// ---------------------------------------------------------------------------
// generate-supabase-room-seed.mjs 가 만드는 SQL 에서 uuid 를 뽑아내는 헬퍼.
// generate-supabase-room-seed.test.mjs 의 insertedUuidValue 류 헬퍼와 같은 패턴.
// ---------------------------------------------------------------------------

function sqlActorInsertLines(sql) {
  return sql.split("\n").filter((line) => line.startsWith("insert into huai_ai_actors"));
}

function sqlBotInsertLines(sql) {
  return sql.split("\n").filter((line) => line.startsWith("insert into huai_telegram_bots"));
}

function sqlGatewayInsertLines(sql) {
  return sql.split("\n").filter((line) => line.startsWith("insert into huai_gateway_instances"));
}

function sqlInsertedUuidValue(line) {
  const match = line.match(/values \('([^']+)'::uuid,/);
  if (!match) throw new Error(`no leading uuid match in line: ${line}`);
  return match[1];
}
