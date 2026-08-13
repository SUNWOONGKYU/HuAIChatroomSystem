import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { applyOperationEnvAliases, applyOperationEnvFile, defaultOperationEnvFile, parseOperationEnv } from "./operation-env-loader.mjs";

test("parses operation env comments, quotes, and bare values", () => {
  assert.deepEqual(parseOperationEnv(`
# comment
SUPABASE_URL=https://example.supabase.co
BOT_SERVICE_ROOM_ID="room-1"
LOCAL_GATEWAY_ALLOWED_ROOTS='C:\\Dev\\HuAIChatroomSystem'
invalid-key=value
`), {
    SUPABASE_URL: "https://example.supabase.co",
    BOT_SERVICE_ROOM_ID: "room-1",
    LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem"
  });
});

test("applies local operation env without overriding existing env", () => {
  const dir = mkdtempSync(join(tmpdir(), "huai-env-"));
  const file = join(dir, ".env.operation.local");
  writeFileSync(file, "SUPABASE_URL=https://file.supabase.co\nBOT_SERVICE_ROOM_ID=file-room\n", "utf8");
  const env = { SUPABASE_URL: "https://existing.supabase.co" };

  const result = applyOperationEnvFile(env, file);

  assert.deepEqual(result, { loaded: true, keys: ["SUPABASE_URL", "BOT_SERVICE_ROOM_ID"] });
  assert.equal(env.SUPABASE_URL, "https://existing.supabase.co");
  assert.equal(env.BOT_SERVICE_ROOM_ID, "file-room");
  rmSync(dir, { recursive: true, force: true });
});

test("default local operation env path is under project root", () => {
  assert.equal(defaultOperationEnvFile("C:/Dev/HuAIChatroomSystem").endsWith(".env.operation.local"), true);
});

test("maps SUPABASE_SERVICE_KEY alias to service role key", () => {
  const env = { SUPABASE_SERVICE_KEY: "service-key-value" };

  applyOperationEnvAliases(env);

  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, "service-key-value");
});
