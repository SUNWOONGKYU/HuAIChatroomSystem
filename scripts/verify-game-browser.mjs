import { spawnSync } from "node:child_process";

// 협업 운영센터 본체가 맨 앞이다 — 미니게임은 부속이고, 방장이 실제로 누르는 화면은 이것이다.
const tests = [
  "supabase/miniapp-web/index.browser-test.mjs",
  "supabase/miniapp-web/_task-artifacts/breakout-game.browser-test.mjs",
  "supabase/miniapp-web/_task-artifacts/egg-crack-sound-game.browser-test.mjs",
  "supabase/miniapp-web/egg-game.browser-test.mjs",
  "supabase/miniapp-web/_task-artifacts/treasure-collector-runner.test.mjs"
];

const results = [];
for (const testFile of tests) {
  const result = run(testFile, process.env);
  results.push({ testFile, ...result });
  if (result.code !== 0) break;
}

console.log(JSON.stringify({ command: "verify:game-browser", results }));
process.exitCode = results.every((result) => result.code === 0) && results.length === tests.length ? 0 : 1;

function run(file, env) {
  const child = spawnSync(process.execPath, [file], { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true, timeout: 60_000, killSignal: "SIGTERM" });
  return {
    code: child.status ?? 1,
    signal: child.signal,
    error: child.error?.message ?? null
  };
}
