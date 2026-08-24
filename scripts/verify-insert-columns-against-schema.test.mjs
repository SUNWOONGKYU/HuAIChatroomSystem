// 라이브 온보딩 3건이 upsert-actors 단계에서 PGRST204("Could not find the 'config'
// column")로 전부 실패했다 — huai_ai_actors.config 컬럼은 schema.sql/라이브 DB 어디에도
// 애초에 존재하지 않았는데, generate-supabase-room-seed.mjs/onboard-telegram-room.mjs
// 는 그 컬럼에 값을 실었다. huai_rooms.purpose NOT NULL 누락과 같은 유형이다 — SQL
// 생성기는 만들기만 하고 실행하지 않고, 온보딩 CLI 테스트는 fake fetch 라 실제 스키마를
// 안 탄다. 둘 다 사전에 못 잡는 구조였다.
//
// 이 파일은 그 부류를 앞으로 잡는다: supabase/schema.sql 을 직접 파싱해서 각 테이블의
// 실제 컬럼 집합을 얻고, generate-supabase-room-seed.mjs 가 만드는 SQL 의 insert 컬럼
// 목록과 onboard-telegram-room.mjs 가 실제로 보내는 POST/PATCH 바디의 키 목록을 그
// 컬럼 집합과 대조한다. 스키마에 없는 컬럼을 하나라도 쓰면 빨간불이 된다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { generateSupabaseRoomSeed } from "./generate-supabase-room-seed.mjs";
import { onboardTelegramRoom } from "./onboard-telegram-room.mjs";

// ---------------------------------------------------------------------------
// supabase/schema.sql 파서 — "create table if not exists <name> (...);" 블록에서
// 컬럼명만 뽑는다. constraint/primary key/unique 같은 테이블 레벨 절은 컬럼이 아니므로
// 제외한다. 이 레포의 schema.sql 은 각 테이블 정의 안에 check(...) 를 제외하면 중첩
// 괄호가 없고, 닫는 ");" 가 테이블당 정확히 한 번만 그 자리에 나오는 형식을 일관되게
// 쓰고 있어 이 정규식으로 충분하다(실제로 파싱해서 23개 테이블 전부 확인했다).
// ---------------------------------------------------------------------------
export function parseSchemaColumns(schemaText) {
  const tables = {};
  const tableRegex = /create table if not exists (\w+) \(([\s\S]*?)\n\);/g;
  let match;
  while ((match = tableRegex.exec(schemaText))) {
    const tableName = match[1];
    const body = match[2];
    const columns = new Set();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("--")) continue;
      if (line.startsWith("constraint ")) continue;
      if (line.startsWith("primary key (")) continue;
      if (line.startsWith("unique (")) continue;
      if (line.startsWith("foreign key")) continue;
      const columnMatch = line.match(/^(\w+)\s/);
      if (columnMatch) columns.add(columnMatch[1]);
    }
    tables[tableName] = columns;
  }
  return tables;
}

function loadSchemaColumns() {
  const schemaText = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  return parseSchemaColumns(schemaText);
}

test("parseSchemaColumns finds the 5 tables room-seed/onboarding write to, with the expected columns", () => {
  const tables = loadSchemaColumns();
  assert.deepEqual(
    [...tables.huai_rooms].sort(),
    ["created_at", "owner_telegram_user_id", "purpose", "room_id", "rules", "status", "telegram_chat_id", "updated_at"]
  );
  assert.deepEqual(
    [...tables.huai_ai_actors].sort(),
    ["actor_id", "adapter_type", "cli_session_id", "cli_session_updated_at", "created_at", "role", "room_id", "status"]
  );
  // 이 단언 자체가 회귀 가드다: huai_ai_actors 에 config 컬럼이 없다는 걸 스키마
  // 파서로 직접 확인한다 — 다시 생기면(의도적으로 추가됐다면) 이 테스트부터 갱신해야 한다.
  assert.equal(tables.huai_ai_actors.has("config"), false);
});

// ---------------------------------------------------------------------------
// generate-supabase-room-seed.mjs: 생성된 SQL 문자열에서 "insert into <table> (<cols>)"
// 를 파싱해 각 테이블의 insert 컬럼이 스키마에 실재하는지 확인한다.
// ---------------------------------------------------------------------------

test("generate-supabase-room-seed.mjs only inserts columns that actually exist in schema.sql", () => {
  const tables = loadSchemaColumns();
  const sql = generateSupabaseRoomSeed(sampleSeedEnv());

  const insertPattern = /insert into (\w+) \(([^)]+)\) values/g;
  let match;
  let checkedStatements = 0;
  while ((match = insertPattern.exec(sql))) {
    const tableName = match[1];
    const columns = match[2].split(",").map((c) => c.trim());
    const schemaColumns = tables[tableName];
    assert.ok(schemaColumns, `insert targets unknown table: ${tableName}`);
    for (const column of columns) {
      assert.equal(
        schemaColumns.has(column),
        true,
        `generate-supabase-room-seed.mjs inserts "${tableName}.${column}" but supabase/schema.sql has no such column (columns that exist: ${[...schemaColumns].sort().join(", ")})`
      );
    }
    checkedStatements += 1;
  }
  // 이 표가 사실 아무 insert 문도 못 찾고 통과하면(정규식이 깨졌거나 SQL 이 비었으면)
  // 이 테스트는 항상 초록불이 되는 무의미한 상태가 된다 — 그런 일이 없는지 확인한다.
  // rooms(1) + room_members(1) + actors(4, role별 별도 insert) + bots(4, role별 별도 insert) + gateway(1) = 11
  assert.equal(checkedStatements, 11, "expected 11 insert statements — 실제 문 수가 바뀌면 이 숫자도 같이 검토하라");
});

function sampleSeedEnv() {
  return {
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
    BOT_SERVICE_AUDITOR_BOT_TOKEN: "test-auditor-token"
  };
}

// ---------------------------------------------------------------------------
// onboard-telegram-room.mjs: 실제로 fetchImpl 에 보내는 POST/PATCH 바디의 키를
// 캡처해서 스키마와 대조한다. 방을 두 번 온보딩해서 POST(신규)/PATCH(기존, 봇·게이트웨이만)
// 양쪽 경로 바디를 전부 잡는다.
// ---------------------------------------------------------------------------

test("onboard-telegram-room.mjs only sends columns that actually exist in schema.sql (POST and PATCH bodies)", async () => {
  const tables = loadSchemaColumns();
  const { fetchImpl, capturedWrites } = createColumnCapturingFetch();
  const fsOps = { existsSync: () => true, statSync: () => ({ isDirectory: () => true }) };
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    ...sampleSeedEnv()
  };

  const first = await onboardTelegramRoom(env, [], fetchImpl, fsOps);
  assert.equal(first.ok, true, "expected the first onboarding run to succeed (fixture setup problem otherwise)");
  const second = await onboardTelegramRoom(env, [], fetchImpl, fsOps);
  assert.equal(second.ok, true, "expected the re-run (PATCH paths for bots/gateway) to succeed");

  assert.ok(capturedWrites.length > 0, "expected at least one POST/PATCH to have been captured");
  // POST 와 PATCH 양쪽 다 실제로 잡혔는지 확인한다 — 안 그러면 이 테스트가 POST 경로만
  // 검증하고 PATCH 경로(봇/게이트웨이 재온보딩)는 그냥 넘어가는 반쪽짜리가 된다.
  assert.ok(capturedWrites.some((w) => w.method === "POST"));
  assert.ok(capturedWrites.some((w) => w.method === "PATCH"));

  for (const write of capturedWrites) {
    const schemaColumns = tables[write.table];
    assert.ok(schemaColumns, `${write.method} targets unknown table: ${write.table}`);
    for (const column of write.columns) {
      assert.equal(
        schemaColumns.has(column),
        true,
        `onboard-telegram-room.mjs sent ${write.method} "${write.table}.${column}" but supabase/schema.sql has no such column (columns that exist: ${[...schemaColumns].sort().join(", ")})`
      );
    }
  }
});

// 컬럼 이름만 캡처하면 충분하므로, 실제 postgrest 응답 흉내는 최소한으로만 둔다 —
// 존재 조회(GET)는 첫 실행에서는 빈 배열(→ POST), 두 번째 실행에서는 앞서 쓴 행을
// 그대로 돌려줘서(→ PATCH) 두 경로를 다 타게 만든다.
function createColumnCapturingFetch() {
  const store = { huai_rooms: [], huai_room_members: [], huai_ai_actors: [], huai_telegram_bots: [], huai_gateway_instances: [] };
  const capturedWrites = [];

  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET");
    const table = tableFromUrl(url);
    const query = parseQuery(url);

    if (method === "GET") {
      const rows = (store[table] ?? []).filter((row) => matchesQuery(row, query));
      return jsonResponse(200, rows);
    }

    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const rows = Array.isArray(body) ? body : [body];
    const onConflictCols = query.on_conflict ? query.on_conflict.split(",") : null;
    for (const row of rows) {
      capturedWrites.push({ table, method, columns: Object.keys(row) });
      if (method === "POST") {
        store[table] = store[table] ?? [];
        // merge-duplicates 흉내: on_conflict 컬럼이 이미 일치하는 행이 있으면 덮어쓰고,
        // 없으면 새로 넣는다 — 실제 PostgREST 동작과 같게 맞춰야 두 번째 온보딩 실행이
        // 중복 행 없이 postverify 를 통과한다(방 1개/actor 4개/봇 4개/게이트웨이 1개).
        const existing = onConflictCols
          ? store[table].find((r) => onConflictCols.every((col) => String(r[col]) === String(row[col])))
          : undefined;
        if (existing) Object.assign(existing, row);
        else store[table].push({ ...row });
      } else if (method === "PATCH") {
        for (const existing of (store[table] ?? []).filter((r) => matchesQuery(r, query))) {
          Object.assign(existing, row);
        }
      }
    }
    return jsonResponse(method === "POST" ? 201 : 200, rows);
  };

  return { fetchImpl, capturedWrites };
}

function tableFromUrl(url) {
  const afterPrefix = url.split("/rest/v1/")[1] ?? "";
  return afterPrefix.split("?")[0];
}

function parseQuery(url) {
  const queryString = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const result = {};
  for (const [key, value] of new URLSearchParams(queryString)) {
    result[key] = value;
  }
  return result;
}

function matchesQuery(row, query) {
  for (const [key, rawValue] of Object.entries(query)) {
    if (key === "select" || key === "on_conflict" || key === "limit" || key === "order") continue;
    if (rawValue.startsWith("eq.")) {
      if (String(row[key] ?? "") !== rawValue.slice(3)) return false;
    } else if (rawValue.startsWith("in.(") && rawValue.endsWith(")")) {
      const options = rawValue.slice(4, -1).split(",");
      if (!options.includes(String(row[key] ?? ""))) return false;
    } else if (String(row[key] ?? "") !== rawValue) {
      return false;
    }
  }
  return true;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}
