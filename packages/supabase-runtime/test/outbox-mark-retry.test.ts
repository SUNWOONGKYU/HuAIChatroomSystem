import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore } from "../src/index.js";

// V1 검증에서 지적된 구멍: markRetry 에 옵셔널 4번째 파라미터(attemptsOverride)를
// 추가했는데, FakeBotServiceStore(테스트 더블)만 그걸 반영하면 타입체크도 통과하고
// 앱 레이어 테스트도 전부 초록이지만, 실제 프로덕션 구현체인 이 SupabaseOutboxStore가
// 그 값을 안 받으면 조용히 무시되어 라이브 DB의 attempts 는 절대 안 바뀐다 — 컴파일러가
// 절대 못 잡는 종류의 구멍이다(옵셔널 파라미터라 구조적 타이핑이 봐준다). 그래서 이
// 테스트는 FakeBotServiceStore 를 거치지 않고, 실제 SupabaseOutboxStore.markRetry 가
// 만드는 PATCH 요청의 body 를 직접 들여다본다.
test("attemptsOverride 를 주면 PATCH body 에 attempts 가 그 값으로 실린다", async () => {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return jsonResponse(200, [{ huai_outbox_id: "outbox-1" }]);
  };
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl });

  await store.markRetry("outbox-1", "telegram-api-error:429:too many requests", "2026-08-15T00:01:00.000Z", 3);

  const patch = requests.find((request) => request.method === "PATCH" && request.url.includes("/huai_outbox"));
  assert.ok(patch, "PATCH /huai_outbox 요청이 나가야 한다");
  assert.equal(patch?.body?.attempts, 3, "attemptsOverride 값이 그대로 실려야 DB attempts 가 실제로 되돌아간다");
});

test("attemptsOverride 를 안 주면 PATCH body 에 attempts 키 자체가 없다(기존 동작 보존)", async () => {
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    return jsonResponse(200, [{ huai_outbox_id: "outbox-2" }]);
  };
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl });

  await store.markRetry("outbox-2", "telegram-api-error:500:temporary", "2026-08-15T00:01:00.000Z");

  const patch = requests.find((request) => request.method === "PATCH" && request.url.includes("/huai_outbox"));
  assert.ok(patch);
  // 값 비교(=== undefined)가 아니라 키 존재 여부로 확인한다 — attempts: undefined 를
  // 그대로 실어 보내면 PostgREST 가 그걸 어떻게 다룰지 보장이 없기 때문에, 코드가
  // 스프레드로 키 자체를 빼도록 만들었고 이 테스트는 그 키가 정말 없는지를 본다.
  assert.equal(patch?.body ? "attempts" in patch.body : true, false, "attemptsOverride 가 없으면 attempts 키 자체가 PATCH body 에 없어야 한다");
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
