// mini-supabase-fake.ts 자체의 충실도 회귀 테스트.
//
// 이 fake 는 여러 분대의 테스트가 공유하는 기반이라, 실제 Postgres/PostgREST 보다
// 관대해서 거짓 초록불을 내는 지점이 없는지 감사했다(2026-08-15). 감사에서 실제로
// 위험하다고 판단해 고친 두 가지 — unique 제약, append-only 트리거 거부 — 를
// 여기서 fake 자신을 상대로 직접 검증한다. mini-supabase-fake.ts 상단 주석에
// "고치지 않고 남긴 것" 목록이 있으니, 그 항목에 의존하는 새 테스트를 짜기 전에
// 먼저 그 주석을 읽어라.
import assert from "node:assert/strict";
import test from "node:test";
import { MiniSupabaseFake } from "./mini-supabase-fake.js";

test("POST 로 같은 unique 컬럼 값을 두 번 넣으면 두 번째는 409 를 받고 저장되지 않는다", async () => {
  const fake = new MiniSupabaseFake();
  const first = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_approvals", {
    method: "POST",
    body: JSON.stringify({ approval_id: "a1", room_id: "r1", entity_ref: "e1", stage: "task_approval", decision: "approved", decider_telegram_user_id: 1, idempotency_key: "dup-key" })
  });
  assert.equal(first.status, 201);

  const second = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_approvals", {
    method: "POST",
    body: JSON.stringify({ approval_id: "a2", room_id: "r1", entity_ref: "e2", stage: "task_approval", decision: "approved", decider_telegram_user_id: 1, idempotency_key: "dup-key" })
  });
  assert.equal(second.status, 409);
  assert.equal(fake.tables["huai_approvals"]?.length, 1, "충돌한 두 번째 행은 저장되면 안 된다");
});

test("idempotency_key 가 null 인 행끼리는 unique 제약에 안 걸린다 (Postgres NULL 규칙과 동일)", async () => {
  const fake = new MiniSupabaseFake();
  const first = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_approvals", {
    method: "POST",
    body: JSON.stringify({ approval_id: "a1", room_id: "r1", entity_ref: "e1", stage: "task_approval", decision: "approved", decider_telegram_user_id: 1 })
  });
  const second = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_approvals", {
    method: "POST",
    body: JSON.stringify({ approval_id: "a2", room_id: "r1", entity_ref: "e2", stage: "task_approval", decision: "approved", decider_telegram_user_id: 1 })
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201, "idempotency_key 를 둘 다 안 준 행은 서로 충돌하면 안 된다");
  assert.equal(fake.tables["huai_approvals"]?.length, 2);
});

test("huai_ai_actors 는 (room_id, role) 복합 unique 제약이 걸린다", async () => {
  const fake = new MiniSupabaseFake();
  const first = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_ai_actors", {
    method: "POST",
    body: JSON.stringify({ actor_id: "act-1", room_id: "r1", role: "codex_leader", adapter_type: "codex", status: "active" })
  });
  const sameRoomSameRole = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_ai_actors", {
    method: "POST",
    body: JSON.stringify({ actor_id: "act-2", room_id: "r1", role: "codex_leader", adapter_type: "codex", status: "active" })
  });
  const sameRoomDifferentRole = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_ai_actors", {
    method: "POST",
    body: JSON.stringify({ actor_id: "act-3", room_id: "r1", role: "claude_leader", adapter_type: "claude_code", status: "active" })
  });

  assert.equal(first.status, 201);
  assert.equal(sameRoomSameRole.status, 409, "같은 방에 같은 role 이 두 번 있으면 안 된다");
  assert.equal(sameRoomDifferentRole.status, 201, "같은 방이라도 role 이 다르면 충돌이 아니다");
});

test("huai_approvals 에 PATCH 를 보내면 append-only 위반으로 거부되고 행이 안 바뀐다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_approvals", [{ approval_id: "a1", room_id: "r1", entity_ref: "e1", stage: "task_approval", decision: "approved", decider_telegram_user_id: 1 }]);

  const response = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_approvals?approval_id=eq.a1", {
    method: "PATCH",
    body: JSON.stringify({ decision: "rejected" })
  });

  assert.ok(!response.ok, "append-only 테이블 PATCH 는 성공하면 안 된다");
  const row = fake.tables["huai_approvals"]?.find((candidate) => candidate.approval_id === "a1");
  assert.equal(row?.decision, "approved", "행 내용이 그대로여야 한다 — 실제 트리거처럼 수정 자체가 거부돼야 한다");
});

test("huai_events 에 PATCH 를 보내면 append-only 위반으로 거부된다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_events", [{ event_id: "e1", room_id: "r1", event_type: "proposal_created", payload: {}, idempotency_key: "k1" }]);

  const response = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_events?event_id=eq.e1", {
    method: "PATCH",
    body: JSON.stringify({ event_type: "tampered" })
  });

  assert.ok(!response.ok);
  const row = fake.tables["huai_events"]?.find((candidate) => candidate.event_id === "e1");
  assert.equal(row?.event_type, "proposal_created");
});

// append-only 가 아닌 일반 테이블(예: huai_tasks)의 PATCH 는 여전히 정상 동작해야 한다 —
// 이 감사가 멀쩡한 기능까지 막지 않았는지 확인하는 양성 대조.
test("huai_tasks 같은 일반 테이블은 PATCH 가 여전히 정상 동작한다 (양성 대조)", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [{ task_id: "t1", room_id: "r1", status: "scheduled" }]);

  const response = await fake.fetchImpl("https://example.supabase.co/rest/v1/huai_tasks?task_id=eq.t1", {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress" })
  });

  assert.equal(response.status, 200);
  const row = fake.tables["huai_tasks"]?.find((candidate) => candidate.task_id === "t1");
  assert.equal(row?.status, "in_progress");
});

// or=(...) 는 실서비스에서 /search(supabase-store.ts 의 renderTaskSearchQuery) 가 쓴다:
// room_id=eq.<r>&or=(title.ilike.<term>,purpose.ilike.<term>,scope.ilike.<term>).
// 예전엔 이 fake 가 or= 를 조용히 무시해서, room_id 필터만으로 걸러진 "그 방의 전체
// task" 가 검색어와 무관하게 항상 돌아왔다 — 검색 안 되는 회귀를 못 잡는 상태였다.
test("or=(...) 는 조건 중 하나라도 맞는 행만 통과시킨다 (room_id=eq. 와 AND 로 결합)", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [
    { task_id: "t-title-match", room_id: "r1", title: "버튼 색깔 고쳐줘", purpose: "무관", scope: "무관" },
    { task_id: "t-purpose-match", room_id: "r1", title: "무관", purpose: "버튼 정렬 문제", scope: "무관" },
    { task_id: "t-no-match", room_id: "r1", title: "전혀 다른 작업", purpose: "전혀 다른 목적", scope: "전혀 다른 범위" },
    { task_id: "t-other-room", room_id: "r2", title: "버튼 관련 다른 방 작업", purpose: "무관", scope: "무관" }
  ]);

  const url = "https://example.supabase.co/rest/v1/huai_tasks?room_id=eq.r1&or=(" +
    encodeURIComponent("title.ilike.*버튼*,purpose.ilike.*버튼*,scope.ilike.*버튼*") +
    ")&select=task_id";
  const response = await fake.fetchImpl(url, { method: "GET" });
  const rows = (await response.json()) as Array<{ task_id: string }>;
  const ids = new Set(rows.map((row) => row.task_id));

  assert.equal(ids.has("t-title-match"), true, "title 이 매치되면 통과해야 한다");
  assert.equal(ids.has("t-purpose-match"), true, "purpose 가 매치되면 통과해야 한다(OR)");
  assert.equal(ids.has("t-no-match"), false, "어느 조건도 안 맞으면 빠져야 한다");
  assert.equal(ids.has("t-other-room"), false, "or= 가 room_id=eq. 필터까지 덮어쓰면 안 된다(AND 결합 유지)");
});

test("or=(...) 안에 중첩 and()/or() 가 오면 조용히 틀리지 않고 명시적으로 던진다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [{ task_id: "t1", room_id: "r1", title: "x" }]);

  await assert.rejects(
    () => fake.fetchImpl("https://example.supabase.co/rest/v1/huai_tasks?or=(" + encodeURIComponent("and(title.eq.x,room_id.eq.r1)") + ")", { method: "GET" }),
    /nested and\(\)\/or\(\) inside or=\(\.\.\.\) is not supported/
  );
});

test("or=(...) 가 괄호로 안 감싸여 있으면(형태가 이상하면) 명시적으로 던진다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [{ task_id: "t1", room_id: "r1", title: "x" }]);

  await assert.rejects(
    () => fake.fetchImpl("https://example.supabase.co/rest/v1/huai_tasks?or=" + encodeURIComponent("title.eq.x,room_id.eq.r1"), { method: "GET" }),
    /must be wrapped in parentheses/
  );
});

// ilike 는 실제 ILIKE 처럼 대소문자를 무시해야 한다. 예전엔 String.includes 를 그대로
// 써서 대소문자를 구분했다 — 검색어 대소문자가 안 맞으면 실제 DB 는 찾는데 이 fake 는
// 못 찾는(혹은 그 반대) 불일치가 생겼다.
test("ilike. 는 대소문자를 무시한다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [{ task_id: "t1", room_id: "r1", title: "Fix The Button" }]);

  const response = await fake.fetchImpl(
    "https://example.supabase.co/rest/v1/huai_tasks?title=ilike." + encodeURIComponent("*fix*button*"),
    { method: "GET" }
  );
  const rows = (await response.json()) as Array<{ task_id: string }>;

  assert.equal(rows.length, 1, "소문자 검색어가 대문자 섞인 제목과 대소문자 무관하게 매치해야 한다");
});

// ilike 는 맨 앞/뒤뿐 아니라 패턴 중간의 `*` 도 각각 임의 길이 와일드카드로 처리해야
// 한다(SQL LIKE 의 %). 예전엔 맨 앞/뒤 `*` 만 벗겨내고 중간 `*` 는 리터럴 문자로 비교했다.
test("ilike. 는 중간에 있는 와일드카드도 임의 길이로 매치한다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [
    { task_id: "t-match", room_id: "r1", title: "foo something bar" },
    { task_id: "t-no-match", room_id: "r1", title: "foo only" }
  ]);

  const response = await fake.fetchImpl(
    "https://example.supabase.co/rest/v1/huai_tasks?title=ilike." + encodeURIComponent("*foo*bar*"),
    { method: "GET" }
  );
  const rows = (await response.json()) as Array<{ task_id: string }>;
  const ids = new Set(rows.map((row) => row.task_id));

  assert.equal(ids.has("t-match"), true, "foo...bar 순서로 나오면 중간에 뭐가 있든 매치해야 한다");
  assert.equal(ids.has("t-no-match"), false, "bar 가 아예 없으면 매치하면 안 된다");
});

// gt./gte. 는 supabase-store.ts:352(fetchRecentRoomTurns, received_at=gt.<since>)
// 가 실제로 쓴다. 예전엔 이 fake 가 이 연산자를 조용히 무시해서 since 커트라인이
// 뭐든 항상 전체 행이 돌아왔다 — Bravo 의 fetchLastWorkCreatedAt 테스트가 이 갭 때문에
// 종단간 검증 대신 구조적 검사(room_id=eq. 가 URL 에 실렸는지만 확인)로 후퇴해야 했다.
test("gt./gte. 는 timestamptz 컬럼을 문자열 비교로 정확히 거른다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_telegram_updates", [
    { telegram_bot_id: "b1", update_id: "1", received_at: "2026-08-15T00:00:00.000000+00:00" },
    { telegram_bot_id: "b1", update_id: "2", received_at: "2026-08-15T00:01:00.000000+00:00" },
    { telegram_bot_id: "b1", update_id: "3", received_at: "2026-08-15T00:02:00.000000+00:00" }
  ]);

  const gtResponse = await fake.fetchImpl(
    "https://example.supabase.co/rest/v1/huai_telegram_updates?received_at=gt." + encodeURIComponent("2026-08-15T00:01:00.000000+00:00"),
    { method: "GET" }
  );
  const gtRows = (await gtResponse.json()) as Array<{ update_id: string }>;
  assert.deepEqual(new Set(gtRows.map((row) => row.update_id)), new Set(["3"]), "gt. 는 경계값 자신을 제외해야 한다");

  const gteResponse = await fake.fetchImpl(
    "https://example.supabase.co/rest/v1/huai_telegram_updates?received_at=gte." + encodeURIComponent("2026-08-15T00:01:00.000000+00:00"),
    { method: "GET" }
  );
  const gteRows = (await gteResponse.json()) as Array<{ update_id: string }>;
  assert.deepEqual(new Set(gteRows.map((row) => row.update_id)), new Set(["2", "3"]), "gte. 는 경계값 자신을 포함해야 한다");
});

// 미지 연산자를 조용히 무시하던 예전 정책은 위험한 기본값이었다 — 필터가 소리 없이
// 사라져서 결과만 조용히 틀려졌다. 지금은 명시적으로 던진다.
test("구현 안 된 연산자(lt. 등)를 만나면 조용히 무시하지 않고 명시적으로 던진다", async () => {
  const fake = new MiniSupabaseFake();
  fake.seed("huai_tasks", [{ task_id: "t1", room_id: "r1", created_at: "2026-08-15T00:00:00.000Z" }]);

  await assert.rejects(
    () => fake.fetchImpl("https://example.supabase.co/rest/v1/huai_tasks?created_at=lt." + encodeURIComponent("2026-08-15T00:00:00.000Z"), { method: "GET" }),
    /unsupported filter operator/
  );
});
