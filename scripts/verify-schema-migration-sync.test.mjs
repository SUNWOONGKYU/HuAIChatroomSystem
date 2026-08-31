import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectedNamedObjects, findSchemaDrift, stripSqlComments } from "./verify-schema-migration-sync.mjs";

function makeFixture(migrationFiles) {
  const root = mkdtempSync(path.join(tmpdir(), "schema-sync-fixture-"));
  const migrationsDir = path.join(root, "migrations");
  mkdirSync(migrationsDir, { recursive: true });
  Object.entries(migrationFiles).forEach(([name, content]) => {
    writeFileSync(path.join(migrationsDir, name), content);
  });
  return { root, migrationsDir };
}

test("expectedNamedObjects 는 create index/add constraint 를 이름별로 추적한다", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql":
      "create table if not exists widgets (\n  widget_id uuid primary key,\n  owner_id uuid not null,\n  constraint widgets_owner_check check (owner_id is not null)\n);\n" +
      "create index if not exists widgets_owner_idx on widgets (owner_id);\n"
  });
  try {
    const expected = expectedNamedObjects(migrationsDir);
    assert.equal(expected.get("widgets_owner_check"), "widgets");
    assert.equal(expected.get("widgets_owner_idx"), "widgets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drop table 는 그 테이블 소속으로 만든 인덱스도 같이 제거한다 — huai_room_memory 재현", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_create.sql":
      "create table if not exists scratch (\n  scratch_id uuid primary key\n);\n" +
      "create index if not exists scratch_id_idx on scratch (scratch_id);\n",
    "20260102000000_drop.sql": "drop table if exists scratch;\n"
  });
  try {
    const expected = expectedNamedObjects(migrationsDir);
    assert.equal(expected.has("scratch_id_idx"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("같은 파일 안에서 drop constraint 후 add constraint 로 재정의하면 최종적으로 존재하는 것으로 남는다 — NOT VALID→validate 관용구 재현", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql": "create table if not exists gateways (\n  gateway_id uuid primary key,\n  adapters jsonb not null\n);\n",
    "20260102000000_check.sql":
      "alter table gateways drop constraint if exists gateways_adapters_check;\n" +
      "alter table gateways add constraint gateways_adapters_check check (jsonb_array_length(adapters) > 0) not valid;\n"
  });
  try {
    const expected = expectedNamedObjects(migrationsDir);
    assert.equal(expected.get("gateways_adapters_check"), "gateways");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findSchemaDrift 는 마이그레이션에는 있는데 schema.sql 텍스트에 없는 이름을 보고한다 — 4차 감사 재현", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql":
      "create table if not exists widgets (\n  widget_id uuid primary key,\n  owner_id uuid not null\n);\n" +
      "create index if not exists widgets_owner_idx on widgets (owner_id);\n"
  });
  const schemaPath = path.join(root, "schema.sql");
  writeFileSync(schemaPath, "create table if not exists widgets (\n  widget_id uuid primary key,\n  owner_id uuid not null\n);\n");
  try {
    const missing = findSchemaDrift(schemaPath, migrationsDir);
    assert.deepEqual(missing, [{ name: "widgets_owner_idx", table: "widgets" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findSchemaDrift 는 schema.sql 이 이름을 담고 있으면 통과한다", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql":
      "create table if not exists widgets (\n  widget_id uuid primary key,\n  owner_id uuid not null\n);\n" +
      "create index if not exists widgets_owner_idx on widgets (owner_id);\n"
  });
  const schemaPath = path.join(root, "schema.sql");
  writeFileSync(
    schemaPath,
    "create table if not exists widgets (\n  widget_id uuid primary key,\n  owner_id uuid not null\n);\n\ncreate index if not exists widgets_owner_idx on widgets (owner_id);\n"
  );
  try {
    assert.deepEqual(findSchemaDrift(schemaPath, migrationsDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 결함(5차 감사) 대응 — SQL 주석을 DDL 로 오인하던 것 ──────────────────────────
// OP_RE 가 `--` 줄 주석을 벗겨내지 않아, "롤백(수동, 실행되지 않음)" 섹션의 예시
// `-- drop index ...`/`-- drop table ...` 를 진짜 DROP 으로 파싱했다. 그 결과 실제로
// CREATE 된 인덱스/제약이 present 맵에서 조용히 지워졌다(5차 평가관이
// expectedNamedObjects() 를 직접 호출해 계측 — huai_outbox_target_room_created_idx 등
// 3개가 추적 대상에서 빠짐). 아래는 그 정확한 재현이다.

test("주석 처리된 롤백 DROP 은 실제 CREATE 를 지우지 않는다 — 5차 감사 재현(단어 그대로)", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql":
      "create table if not exists widgets (\n  widget_id uuid primary key,\n  owner_id uuid not null\n);\n" +
      "create index if not exists widgets_owner_idx on widgets (owner_id);\n\n" +
      "-- =====================================================================\n" +
      "-- 롤백 (수동, 실행되지 않음)\n" +
      "-- =====================================================================\n" +
      "--\n" +
      "-- drop index if exists widgets_owner_idx;\n" +
      "-- drop table if exists widgets;\n"
  });
  try {
    const expected = expectedNamedObjects(migrationsDir);
    assert.equal(expected.get("widgets_owner_idx"), "widgets", "주석 처리된 drop index 는 무시돼야 한다");
    assert.ok(expected.has("widgets_owner_idx"), "widgets_owner_idx 가 추적 대상에서 빠지면 안 된다(5차 감사 재현)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("주석 처리된 drop table 은 그 테이블 소속 인라인 constraint 도 지우지 않는다", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql":
      "create table if not exists gadgets (\n  gadget_id uuid primary key,\n  constraint gadgets_id_check check (gadget_id is not null)\n);\n" +
      "-- drop table if exists gadgets;\n"
  });
  try {
    const expected = expectedNamedObjects(migrationsDir);
    assert.equal(expected.get("gadgets_id_check"), "gadgets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("블록 주석(/* */) 안의 DROP 도 진짜 DROP 으로 파싱하지 않는다", () => {
  const { root, migrationsDir } = makeFixture({
    "20260101000000_init.sql":
      "create table if not exists sprockets (\n  sprocket_id uuid primary key\n);\n" +
      "create index if not exists sprockets_id_idx on sprockets (sprocket_id);\n" +
      "/* rollback example:\n   drop index if exists sprockets_id_idx;\n   drop table if exists sprockets;\n*/\n"
  });
  try {
    const expected = expectedNamedObjects(migrationsDir);
    assert.equal(expected.get("sprockets_id_idx"), "sprockets");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripSqlComments — 문자열 리터럴 안의 -- 는 지우지 않는다(주석으로 오인 금지)", () => {
  const sql = "select 'a -- not a comment' as literal; -- real comment\nselect 1;";
  const stripped = stripSqlComments(sql);
  assert.match(stripped, /'a -- not a comment'/);
  assert.doesNotMatch(stripped, /real comment/);
});

test("stripSqlComments — 달러 인용 문자열($$...$$) 안의 -- 는 지우지 않는다(plpgsql 함수 본문)", () => {
  const sql =
    "create function f() returns void as $$\n" +
    "begin\n" +
    "  -- this looks like a comment but is inside the function body string\n" +
    "  perform 1;\n" +
    "end;\n" +
    "$$ language plpgsql; -- real trailing comment\n";
  const stripped = stripSqlComments(sql);
  assert.match(stripped, /this looks like a comment but is inside the function body string/);
  assert.doesNotMatch(stripped, /real trailing comment/);
});

test("stripSqlComments — 이스케이프된 홑따옴표('') 를 포함한 문자열 리터럴도 안전하게 지나간다", () => {
  const sql = "select 'it''s -- tricky' as literal; -- comment after\n";
  const stripped = stripSqlComments(sql);
  assert.match(stripped, /'it''s -- tricky'/);
  assert.doesNotMatch(stripped, /comment after/);
});

// ── 실제 repo 가드 ──────────────────────────────────────────────────────────
// supabase/migrations/ 가 누적해 온 인덱스·제약이 supabase/schema.sql 에 전부 반영돼
// 있는지 실제 저장소로 확인한다. 4차 감사가 이 상태(FK 인덱스 5개, 결함 관련
// CHECK 제약 2건, huai_tasks_room_thread_idx, huai_telegram_bots_actor_id_fkey 누락)를
// 지적한 뒤 supabase/schema.sql 을 갱신해 통과시켰다 — 이후 새 마이그레이션을 추가하고
// schema.sql 반영을 잊으면 이 테스트가 바로 잡는다.
test("실제 repo: supabase/schema.sql 이 supabase/migrations/ 누적 상태와 어긋나지 않는다", () => {
  const missing = findSchemaDrift();
  assert.deepEqual(
    missing,
    [],
    "supabase/schema.sql 이 마이그레이션과 드리프트됐다 — 위 목록의 인덱스/제약을 supabase/schema.sql 에 반영하라"
  );
});
