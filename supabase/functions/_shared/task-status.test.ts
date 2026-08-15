// task-status.ts 회귀 테스트. 실행 방법은 proposal-payload.test.ts 상단 주석 참고.
//
// 핵심 회귀 대상: mid_approval_pending 은 decidable=false 여야 한다(Telegram 에 이 상태를
// 벗어나는 버튼이 없어서 Mini App 도 결정 버튼을 만들지 않는다 — 팀장님 확정 사항) +
// commander_completion_pending 이 completion_approval_pending 과 같은 결정 성격으로
// 라벨링되는지.
import test from "node:test";
import assert from "node:assert/strict";
import { taskStatusMeta } from "./task-status";

test("mid_approval_pending은 decidable=false이고 안내 hint를 갖는다", () => {
  const meta = taskStatusMeta("mid_approval_pending");
  assert.equal(meta.decidable, false);
  assert.equal(meta.bucket, "needs_decision");
  assert.ok(meta.hint && meta.hint.length > 0, "결정 버튼이 없는 이유를 설명하는 hint가 있어야 한다");
});

test("commander_completion_pending과 completion_approval_pending은 둘 다 decidable=true다", () => {
  assert.equal(taskStatusMeta("commander_completion_pending").decidable, true);
  assert.equal(taskStatusMeta("completion_approval_pending").decidable, true);
});

test("decidable=true인 상태는 hint가 없다(버튼이 있는데 안내문까지 겹치면 혼란)", () => {
  assert.equal(taskStatusMeta("commander_completion_pending").hint, undefined);
  assert.equal(taskStatusMeta("completion_approval_pending").hint, undefined);
});

test("알 수 없는 상태값은 hint 없이 backlog로 안전하게 떨어진다", () => {
  const meta = taskStatusMeta("__unknown_future_status__");
  assert.equal(meta.bucket, "backlog");
  assert.equal(meta.decidable, false);
  assert.equal(meta.hint, undefined);
});
