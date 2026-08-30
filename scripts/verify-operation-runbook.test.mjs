import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runbook = readFileSync("_archive/gates/2026_08_10__GATE19_OPERATION_RUNBOOK.md", "utf8");

test("operation runbook covers production startup order", () => {
  for (const required of [
    "node scripts/verify-operation-env.mjs --profile=all",
    "node scripts/generate-supabase-room-seed.mjs",
    "node scripts/generate-telegram-webhook-commands.mjs",
    "node dist/apps/bot-service/src/cli.js",
    "node dist/apps/local-gateway/src/cli.js",
    "GET /healthz",
    "GET /readyz",
    "/newtask",
    "npm run verify:operation-ready"
  ]) {
    assert.equal(runbook.includes(required), true, required);
  }
});

test("operation runbook forbids token exposure and unified bot shortcuts", () => {
  assert.match(runbook, /never a bot token/i);
  assert.match(runbook, /distinct Telegram tokens/);
  assert.match(runbook, /env:\.\.\./);
});

const incidentRunbook = readFileSync("2026_08_12__OPERATION_INCIDENT_RUNBOOK.md", "utf8");

test("incident runbook covers status and repair flow", () => {
  for (const required of [
    "node scripts/operation-status-report.mjs",
    "node scripts/inspect-outbox.mjs",
    "node scripts/repair-button-callback-outbox.mjs",
    "--apply --id <candidate_id>",
    "BUTTON_DATA_INVALID",
    "status=attention",
    "status=down",
    "npm run verify:operation-checks",
    "node scripts/verify-no-secrets.mjs"
  ]) {
    assert.equal(incidentRunbook.includes(required), true, required);
  }
});

test("incident runbook forbids noisy Telegram internals", () => {
  for (const required of [
    "raw JSON",
    "hook logs",
    "stdout/stderr labels",
    "bot tokens or API keys",
    "raw Supabase payloads",
    "internal stack traces"
  ]) {
    assert.equal(incidentRunbook.includes(required), true, required);
  }
});

test("incident runbook covers operation ready timeout guidance", () => {
  for (const required of [
    "OPERATION_READY_STEP_TIMEOUT_MS",
    "npm run verify:operation-ready",
    "operation-ready step-timeout",
    "Inspect the reported Gate first"
  ]) {
    assert.equal(incidentRunbook.includes(required), true, required);
  }
});
