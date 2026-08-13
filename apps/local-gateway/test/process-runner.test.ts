import assert from "node:assert/strict";
import test from "node:test";
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