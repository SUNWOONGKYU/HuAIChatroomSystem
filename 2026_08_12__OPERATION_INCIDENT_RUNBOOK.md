# HuAI Collab Chatroom System - Operation Incident Runbook

## Purpose

This runbook is for Telegram production operation incidents. Use it when the group stops responding, approval buttons look stuck, output is too noisy, or outbox delivery has dead rows.

## First Check

Run the read-only status report first.

```powershell
node scripts/operation-status-report.mjs
```

Interpretation:

- `status=ok`: bot-service, local-gateway, Telegram updates, and outbox are healthy.
- `status=attention`: services are up, but there are failed updates, dead outbox rows, stale processing rows, or gateway errors.
- `status=down`: bot-service or local-gateway health check failed.

## Service Health

Check the local services.

```powershell
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8797/healthz
curl http://127.0.0.1:8797/readyz
```

If either service is down, start or restart the operation services.

```powershell
node scripts/start-operation-services.mjs
```

Then run the first check again.

```powershell
node scripts/operation-status-report.mjs
```

## Gemini Web Executor Health

Gemini is the third execution engine (`adapter_type=gemini_web`; legacy `antigravity`
rows take the same path). Unlike Claude and Codex it is not a CLI — it drives a logged-in
Gemini tab through the dedicated automation Chrome (CDP port 9222) via
`scripts/gemini-web-adapter.mjs` and the `웹세션-자동화` skill's `session.js`.

Check the bridge from the gateway machine:

```powershell
curl http://127.0.0.1:9222/json/version
echo ping | node scripts/gemini-web-adapter.mjs --timeout 20
```

The adapter prints one classified reason on stderr and exits 1 when it cannot answer.
Act on the reason, not on the raw stack:

| stderr reason | Meaning | Fix |
|---|---|---|
| `gemini-web-cdp-unavailable` | Automation Chrome is not listening on 9222 | Start the automation Chrome (`웹세션-자동화` skill README) |
| `gemini-web-login-required` | Gemini tab lost its session | Log in manually in the automation Chrome; never automate 2FA |
| `gemini-web-submit-failed` | Prompt could not be inserted/submitted | Gemini UI changed — update `session.js` selectors |
| `gemini-web-response-timeout` | No answer within `--timeout` | Retry with a longer timeout; check the tab is not stuck on a dialog |
| `gemini-web-new-response-missing` | Page answered but no new message was detected | Same as submit-failed |
| `gemini-web-session-failed` | Anything else from `session.js` | Read `session.js` stdout JSON (last line) |

Tasks that fail this way land in `huai_execution_attempts` with the reason in `last_error`;
the room receives the failure report as usual. Gemini never edits project files, so a
failed Gemini attempt leaves no partial worktree to clean up.

`node scripts/operation-status-report.mjs` reports `gemini_web cdp=ok|down` when
`LOCAL_GATEWAY_ALLOWED_ADAPTERS` includes `gemini_web`; `down` sets the overall status to
`attention` (Claude/Codex keep running).

## Outbox Diagnosis

Use the outbox inspector before changing any database row.

```powershell
node scripts/inspect-outbox.mjs
```

Common problem kinds:

- `telegram_button_data_invalid`: Telegram rejected inline keyboard callback data. Repair only selected rows after the short callback fix is deployed.
- `stale_processing`: a row stayed locked too long. Requeue only after confirming no sender process is still working on it.
- `missing_executable`: local adapter command is missing. Fix the executable path or safe-mode setting before requeue.
- `process_timeout`: the local task exceeded runtime. Review the task scope or timeout before requeue.
- `telegram_rate_limit`: wait for Telegram retry timing instead of forcing immediate resend.

## BUTTON_DATA_INVALID Repair

Dry-run first.

```powershell
node scripts/repair-button-callback-outbox.mjs
```

Apply only to explicitly selected candidate rows.

```powershell
node scripts/repair-button-callback-outbox.mjs --apply --id <candidate_id>
```

After repair:

```powershell
node scripts/operation-status-report.mjs
```

Do not bulk requeue dead outbox rows without room owner approval. Re-sending old Telegram messages can confuse the project room.

## Telegram Output Rules

Show only human-useful messages in Telegram:

- task proposal
- approval request
- short progress or result
- human-readable failure reason
- audit and final approval request

Do not show internal details in Telegram:

- raw JSON
- hook logs
- stdout/stderr labels
- bot tokens or API keys
- raw Supabase payloads
- internal stack traces

## Verification After Fix

Run these checks after a code or repair-tool change.

```powershell
npm run verify:operation-checks
npm run verify:gateway-result-ingestion
npm run verify:telegram-fetch-sender
node scripts/verify-no-secrets.mjs
npm run build
```

## Full Operation Dry Run

Use a per-step timeout when running the full operation readiness check. This makes the failing or slow Gate visible.

```powershell
$env:OPERATION_READY_STEP_TIMEOUT_MS="120000"
npm run verify:operation-ready
```

If a step prints `operation-ready step-timeout`, do not immediately rerun the same full command with a short timeout. Inspect the reported Gate first, because Windows shell child processes can keep running briefly after a timeout.
