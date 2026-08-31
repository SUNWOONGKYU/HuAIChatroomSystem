import { spawnSync } from "node:child_process";

// 협업 운영센터 본체가 맨 앞이다 — 미니게임은 부속이고, 방장이 실제로 누르는 화면은 이것이다.
//
// 결함(5차 감사) 대응 — scripts/verify-test-reachability.mjs(고아 테스트 방지 메타
// 테스트)가 이 배열을 도달 가능성 그래프의 한 소스로 참조해야 한다. 예전에는 이
// 파일 전체가 import 시점에 바로 실행됐다(가드 없는 top-level 코드) — 그래서 이
// 배열만 읽으려고 import 하면 브라우저 테스트가 실제로 통째로 실행돼 버렸다. 다른
// verify-*.mjs 스크립트들과 같은 "export + import.meta.url 가드" 패턴으로 바꿔,
// 배열은 부작용 없이 조회할 수 있고 실행은 CLI 로 직접 돌릴 때만 일어나게 한다 —
// `npm run verify:game-browser`(node scripts/verify-game-browser.mjs) 동작은 그대로다.
export const tests = [
  "supabase/miniapp-web/index.browser-test.mjs",
  "supabase/miniapp-web/_task-artifacts/breakout-game.browser-test.mjs",
  "supabase/miniapp-web/_task-artifacts/egg-crack-sound-game.browser-test.mjs",
  "supabase/miniapp-web/egg-game.browser-test.mjs",
  "supabase/miniapp-web/_task-artifacts/treasure-collector-runner.test.mjs"
];

function run(file, env) {
  const child = spawnSync(process.execPath, [file], { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true, timeout: 60_000, killSignal: "SIGTERM" });
  return {
    code: child.status ?? 1,
    signal: child.signal,
    error: child.error?.message ?? null
  };
}

function main() {
  const results = [];
  for (const testFile of tests) {
    const result = run(testFile, process.env);
    results.push({ testFile, ...result });
    if (result.code !== 0) break;
  }

  console.log(JSON.stringify({ command: "verify:game-browser", results }));
  process.exitCode = results.every((result) => result.code === 0) && results.length === tests.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
