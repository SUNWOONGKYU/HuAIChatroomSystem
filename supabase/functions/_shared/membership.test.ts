// assertRoomReadAccess 회귀. 실행 방법은 proposal-payload.test.ts 상단 주석 참고
// (스크래치 복사 + .ts 확장자 제거 + tsc + node --test).
//
// 방장이 초대한 사람이 협업 운영센터를 못 봤다. huai_room_members 에 손으로 넣기 전까지는
// "이 방의 협업 운영센터를 볼 권한이 없습니다"만 봤다 — 라이브에서 실제로 그렇게 막혔다.
// 방에 초대하는 것 자체가 "이 방 일을 봐도 된다"는 뜻이므로 그 사실을 그대로 쓴다.
import test from "node:test";
import assert from "node:assert/strict";
import { assertRoomReadAccess } from "./membership";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

test("등록된 멤버는 그대로 통과한다", async () => {
  const result = await assertRoomReadAccess(fakeSupabase({ membershipRole: "owner" }) as never, ROOM_ID, "5001");

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.viewerRole, "owner");
});

test("등록은 없어도 방 참가자면 볼 수 있다", async () => {
  const result = await assertRoomReadAccess(
    fakeSupabase({ membershipRole: null, telegramStatus: "member" }) as never,
    ROOM_ID,
    "7002"
  );

  assert.equal(result.ok, true, "초대된 사람이 협업 운영센터를 못 본다");
  if (result.ok) assert.equal(result.viewerRole, "human_member", "열람자는 방장이 아니다");
});

test("방을 나갔거나 쫓겨난 사람은 못 본다", async () => {
  for (const telegramStatus of ["left", "kicked"]) {
    const result = await assertRoomReadAccess(
      fakeSupabase({ membershipRole: null, telegramStatus }) as never,
      ROOM_ID,
      "7003"
    );
    assert.equal(result.ok, false, `${telegramStatus} 인데 열람이 허용됐다`);
  }
});

test("방 밖 사람은 못 본다", async () => {
  const result = await assertRoomReadAccess(
    fakeSupabase({ membershipRole: null, telegramOk: false }) as never,
    ROOM_ID,
    "9999"
  );

  assert.equal(result.ok, false);
});

test("Telegram 에 못 물어보면 예전처럼 등록된 멤버만 본다", async () => {
  // 확인이 안 되는 상태에서 열어주면 그게 곧 구멍이다.
  const result = await assertRoomReadAccess(
    fakeSupabase({ membershipRole: null, telegramThrows: true }) as never,
    ROOM_ID,
    "7004"
  );

  assert.equal(result.ok, false);
});

test("비활성 방은 참가자여도 못 본다", async () => {
  const result = await assertRoomReadAccess(
    fakeSupabase({ membershipRole: null, telegramStatus: "member", roomStatus: "archived" }) as never,
    ROOM_ID,
    "7005"
  );

  assert.equal(result.ok, false);
});

function fakeSupabase(options: {
  membershipRole?: string | null;
  telegramStatus?: string;
  telegramOk?: boolean;
  telegramThrows?: boolean;
  roomStatus?: string;
}) {
  const originalFetch = globalThis.fetch;
  const originalEnv = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno;

  (globalThis as { Deno?: unknown }).Deno = { env: { get: (key: string) => (key === "TELEGRAM_LEADER_BOT_TOKEN" ? "test-token" : undefined) } };
  globalThis.fetch = (async () => {
    if (options.telegramThrows) throw new Error("network-down");
    return new Response(JSON.stringify({
      ok: options.telegramOk ?? true,
      result: { status: options.telegramStatus ?? "member" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  test.after(() => {
    globalThis.fetch = originalFetch;
    (globalThis as { Deno?: unknown }).Deno = originalEnv;
  });

  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === "huai_rooms") {
            return { data: { room_id: ROOM_ID, purpose: "테스트 방", status: options.roomStatus ?? "active", telegram_chat_id: "-1001" }, error: null };
          }
          return { data: options.membershipRole ? { role: options.membershipRole } : null, error: null };
        }
      };
      return chain;
    }
  };
}
