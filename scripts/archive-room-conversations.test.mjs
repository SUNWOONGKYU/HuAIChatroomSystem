import assert from "node:assert/strict";
import test from "node:test";
import { kstDateString, kstDayRange, pendingDates, safeRoomFolder } from "./archive-room-conversations.mjs";

// 하루의 경계는 KST 로 자른다. UTC 로 자르면 한국 시간 자정 전후 대화가 다른 날로 갈려,
// 하루치 백업이 두 파일에 흩어지거나 한쪽이 통째로 빠진다.
test("한국 시간 기준으로 날짜를 가른다", () => {
  // 2026-08-17 00:30 KST = 2026-08-16 15:30 UTC
  assert.equal(kstDateString(new Date("2026-08-16T15:30:00.000Z")), "2026-08-17");
  // 2026-08-16 23:59 KST = 2026-08-16 14:59 UTC
  assert.equal(kstDateString(new Date("2026-08-16T14:59:00.000Z")), "2026-08-16");
});

test("하루 범위는 KST 자정에서 자정까지다", () => {
  const range = kstDayRange("2026-08-17");
  assert.equal(range.fromIso, "2026-08-16T15:00:00.000Z");
  assert.equal(range.toIso, "2026-08-17T15:00:00.000Z");
});

// PC 가 며칠 꺼져 있어도 다음 실행이 밀린 날짜를 전부 따라잡아야 한다. 이게 안 되면
// 그날 데이터는 백업 없이 남고, 나중에 정리 단계가 그걸 지운다.
test("아직 안 내보낸 날짜를 전부 따라잡는다", () => {
  const dates = pendingDates(
    ["2026-08-10", "2026-08-11", "2026-08-11", "2026-08-14", "2026-08-17"],
    ["2026-08-10"],
    "2026-08-17"
  );

  assert.deepEqual(dates, ["2026-08-11", "2026-08-14"]);
});

test("오늘은 내보내지 않는다", () => {
  // 아직 안 끝난 하루를 등재하면, 그 등재를 근거로 나머지 절반이 백업 없이 지워진다.
  assert.deepEqual(pendingDates(["2026-08-17"], [], "2026-08-17"), []);
});

test("이미 등재된 날짜는 다시 내보내지 않는다", () => {
  assert.deepEqual(pendingDates(["2026-08-15", "2026-08-16"], ["2026-08-15", "2026-08-16"], "2026-08-17"), []);
});

test("폴더 이름은 사람이 알아볼 수 있게, 경로로 쓸 수 있게 만든다", () => {
  assert.equal(safeRoomFolder({ purpose: "개인회생신청", room_id: "abc" }), "개인회생신청");
  // 방 이름에 경로 구분자가 들어가면 엉뚱한 폴더가 생긴다.
  assert.equal(safeRoomFolder({ purpose: "DCF/기업가치", room_id: "abc" }), "DCF_기업가치");
  // 이름이 없으면 uuid 라도 쓴다 — 어느 방인지 못 찾는 것보다 낫다.
  assert.equal(safeRoomFolder({ purpose: "", room_id: "abc-123" }), "abc-123");
});
