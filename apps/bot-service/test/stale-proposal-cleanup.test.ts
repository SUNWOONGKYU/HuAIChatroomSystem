import assert from "node:assert/strict";
import test from "node:test";
import {
  createStaleProposalCleanupRunner,
  runStaleProposalCleanupOnce,
  startStaleProposalCleanupLoop
} from "../src/stale-proposal-cleanup.js";

// 결함 회귀 — scripts/cancel-stale-proposals.mjs 는 --apply 를 사람이 직접 쳐야 하는
// 수동 CLI 였고, 어떤 기동·스케줄 경로에도 연결돼 있지 않아 방장이 응답 안 한 제안이
// 영원히 쌓였다(라이브 사례: 한 방 150건 중 9건만 결정). bot-service 가 이걸 주기
// 실행으로 연결했는지 검증한다.

test("정리가 성공하면 onResult 로 결과를 보고한다", async () => {
  const results: Array<{ exitCode: number }> = [];
  await runStaleProposalCleanupOnce({
    async run() {
      return { exitCode: 0, stdout: "정리 완료: 3건", stderr: "" };
    },
    onResult(result) {
      results.push(result);
    }
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.exitCode, 0);
});

test("정리 스크립트 실행 자체가 던져도 bot-service 를 죽이지 않고 onError 로 넘긴다", async () => {
  const errors: unknown[] = [];
  await runStaleProposalCleanupOnce({
    async run() {
      throw new Error("supabase-unreachable");
    },
    onError(error) {
      errors.push(error);
    }
  });

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /supabase-unreachable/);
});

test("주기적으로 실행하고 stop() 이후에는 더 돌지 않는다", async (t) => {
  let calls = 0;
  const handle = startStaleProposalCleanupLoop({
    intervalMs: 5,
    async run() {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
  t.after(() => handle.stop());

  // 즉시 1회 + 주기 실행이 최소 한 번은 더 돌 시간을 준다.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const callsBeforeStop = calls;
  assert.ok(callsBeforeStop >= 2, `주기 실행이 안 돈 것으로 보인다: ${callsBeforeStop}회`);

  handle.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, callsBeforeStop, "stop() 이후에는 더 실행되면 안 된다");
});

test("실행 중 겹치면 다음 tick 을 건너뛴다 — 느린 정리가 쌓이지 않는다", async (t) => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const handle = startStaleProposalCleanupLoop({
    intervalMs: 5,
    async run() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrent -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
  t.after(() => handle.stop());

  await new Promise((resolve) => setTimeout(resolve, 100));
  handle.stop();

  assert.equal(maxConcurrent, 1, "겹쳐 돌면 같은 정리가 동시에 두 번 실행될 수 있다");
});

// createStaleProposalCleanupRunner — cancel-stale-proposals.mjs 를 그대로 자식
// 프로세스로 실행하는지(로직을 복제하지 않고 재사용하는지) 확인한다.
test("실제 스크립트를 --apply 로 자식 프로세스 실행한다", async () => {
  const run = createStaleProposalCleanupRunner({
    cwd: process.cwd(),
    // 진짜 스크립트를 돌리면 Supabase 접속이 필요하다 — 여기서는 인자 전달 방식만
    // 검증하면 되므로, 인자를 그대로 echo 하는 가짜 스크립트로 바꿔 확인한다.
    scriptRelativePath: "apps/bot-service/test/fixtures/echo-args.mjs"
  });

  const result = await run();

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--apply/);
  assert.match(result.stdout, /--reason/);
  assert.match(result.stdout, /bot-service 자동 정리/);
});
