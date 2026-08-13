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
