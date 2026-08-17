import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeUsageLimitNotice } from "../src/executor.js";
import { buildChildProcessEnv, createNodeProcessRunner } from "../src/process-runner.js";

test("rejects long-running process on timeout", async () => {
  const runner = createNodeProcessRunner();

  await assert.rejects(
    () => runner.run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 25
    }),
    /process-timeout/
  );
});
test("child process env keeps runtime secrets out of adapter processes", async () => {
  const env = buildChildProcessEnv({
    Path: "C:\\Windows\\System32",
    USERPROFILE: "C:\\Users\\home",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    BOT_SERVICE_CODEX_BOT_TOKEN: "123456:telegram-secret",
    LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev"
  });

  assert.equal(env.Path, "C:\\Windows\\System32");
  assert.equal(env.USERPROFILE, "C:\\Users\\home");
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(env.BOT_SERVICE_CODEX_BOT_TOKEN, undefined);
  assert.equal(env.LOCAL_GATEWAY_ALLOWED_ROOTS, undefined);
});
// 라이브 사고 회귀 — 방장이 "코덱스 한도 초과면 클로드에게 시켜야 하지 않나"라고 물은 것이
// 작업이 됐고, ClaudeBot 이 한도 처리 코드를 점검한 보고서를 냈다. 그 본문에 usage limit 이
// 들어 있어서 우리는 "Claude 가 한도에 걸렸다"로 읽었다 — 성공한 실행이 실패로 뒤집혔고,
// Codex 로 넘어갔는데 그쪽은 진짜 한도라 작업이 거기서 끝났다.
test("CLI 가 낸 한도 통보만 한도로 본다", () => {
  // 진짜 통보: 짧고, 초기화 시각을 말한다.
  assert.equal(looksLikeUsageLimitNotice("Claude usage limit reached. Your limit will reset at 3pm."), true);
  assert.equal(looksLikeUsageLimitNotice("You've hit your usage limit. try again at Aug 20th."), true);
});

test("결과물 안에 그 단어가 있는 것은 한도로 보지 않는다", () => {
  const report = [
    "폴백 점검 결과 보고서",
    "",
    "1. shouldFallbackToOtherEngine 는 usage limit / limit reached 문구를 찾는다.",
    "2. 그 판정이 참이면 다른 엔진으로 한 번 재시도한다.",
    "3. 감사 경로도 같은 규칙을 쓰지만 작업자 엔진을 뒤로 미룬다.",
    "4. 세 번째 엔진(antigravity)은 resource exhausted 표현을 함께 본다.",
    "",
    "결론: 코드는 의도대로 동작한다. 추가 조치 없음."
  ].join("\n") + "x".repeat(500);

  assert.equal(looksLikeUsageLimitNotice(report), false, "보고서를 한도 통보로 읽으면 성공한 실행이 실패로 뒤집힌다");
});

test("빈 출력은 한도가 아니다", () => {
  assert.equal(looksLikeUsageLimitNotice(""), false);
  assert.equal(looksLikeUsageLimitNotice("   "), false);
});
