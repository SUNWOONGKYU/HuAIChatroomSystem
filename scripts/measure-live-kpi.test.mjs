import assert from "node:assert/strict";
import test from "node:test";
import { summarizeConcurrency, summarizeFairness } from "./measure-live-kpi.mjs";

// 독립 검증이 반증한 지점: KPI 수치가 세션 안에만 있었고 재현 근거가 없었다.
// 계산 규칙을 여기서 고정해, 나중에 누가 다시 재도 같은 뜻의 숫자가 나오게 한다.

test("같은 순간에 몇 건이 떠 있었는지 센다", () => {
  const result = summarizeConcurrency([
    { type: "started", at: "2026-08-16T06:51:36.351Z" },
    { type: "started", at: "2026-08-16T06:51:36.352Z" },
    { type: "started", at: "2026-08-16T06:51:36.352Z" },
    { type: "started", at: "2026-08-16T06:52:04.294Z" }
  ]);

  assert.equal(result.maxConcurrentStarts, 3);
  assert.equal(result.startCount, 4);
});

test("밀리초가 달라도 같은 초면 동시로 센다", () => {
  // 정확히 같은 밀리초만 동시로 치면 실제 동시 실행을 놓친다.
  const result = summarizeConcurrency([
    { type: "started", at: "2026-08-16T06:51:36.100Z" },
    { type: "started", at: "2026-08-16T06:51:36.900Z" }
  ]);

  assert.equal(result.maxConcurrentStarts, 2);
});

test("시작하지 않은 이벤트는 세지 않는다", () => {
  const result = summarizeConcurrency([
    { type: "accepted" },
    { type: "completed", at: "2026-08-16T06:52:03.926Z" },
    { type: "started", at: "2026-08-16T06:51:36.351Z" }
  ]);

  assert.equal(result.maxConcurrentStarts, 1);
  assert.equal(result.startCount, 1);
});

test("점유 방지는 마지막 시작까지 걸린 시간으로 잰다", () => {
  // 동시성이 꽉 찬 상태에서 뒤에 선 방이 얼마 만에 들어갔는가. 목표는 5분 이내다.
  const submitted = Date.parse("2026-08-16T06:51:31.764Z");
  const result = summarizeFairness(submitted, [
    { at: "2026-08-16T06:51:36.351Z" },
    { at: "2026-08-16T06:52:04.294Z" }
  ]);

  assert.equal(result.lastStartDelaySeconds, 32.5);
});

test("시작한 것이 없으면 수치를 지어내지 않는다", () => {
  assert.equal(summarizeFairness(Date.now(), []), undefined);
});
