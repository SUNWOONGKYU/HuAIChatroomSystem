import assert from "node:assert/strict";
import test from "node:test";
import { archivedDates, isTerminalOutboxStatus, PROTECTED_RECENT_TURNS, retentionCutoffIso } from "./prune-archived-rows.mjs";

// 보존 기간은 방장이 60일로 정했다. 실측상 용량 압박이 없어(2주 2MB) 조일 이유가 없고,
// 짧게 잡을수록 "지운 뒤에야 필요했다"는 사고에 가까워진다.
test("보존 기간만큼 지난 시점을 자른다", () => {
  const now = new Date("2026-08-17T00:00:00.000Z");
  assert.equal(retentionCutoffIso(now, 60), "2026-06-18T00:00:00.000Z");
  assert.equal(retentionCutoffIso(now, 1), "2026-08-16T00:00:00.000Z");
});

// 나이만 보고 지우면 아직 못 보낸 메시지가 조용히 사라진다. 재시도 대기 중인 행은
// "오래됐다"가 아니라 "아직 할 일이 남았다"가 맞는 판정이다.
test("보낼 일이 끝난 아웃박스만 지운다", () => {
  assert.equal(isTerminalOutboxStatus("sent"), true);
  assert.equal(isTerminalOutboxStatus("dead"), true);
  assert.equal(isTerminalOutboxStatus("pending"), false);
  assert.equal(isTerminalOutboxStatus("processing"), false);
  assert.equal(isTerminalOutboxStatus("retry_pending"), false);
});

// 삭제 근거는 장부다. "오늘 아카이브가 돌았는가"로 판정하면 작업 PC 가 꺼져 있던 날의
// 데이터가 백업 없이 지워진다 — 텔레그램에서 되가져올 방법이 없으므로 복구 불가능하다.
test("장부에 등재된 날짜만 삭제 대상이 된다", () => {
  const manifests = [
    { archive_date: "2026-06-01", source: "telegram_updates" },
    { archive_date: "2026-06-02", source: "telegram_updates" },
    { archive_date: "2026-06-01", source: "events" }
  ];

  const updates = archivedDates(manifests, "telegram_updates");
  assert.equal(updates.has("2026-06-01"), true);
  assert.equal(updates.has("2026-06-02"), true);
  // 내보내지 않은 날. 아무리 오래돼도 지우면 안 된다.
  assert.equal(updates.has("2026-06-03"), false);

  const events = archivedDates(manifests, "events");
  assert.equal(events.has("2026-06-01"), true);
  assert.equal(events.has("2026-06-02"), false, "표마다 따로 내보내고 따로 지운다");
});

// 소대장이 읽는 창이 40턴이다(supabase-store.ts fetchRecentRoomTurns). 조용한 방은 그 40턴이
// 전부 보존기간 밖일 수 있는데, 그걸 비우면 텔레그램에는 대화가 그대로 보이는데 봇만
// 기억을 잃은 상태가 된다.
test("보호하는 턴 수가 소대장이 읽는 창과 같다", () => {
  assert.equal(PROTECTED_RECENT_TURNS, 40);
});
