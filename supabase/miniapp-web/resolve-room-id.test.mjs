// index.html 의 resolveRoomId() 회귀 테스트.
//
// index.html 은 순수 HTML+바닐라 JS(자기완결 파일, 빌드 없음)라 이 저장소의 TypeScript
// 테스트 파이프라인(scratch tsc 컴파일)이 안 닿는다. 그렇다고 이 함수를 손으로 베껴서 딴
// 곳에서 테스트하면, index.html 이 나중에 바뀌었을 때 테스트가 실제 코드와 몰래 어긋날
// 수 있다 — 그래서 이 테스트는 실제 파일 텍스트에서 `function resolveRoomId(...) {...}`
// 정의를 정규식으로 그대로 뽑아 `new Function()` 으로 실행한다. 테스트가 통과하면 배포될
// 그 코드 자체가 통과한 것이다(사본이 아니다).
//
// 실행: node --test supabase/miniapp-web/resolve-room-id.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

const match = /function resolveRoomId\(qs, tg\) \{([\s\S]*?)\n  \}/.exec(html);
if (!match) {
  throw new Error("resolveRoomId 함수를 index.html 에서 찾지 못했다 — 시그니처가 바뀌었으면 이 테스트의 정규식도 같이 고쳐야 한다.");
}
const resolveRoomId = new Function("qs", "tg", match[1]);

// 실제 Telegram/브라우저의 URLSearchParams 를 흉내내는 최소 대역.
function fakeQs(params) {
  return { get: (key) => (Object.prototype.hasOwnProperty.call(params, key) ? params[key] : null) };
}

test("1순위: ?room= 이 있으면 그걸 쓴다", () => {
  const qs = fakeQs({ room: "room-from-query", tgWebAppStartParam: "room-from-startapp" });
  const tg = { initDataUnsafe: { start_param: "room-from-initdata" } };
  assert.equal(resolveRoomId(qs, tg), "room-from-query");
});

test("1순위(구형): ?roomId= 도 여전히 통한다(?room= 다음 순위)", () => {
  const qs = fakeQs({ roomId: "room-from-roomid-query" });
  assert.equal(resolveRoomId(qs, undefined), "room-from-roomid-query");
});

test("2순위: ?room=/?roomId= 가 없으면 tgWebAppStartParam 쿼리로 폴백한다 (Direct Link 그룹 진입)", () => {
  const qs = fakeQs({ tgWebAppStartParam: "room-from-startapp" });
  const tg = { initDataUnsafe: { start_param: "room-from-initdata" } };
  assert.equal(resolveRoomId(qs, tg), "room-from-startapp");
});

test("3순위: 쿼리 파라미터가 전부 없으면 initDataUnsafe.start_param 으로 폴백한다", () => {
  const qs = fakeQs({});
  const tg = { initDataUnsafe: { start_param: "room-from-initdata" } };
  assert.equal(resolveRoomId(qs, tg), "room-from-initdata");
});

test("셋 다 없으면 빈 문자열 — 방을 지정하지 않은 상태로 정직하게 떨어진다", () => {
  assert.equal(resolveRoomId(fakeQs({}), undefined), "");
  assert.equal(resolveRoomId(fakeQs({}), { initDataUnsafe: {} }), "");
  assert.equal(resolveRoomId(fakeQs({}), { initDataUnsafe: { start_param: "" } }), "");
});

test("tg 자체가 없어도(브라우저에서 직접 열었을 때) 쿼리 파라미터 경로는 안전하게 동작한다", () => {
  const qs = fakeQs({ room: "room-x" });
  assert.equal(resolveRoomId(qs, null), "room-x");
});

// 값 형식 확인 — Telegram startapp 은 [A-Za-z0-9_-]{1,64} 만 허용한다(공식 문서).
// 우리 roomId 는 huai_rooms.room_id(uuid, gen_random_uuid() 산출)라 소문자 16진수 + 하이픈
// 36자다 — 하이픈이 허용 문자셋에 포함되고 길이도 64 이하라 인코딩 없이 그대로 통과한다.
test("huai_rooms.room_id(UUID) 형식은 Telegram startapp 문자셋·길이 제한을 통과한다(인코딩 불필요)", () => {
  const sampleUuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  assert.equal(sampleUuid.length, 36);
  assert.ok(sampleUuid.length <= 64, "Telegram startapp 64자 제한");
  assert.match(sampleUuid, /^[A-Za-z0-9_-]+$/, "Telegram startapp 허용 문자셋([A-Za-z0-9_-]) 안에 있어야 한다");
});

test("(참고, 회귀 아님) 64자 초과·허용 외 문자 값도 resolveRoomId 자체는 그대로 통과시킨다 — 형식 검증은 이 함수의 책임이 아니다", () => {
  // resolveRoomId 는 "어디서 값을 가져올지"만 정한다. 값 자체가 이상해도(공격 시도 포함)
  // miniapp-tasks/miniapp-proposals 가 huai_room_members 조회로 걸러낸다(존재하지 않는
  // room_id 는 그냥 404/403). 그래서 여기서 형식 검증을 추가하지 않았다 — 서버가 이미
  // 하는 일을 클라이언트가 다시 하면 두 곳의 규칙이 갈릴 위험만 생긴다.
  const tooLong = "x".repeat(100);
  const withSpace = "not a valid room id at all!!";
  assert.equal(resolveRoomId(fakeQs({ room: tooLong }), undefined), tooLong);
  assert.equal(resolveRoomId(fakeQs({ room: withSpace }), undefined), withSpace);
});
