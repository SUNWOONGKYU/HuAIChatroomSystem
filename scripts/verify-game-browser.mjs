import { spawnSync } from "node:child_process";

const tests = [
  "supabase/miniapp-web/breakout-game.browser-test.mjs",
  "supabase/miniapp-web/egg-crack-sound-game.browser-test.mjs",
  "supabase/miniapp-web/egg-game.browser-test.mjs",
  "supabase/miniapp-web/treasure-collector-runner.test.mjs"
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
