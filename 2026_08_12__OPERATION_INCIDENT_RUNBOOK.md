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
curl http://127.0.0.1:8787/readyz
curl http://127.0.0.1:8797/healthz
curl http://127.0.0.1:8797/readyz
```

`/healthz` only means "the process is up and its config parsed" (bots configured, no live
dependency check) — it can return 200 even when Telegram receive has stopped or Supabase is
unreachable. `/readyz` is the one that means "this service can actually do work right now"; a
200 there is what actually backs "curl 200 = working". Read `/readyz`, not `/healthz`, when
deciding whether the group is really being served.

`GET :8787/readyz` (bot-service, `readiness.ts`/`http.ts`) returns 503 with a JSON body when not
ready:

```json
{ "ok": false, "service": "bot-service", "ready": false, "checks": { "supabase": { "ok": false, "detail": "..." }, "receive": { "ok": false, "mode": "polling", "detail": "stale-poll:125000ms" } } }
```

- `checks.supabase.ok === false`: a live Supabase round-trip failed. Check `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` and whether the Supabase project itself is reachable; `detail` has
  the (secret-redacted) error.
- `checks.receive.ok === false` with `mode: "polling"`: no successful `getUpdates` poll within
  `BOT_SERVICE_READYZ_POLL_STALE_MS` (default 120000ms). `detail: "no-successful-poll-yet"` means
  it never polled successfully since boot; `detail: "stale-poll:<ms>ms"` means the polling loop
  stopped partway through. Restart bot-service.
- `checks.receive.ok === false` with `mode: "webhook"`: either the registered-webhook check
  couldn't run at all (`webhook-check-unavailable`) or Telegram's registered webhook does not
  point at this service (`webhook-not-registered`). Re-run
  `node --env-file=.env.operation.local scripts/apply-telegram-webhooks.mjs --apply`.

`GET :8797/readyz` (local-gateway, `health.ts`) is simpler — it just confirms the configured
Supabase readiness check succeeds, and returns 503 with `{ "ok": false, "ready": false }` (no
per-check breakdown) on failure. Same fix path: check `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
and Supabase reachability.

If either service is down, start or restart the operation services.

```powershell
node scripts/start-operation-services.mjs
```

Then run the first check again.

```powershell
node scripts/operation-status-report.mjs
```

## Database Migration After a Code Update

`supabase db push` (referenced in `GITHUB_RELEASE_CHECKLIST.md`) is the canonical way to apply
migrations, but this repo ships with no `supabase/config.toml`, so a fresh checkout is not
CLI-link-authenticated by default — `supabase db push` will fail until you run `supabase link
--project-ref <ref>` and log in once on that machine. Check which path applies to you before
assuming the CLI just works.

When `git pull` brings in new files under `supabase/migrations/` that are not yet applied to the
running production database (check `git log -- supabase/migrations/` against what you already
ran, or just try the SQL and see if the objects already exist — every migration in this repo is
written with `if not exists` / idempotent guards so re-running an already-applied one is safe):

1. If your machine has the Supabase CLI linked to the project (`supabase link --project-ref
   <ref>` already done, `supabase/config.toml` present, logged in):
   ```powershell
   supabase db push
   ```
2. Otherwise (the common case for this repo — no CLI link, same situation the initial setup in
   `HuAI_설치_및_사용_설명서.md` 4단계 already uses): open each new file under
   `supabase/migrations/` **in filename order** (the timestamp prefix is the apply order) in a
   text editor, copy its full contents, paste into the Supabase Dashboard → SQL Editor → New
   query, and click Run for each one in turn.

After applying, confirm with a quick read-only check (e.g. the specific index/column the
migration added) rather than assuming success from a lack of error — the SQL Editor does report
failures inline, but a partially-pasted file can still "succeed" on the part that got pasted.

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

## Room Backup & Recovery

### What gets backed up, and when

`BOT_SERVICE_ROOM_BACKUP_ENABLED` (default `true` when Supabase env vars are set) makes
bot-service run a background loop every `BOT_SERVICE_ROOM_BACKUP_MS` (default 21600000 ms =
6 hours). Each cycle snapshots every active room's `room`-scoped data (13 tables — tasks,
events, approvals, room members, ai actors, task proposals, task dependencies, message
bindings, agent personas, task reports, artifacts, reports, revision requests) into a JSON
file and records a `huai_recovery_snapshots` ledger row (`snapshot_type='room'`). See
`packages/supabase-runtime/src/room-backup.ts` header for the exact table list and the
tables intentionally **not** covered (`huai_rooms` itself, `huai_telegram_bots`,
`huai_gateway_instances`, `huai_verifications`, and processing/rolling-retention tables).

Snapshot files land under `sessions/rooms/recovery/<roomId>/<capturedAt>.json` on the machine
running bot-service. This is local disk only — if that disk is lost, the snapshots are lost
with it. There is no off-machine copy today.

### Manual backup (operator-triggered)

```powershell
npm run backup:rooms                       # every room in huai_rooms
npm run backup:rooms -- --room <roomId>    # one room only
npm run backup:rooms -- --dry-run          # preview only, writes nothing (disk or DB)
```

`npm run backup:rooms -- --dry-run` prints, per room, the row count for tasks/events/
artifacts/approvals, any `missingTables`, and the checksum it would have written — safe to
run any time to confirm the backup path itself still works without touching production data.

To confirm a snapshot file is intact and internally consistent (checksum match, structural
shape, referential integrity between its own tables) without touching Supabase or disk:

```powershell
node scripts/verify-recovery-snapshot-rehearsal.mjs <snapshotPath> [expectedChecksum]
```

If `expectedChecksum` is omitted, it falls back to a `<snapshotPath>.sha256` sidecar file.

### Recovery procedure

`scripts/restore-room-backup.mjs` restores a room snapshot back into Supabase. It defaults
to dry-run — nothing is written unless `--apply` is passed.

```powershell
# 1. Preview: per-table total/already-existing/new row counts. Writes nothing.
node --env-file=.env.operation.local scripts/restore-room-backup.mjs <snapshotPath> [expectedChecksum]

# 2. Apply for real.
node --env-file=.env.operation.local scripts/restore-room-backup.mjs <snapshotPath> [expectedChecksum] --apply
```

Before touching Supabase, the script always re-runs the same integrity check as
`verify-recovery-snapshot-rehearsal.mjs` (checksum, structure, referential integrity) and
refuses to proceed if it fails.

The restore is idempotent — running it twice against the same snapshot does not create
duplicate rows. Append-only ledger tables (`huai_approvals`, `huai_events` — both reject
`UPDATE`/`DELETE` via a database trigger) are inserted with `ON CONFLICT DO NOTHING`
semantics (skip if already present); the other 11 tables are upserted by primary key, so a
second run just re-applies the same values.

If the snapshot itself is incomplete (`missingTables` is non-empty — some table failed to
fetch at backup time), `--apply` refuses to run and prints which tables are missing, unless
you explicitly pass `--allow-incomplete` (in which case only the tables that were actually
captured are restored, and the script says so loudly, not silently).

### Current limitations (read before relying on this in a real incident)

- **`--apply` has not been exercised against a real production Supabase project.** It has
  only been tested against an in-memory fake store (`scripts/restore-room-backup.test.mjs`).
  Before trusting it in a live incident, a human operator should dry-run it against a
  disposable/staging project first.
- **`huai_verifications` is not backed up at all**, so any `huai_message_bindings` or
  `huai_revision_requests` row that references a `verification_id` can fail to restore with
  a foreign-key error (the script reports this per table rather than hiding it — check the
  `FAIL` lines in its output).
- Snapshots are local-disk only (see above) — losing the machine's disk loses the backups
  too. There is currently no automated off-machine copy of `sessions/rooms/recovery/`.
- The room's own `huai_rooms`/`huai_telegram_bots`/`huai_gateway_instances` rows are not
  part of the snapshot — re-onboard the room first (`scripts/onboard-telegram-room.mjs` or
  `scripts/generate-supabase-room-seed.mjs`) before restoring its data.

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
