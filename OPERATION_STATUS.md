# HuAI Collab Chatroom Operation Status

Last verified: 2026-08-31 KST (see the "2026-08-31 KST — Migration application + room backup
evidence" section and, superseding its dry-run-only backup finding, the later "2026-08-31 KST —
Manual live backup executed" section near the bottom for what changed today). Sections in this
file are dated but not always in strict file order — each describes a point-in-time state; when
two sections disagree, the later date wins regardless of position in the file.

This file is the current runtime evidence anchor for Telegram operation status reports.
Do not treat older Gate setup documents as proof that operation is still incomplete.

## Current Operation State

- Product scope wording: 완성 제품 / 정식 운영 버전. Do not call this an MVP.
- Primary UI: Telegram private project group.
- Telegram group is connected to bot-service through polling (`BOT_SERVICE_RECEIVE_MODE=polling`,
  switched from webhook on 2026-08-23 — see that section below for why and how to revert).
- Role bots configured: LeaderBot, ClaudeBot, CodexBot, AuditBot.
- Supabase runtime is connected and used as the central DB.
- bot-service health check passed: `GET /healthz` returned ok with 4 bots and 1 allowed chat.
- local-gateway readiness check passed: `GET /readyz` returned ok and ready.
- Approved Telegram flow has previously passed: webhook command -> proposal -> owner approval callback -> local_gateway outbox `sent`.
- Current outbox inspection needs attention: pending=0, processing=0, retry_pending=0, stale_processing=0, but historical dead outbox rows remain and must not be counted as a clean production state until reviewed.
- Live multi-AI simulation passed on 2026-08-13 KST: mention -> proposal `proposal_3ecbfe73-df7c-4787-ba60-df01df549ba0` -> owner approval callback -> ClaudeBot and CodexBot local-gateway executions -> AuditBot audit execution -> Telegram reports all `sent`; recent outbox problems for the simulation were empty.
- Later live ClaudeBot executions failed because the local Claude Code session reported a usage/session limit. CodexBot still completed, and the Telegram report now shows a human-readable Claude limit message instead of a generic failure.
- Historical dead outbox rows remain from older bugs; treat them as historical unless a new row reproduces the same issue.
- Codex execution is currently usable. Claude executable discovery is not enough for completion; Claude Code must also have an available authenticated session.

## 2026-08-17 KST — Live verification across all four rooms

- Three engines are in use: Claude Code, Codex, Gemini web. Legacy Antigravity (`agy`) records are
  routed to Gemini web for compatibility. A quota-blocked engine hands
  off to another, up to two hops, so each of the three gets one turn. Engines already tried travel
  with the request so a second hop cannot land back on the one that just failed.
- Audits run on an engine other than the worker's. If only the worker's engine remains, the audit
  runs there and the room is told independence is lower than usual.
- Forum topics are first-class: a task records the topic it started in, replies return to that
  topic, and each topic pins its own board scoped to its own tasks.
- Artifacts are delivered, not just recorded. Web output (.html) is deployed to Vercel and opens
  from the board; documents (hwp/xlsx/pdf) are uploaded into the room as files. Debug screenshots,
  test files and session logs are excluded.
- Reports longer than 300 characters go to the room as a preview with a 전문 보기 button; the full
  text lives in `huai_task_reports`, which the 60-day cleanup does not touch.
- Room memory: each day's conversation is archived (Supabase Storage + local jsonl, with a manifest
  row) and distilled into `sessions/rooms/<room>/<date>_위키.md`. Leader planning reads the last
  five days; audits read the last week's recurring findings.
- Nightly job at 00:10 (`HuAI-NightlyRoomArchive`) archives and distills with `--apply` and runs the
  prune as a dry-run only. No rows have been deleted yet.
- Verified by execution, not inspection: all four rooms (dev, 개인회생, 상증세법, DCF) wrote files to
  their own folders; a breakout game was built, deployed and passed a headless browser run covering
  paddle control, brick collision, score and sound.

Known gaps as of this update:

- Gemini web has no Telegram bot of its own; its messages are sent under ClaudeBot's account while
  the text identifies the Gemini web engine.
- Gemini web is response-only and cannot edit local files. File-changing work remains on Claude
  Code or Codex; Gemini is suitable for plans, reviews, and textual results.
- bot-service and local-gateway must share a machine: room memory reading and document upload both
  use the local disk.
- The 60-day prune has never been run with `--apply`; nothing is old enough yet.

## Latest Code Verification Update

- 2026-08-13 KST update: workflow actor context is now wired into Supabase task transitions, self-verification is blocked by tests, terminal task states are protected from late execution-failure pollution, approved Telegram proposals materialize into `huai_tasks`, and Telegram fetch sender uses AbortSignal timeout.
- 2026-08-13 KST update 2: `/tasks`, `/task <id>`, and `/search <단어>` now read `huai_tasks` through Supabase-backed Telegram query hydration. DAG blocking dependencies defer local-gateway leasing, AuditBot pass results persist in `huai_verifications`, and long human-visible reports preserve up to 3200 characters while filtering internal logs.
- 2026-08-13 KST update 3: `/trace <task_id>` now exports task event names/times, artifact URI/version/final state, and verification verdict/history directly to Telegram. Raw event payloads are excluded and sensitive URI query secrets are redacted.
- 2026-08-13 KST update 4: LeaderBot now separates informational questions from execution requests. Question-style mentions answer directly without proposal buttons; explicit work instructions still create proposals.

## Full Scope Verification Result

The original Gate 1 and Telegram transition specifications are not fully implemented yet.

- `npm run verify:operation-ready` passed on 2026-08-13 KST.
- Live runtime checks show bot-service/local-gateway are connected, but current operation status is `attention`.
- The core Telegram approval -> local gateway execution path exists.
- Full product acceptance is still blocked by incomplete coverage for scoped verification/reverification, backup/restore proof, live Telegram acceptance, and remaining workflow acceptance coverage.
- Therefore the system must be reported as "core operation path working, full original specification not yet complete."

## Latest Fixes Verified On 2026-08-13

- Telegram proposal buttons remain compact text: `실행`, `수정`, `반려`.
- Completion buttons: superseded on 2026-08-23. Completion is now decided in the Mini App board, whose
  `FINAL_APPROVAL_ACTIONS` are `승인` (final_approve) and `보완 요청` (request_revision) only. The older
  in-room three-button keyboard (`검증`, `보완`, `완료` via `buildCompletionKeyboard`) is no longer wired
  into any production path.
- Multi-AI collaboration requests are now routed as `multi_ai_review` when the request mentions Claude/Codex/Audit collaboration or asks for improvement review.
- The user phrase `추가로 개선할 사항을 찾는 작업이다` was live-smoke tested through the Telegram webhook path and stored as `intent=multi_ai_review`.
- Multi-AI approval no longer starts AuditBot before ClaudeBot/CodexBot results exist. ClaudeBot and CodexBot are queued first.
- After both ClaudeBot and CodexBot gateway results exist for the same multi-AI attempt, one AuditBot local-gateway audit is queued idempotently.

## Known Historical Failures

Older Telegram messages may show `process-timeout`, `spawn EINVAL`, `spawn claude ENOENT`, Windows `os error 206`, premature AuditBot `판정 보류`, or old button labels. Treat those as historical unless reproduced by a new task after this verification.

## 2026-08-23 KST — Grok Bot benchmark items closed out (from sessions/wiki 2026-08-22 note)

That note listed two pending items ("HuAI 반영 예정 안건"). Both are now resolved:

- **Grok Phase1 (approval gate before Vercel production deploy)** — was genuinely missing, now built.
  `artifact-publisher.ts` deploys web artifacts as Vercel *previews* only (no `--prod`); a new poller
  (`apps/local-gateway/src/artifact-promotion.ts`) promotes the preview to production only after
  `huai_tasks.status` reaches `completed` (i.e. the owner's final approval), regardless of whether
  that approval came through the Telegram button or the Mini App. One-time backfill: 226 pre-existing
  artifact rows (already live before this feature existed) were marked `is_final=true` so the new
  poller only ever acts on artifacts created from now on.
- **Grok Phase2 (AC-06 DAG partial wait — block only dependent follow-ups, let unrelated work proceed)**
  — turned out to already be implemented and live (`isTaskRunnable` / `leasePendingLocalGateway` in
  `packages/supabase-runtime/src/index.ts`, present since at least the 2026-08-13 GitHub-release
  commit): each leased outbox row is checked against `huai_task_dependencies` independently, so a
  blocked task alone gets deferred (`retry_pending`/`waiting-dependencies`) while unrelated ready tasks
  in the same lease batch still go out. The 2026-08-22 note calling this "미구현" was inaccurate — it
  compared against Grok without first checking HuAI's own code. Added a regression test
  (`apps/local-gateway/test/supabase-outbox-store.test.ts`, "한 배치 안에서 막힌 작업만 대기하고
  무관한 작업은 그대로 진행한다") to pin this down going forward; no production code change was needed.

## 2026-08-23 KST — Third Grok Bot item found and closed: approval-category split

The 2026-08-22 note only listed 2 action items but described 5 Grok characteristics total. Checking
the other 3 against HuAI's actual code (not just the note's claims): bot count (4, already matches
Grok's 2-6 range), memory-original-reference (already satisfied — raw daily archive is kept alongside
the distilled summary), tool hierarchy (not applicable — that's internal to the underlying Claude/Codex
CLI, not something HuAI's orchestrator controls) were fine. But **approval-category split (필수승인/
자동허용)** was a real, unflagged gap: every proposal required an explicit owner click to start,
regardless of risk — Grok separates mandatory-approval actions from auto-allowed ones.

Built and shipped:
- `LeaderPlan.mutatesFiles: boolean` (`packages/orchestrator/src/leader-planning.ts`) — the leader-
  planning LLM call now also outputs `MUTATES: yes|no`. Parsing defaults to `true` (approval required)
  whenever the field is missing, empty, or anything other than exactly "no" — the safe default is
  *less* automation, never a silently-skipped approval.
- `emitLeaderProposal` (`packages/supabase-runtime/src/index.ts`) still always posts the proposal card
  and 실행/수정/반려 buttons — nothing was removed. When `mutatesFiles === false`, it *additionally*
  inserts a `huai_approvals` row (`stage: task_approval, decision: approved, reason: "auto-allowed: ..."`)
  attributed to the original requester. `miniapp-decision-poller.ts` — which already watches
  `huai_approvals` for both Telegram-button and Mini-App decisions and replays them through the exact
  same `applyOwnerCallback` path — picks this row up on its own and enqueues execution exactly as if
  the button had been clicked. No new execution-trigger code was written (0 복제 principle preserved).
- Safety property: because the replay goes through the same authorization check as a real button click,
  auto-allow can never grant a requester permission they didn't already have — it only skips the click
  for someone who *would already have been allowed to click it*. If the read-only classification turns
  out to be wrong, or the requester lacks approve permission, the row is just ignored
  (`skipped_unauthorized`) and the normal button remains the fallback.
- Tests: `packages/orchestrator/test/leader-planning.test.ts` (MUTATES parsing, safe-default behavior)
  and `packages/supabase-runtime/test/leader-planning-result.test.ts` ("파일을 안 바꾸는 작업은 승인
  카드와 함께 자동승인 행도 남긴다" / "파일을 바꾸는 작업(기본값)은 자동승인 행을 남기지 않는다").
  Full `verify:operation-ready` passes.

## 2026-08-23 KST — Telegram receive mode switched to polling

- `BOT_SERVICE_RECEIVE_MODE=polling` (`.env.operation.local`). bot-service pulls updates via
  `getUpdates` instead of a webhook — no public URL/tunnel needed at all.
- Why: the webhook path depended on a `cloudflared` quick tunnel (`trycloudflare.com`), which
  silently died for days without anyone noticing (all 4 bot webhooks went `url:""`, task approval
  from the room stopped working). Quick tunnels have no uptime guarantee and rotate URL on every
  restart — polling has no such external dependency, so this class of outage can't recur.
  A watchdog (`scripts/webhook-watchdog.mjs` + a 5-min scheduled task) was built as the first fix,
  then removed once polling turned out to be the better permanent answer (`maybeStartTelegramPolling`
  in `apps/bot-service/src/server.ts` already had this mode built in, just not enabled).
- The webhook path still works if ever needed again — nothing was deleted, just turned off:
  1. Remove/change `BOT_SERVICE_RECEIVE_MODE=polling` in `.env.operation.local` (default is `webhook`).
  2. Start a tunnel: `cloudflared tunnel --url http://127.0.0.1:8787` (or a stable named tunnel).
  3. Set `BOT_SERVICE_PUBLIC_BASE_URL` to that URL, then `node --env-file=.env.operation.local scripts/apply-telegram-webhooks.mjs --apply`.
  4. Restart operation services (`scripts/restart-operation-services-from-live-env.mjs`).
  5. Optional safety net: re-register the watchdog task the same way it was built this session
     (`webhook-watchdog.mjs` on a 5-min Windows scheduled task) — but note it actively conflicts
     with polling mode (setting a webhook silently stops `getUpdates`), so only run one mode at a time.

## Required Reporting Rule

When asked for current project progress, first report the verified live-operation state above, then distinguish remaining product-development work from already connected runtime infrastructure.

## 2026-08-28 KST — Documentation and verification baseline

- User-facing name is `협업 운영센터`. The legacy pinned room-board message is no longer generated; cleanup is explicit and narrow through `scripts/remove-room-board-message.mjs --apply`.
- Telegram is limited to instructions, intake, progress/result notifications, and links. Approval, revision, and cancellation are Mini App-only. `/center` preserves the current `roomId` and forum `threadId`.
- Roles remain separated: LeaderBot plans/routes, ClaudeBot/CodexBot execute, Gemini web provides response-only plan/review/text through `GEMINI_WEB_SESSION_SCRIPT`, and AuditBot independently verifies. Legacy Antigravity/agy values normalize to Gemini web because the CLI has lower usage limits and compatibility constraints.
- Quiz policy is risk-based: only high-risk deploy/delete/permission-auth/env-secret/important-setting/DB-schema changes get the existing three-question gate. Read/analyze/explain/review and simple low-risk file changes create no quiz rows.
- Synthetic planning test: `apps/bot-service/test/synthetic-leader-planning-webhook.test.ts`; run after `npm run build` with `node --test dist/apps/bot-service/test/synthetic-leader-planning-webhook.test.js`. It uses fake webhook transport/fetch, room-local users 5001 and 9001, and never writes Telegram/Supabase operations data.
- Game test caveat: local start/keyboard/drag/collision/restart/responsive checks passed for `star-dodge-game-v2.html`; 30-second survival used a test hook and the public-URL browser click journey remains unverified in the test environment.

## 2026-08-30 KST — Documentation reconciliation

This pass was documentation-only (no `apps/**`/`packages/**` source changes); it does not by
itself change what the system can do, only whether the docs describe it correctly.

- `.env.operation.example` was audited against every `process.env.*`/`env.*` read across
  `apps/`, `packages/`, `scripts/` and brought fully up to date. Beyond the round's new knobs
  (`HUAI_LOG_MAX_BYTES`/`HUAI_LOG_MAX_BACKUPS`, `BOT_SERVICE_STALE_PROPOSAL_CLEANUP_ENABLED`/`_MS`,
  `BOT_SERVICE_READYZ_POLL_STALE_MS`, `LOCAL_GATEWAY_ARTIFACT_DEPLOY_TIMEOUT_MS`/
  `_PROMOTE_TIMEOUT_MS`), the audit found and fixed two pre-existing template defects:
  - `LOCAL_GATEWAY_ID` — required for local-gateway to boot in Supabase mode
    (`requiredEnv` in `supabase-store.ts`) — was missing from the template entirely even though
    a later comment in the same file already referred to it as if it were documented above.
  - The template documented `BOT_SERVICE_LISTEN_PORT`/`BOT_SERVICE_LISTEN_HOST`, but
    `server.ts` only ever reads `BOT_SERVICE_PORT` and the listen host is hardcoded to
    `127.0.0.1` — the two old names did nothing. This mismatch had already been flagged in an
    earlier session's notes but was never corrected until now.
  - `node --test scripts/verify-operation-env-template.test.mjs scripts/verify-operation-env.test.mjs
    scripts/verify-lease-formula-drift.test.mjs` passes (22/22) against the updated file.
- bot-service's `/readyz` (port 8787) — added this round in `readiness.ts`/`http.ts` — is now
  covered in `2026_08_12__OPERATION_INCIDENT_RUNBOOK.md` and `GITHUB_QUICKSTART.md`, including
  what `checks.supabase`/`checks.receive` mean on a 503 and the `/healthz` vs `/readyz` role
  split. It was previously undocumented; only local-gateway's `/readyz` was covered.
- Added a "Database Migration After a Code Update" runbook section: `supabase db push` is the
  canonical command (already referenced in `GITHUB_RELEASE_CHECKLIST.md`), with the SQL-Editor
  fallback for machines where the CLI isn't link-authenticated (no `supabase/config.toml` in
  this repo by default) — this repo had zero documentation of how an already-running instance
  picks up a new file under `supabase/migrations/` before today.
- Fixed dead paths in `docs/실전_게임개발_테스트_결과.md` pointing at the pre-move
  `supabase/miniapp-web/treasure-collector-runner.*` location; the files live under
  `supabase/miniapp-web/_task-artifacts/` now. Swept the other live docs (README, both
  QUICKSTART/RELEASE/설치 docs, this file, the incident runbook, `docs/*.md`) for the same class
  of dead reference from the `_archive/gates/`/`_task-artifacts/` moves — no other dead paths
  found; every other file path referenced in those docs was checked to exist.
- Mini App UX: the proposal-stage "수정" button now carries a static one-line caption ("사유는
  자동 전달되지 않으니 Telegram 방에 직접 말씀해주세요") next to the button itself, not just in
  the after-click toast, so the difference from the completion-stage "보완 요청" (which does
  deliver its reason to the orchestrator) is visible before the owner clicks. The label itself
  was kept as "수정" to stay aligned with the Telegram room's own proposal keyboard
  (`buildProposalKeyboard`), per the prior explicit decision recorded in `index.html`. All 8
  `supabase/miniapp-web/reason-input.test.mjs` cases still pass.

**Note on a concurrent workstream, checked at the end of this pass:** while this documentation
pass was in progress, a separate, concurrent workstream (room-backup automation —
`scripts/create-room-backup.mjs`, `packages/supabase-runtime/src/room-backup.ts`,
`scripts/verify-recovery-snapshot-rehearsal.mjs`) was mid-edit and briefly left `npm run
verify:all` failing at the build step (`Cannot find name 'maybeStartRoomBackup'`). Re-running
`npm run verify:all` after that workstream finished shows a full pass (`operation-ready passed`,
~150s), including its own `verify:room-backup` gate. This documentation pass did not touch that
workstream's code and cannot itself vouch for what "backup/restore proof" now covers — a
production backup/restore rehearsal claim should still come from that workstream's own report,
not from this one.

## 2026-08-31 KST — Migration application + room backup evidence

This section records only what was actually run/observed this pass, not restated claims.

### Database migrations

Three migration files exist in `supabase/migrations/`:

- `20260829090000_huai_missing_fk_indexes.sql` — adds 5 missing indexes on FK columns
  (`huai_verifications.task_id`, `huai_events.room_id`/`task_id`,
  `huai_message_bindings.task_id`/`room_id`) that previously forced sequential scans on
  per-room/per-task lookups.
- `20260829100000_huai_gateway_allowed_adapters_check.sql` — adds
  `huai_gateway_instances_allowed_adapters_check` (`NOT VALID`), constraining
  `allowed_adapters` to the 4 known adapter types (`claude_code`/`codex`/`gemini_web`/
  `antigravity`) at the DB layer, closing a gap where `LOCAL_GATEWAY_ALLOWED_ADAPTERS` was
  written unvalidated by `scripts/room-seed-derivation.mjs`.
- `20260830000000_validate_huai_gateway_allowed_adapters_check.sql` — promotes that
  constraint from `NOT VALID` to fully validated (`VALIDATE CONSTRAINT`), after the migration's
  own comment records that all 5 existing `huai_gateway_instances` rows were checked and found
  compliant.

Their *live application to the production Supabase project* was confirmed in a separate
verification pass this round (`supabase migration list` showing Local=Remote match, plus a
direct `pg_indexes`/`pg_constraint.convalidated=true` read against the live database). This
session could not independently re-run that same catalog check — `supabase migration list`
timed out in this sandbox without output (direct Postgres port access appears blocked here even
though HTTPS to Supabase's REST API works fine, confirmed below) — so this paragraph is citing
that separate verification's result, not re-deriving it.

### Room backup automation

Ran the real manual backup CLI against the live production Supabase project, dry-run only (no
writes):

```
node --env-file=.env.operation.local scripts/create-room-backup.mjs --dry-run
```

Output confirmed all 5 active rooms are readable with correct per-table counts and no
`missingTables`, e.g. `room=9a477b32-... tasks=58 events=798 artifacts=221 approvals=194
missingTables=none checksum=964c86b3...`. This proves the backup query/serialization path works
against real data.

What this does **not** prove: whether the *automated* 6-hour scheduler
(`BOT_SERVICE_ROOM_BACKUP_ENABLED`/`maybeStartRoomBackup` in `apps/bot-service/src/server.ts`)
has ever actually run unattended in production. A direct read of
`huai_recovery_snapshots?snapshot_type=eq.room` returned zero rows — no automated room snapshot
has been recorded yet. `node scripts/operation-status-report.mjs` also shows both `bot_service`
and `local_gateway` as `down` at the time of this check, so the scheduler is not currently
running in this session's environment. Status: backup automation is code-complete and manually
dry-run-verified against production data; it has not yet been observed completing a real
scheduled run end-to-end. Do not report this as "backup automation confirmed running" until a
`huai_recovery_snapshots` row with `snapshot_type='room'` is actually observed after bot-service
has been up for a full `BOT_SERVICE_ROOM_BACKUP_MS` interval.

### Room recovery (restore)

A restore path (`scripts/restore-room-backup.mjs`) now exists alongside the backup path — see
"Room Backup & Recovery" in `2026_08_12__OPERATION_INCIDENT_RUNBOOK.md` for the operator
procedure and its documented limitations. It defaults to dry-run and has only been tested
against an in-memory fake Supabase store (`scripts/restore-room-backup.test.mjs`, 12/12 passing)
— it has deliberately not been run with `--apply` against any real Supabase project, production
or otherwise, in this pass.

## 2026-08-31 KST — Manual live backup executed (5차 감사 대응); supersedes "zero rows" above

The "Room backup automation" section above was dry-run only and explicitly said not to report
backup automation as confirmed until a `huai_recovery_snapshots` row with `snapshot_type='room'`
was actually observed. That has now happened — this section records the real (non-dry-run) run
and what it does and does not prove.

**What was run** (real writes, not dry-run):

```
npm run backup:rooms
```

Result: all 5 active rooms backed up successfully (`성공 5건, 실패 0건`). Per-room evidence,
each independently confirmed after the run:

| room_id (short) | tasks | events | artifacts | approvals | file written | `huai_recovery_snapshots` row |
|---|---|---|---|---|---|---|
| 9a477b32 | 58 | 798 | 221 | 194 | `sessions/rooms/recovery/9a477b32.../2026-08-31T06-46-52-981Z.json` | `3c1028df-...` |
| 8d6c738b | 2 | 22 | 1 | 2 | `.../8d6c738b.../2026-08-31T06-46-53-884Z.json` | `41a4f819-...` |
| 61aa6200 | 10 | 78 | 46 | 13 | `.../61aa6200.../2026-08-31T06-46-54-758Z.json` | `f9548799-...` |
| 847d1638 | 1 | 19 | 8 | 1 | `.../847d1638.../2026-08-31T06-46-55-569Z.json` | `32c85c5d-...` |
| ba26dd59 | 4 | 33 | 0 | 8 | `.../ba26dd59.../2026-08-31T06-46-56-379Z.json` | `7ccc4c13-...` |

Verification steps actually performed, all against the live production Supabase project:

1. **Files exist**: `find sessions/rooms/recovery -name "*.json"` shows all 5 new files above.
2. **DB rows exist**: a direct REST read of
   `huai_recovery_snapshots?snapshot_type=eq.room&order=created_at.desc` returned exactly these
   5 new rows (checksums matching the CLI output). This is the first time `snapshot_type='room'`
   rows have ever existed in this project.
3. **Rehearsal passed for all 5**: `node scripts/verify-recovery-snapshot-rehearsal.mjs <path>
   <checksum>` printed `OK ... missingTables=none` for every room — checksum match and
   in-snapshot referential integrity both hold on real data, not just fixtures.
4. **Restore dry-run passed for the largest room** (9a477b32, the 798-event room):
   `node --env-file=.env.operation.local scripts/restore-room-backup.mjs <path> <checksum>`
   (no `--apply`) printed a full per-table preview, `new=0` on every table because the snapshot
   was taken from the same live data it was previewed against — i.e. the restore plan the tool
   would execute matches reality exactly. `--apply` was never run in this pass.

**What this still does not prove** (the distinction the section above was already careful about,
and remains true): this was a manual operator CLI run (`backup:rooms`, `created_by:
"operator-cli"`), not the unattended 6-hour scheduler (`maybeStartRoomBackup` /
`room-backup-scheduler.ts`) completing a cycle on its own. bot-service was not confirmed running
continuously for a full `BOT_SERVICE_ROOM_BACKUP_MS` interval during this check. Do not report
this as "the automated scheduler has been observed running" — report it as "the backup code path
now has direct live evidence of working end-to-end (query → serialize → write file → write
ledger row → pass integrity rehearsal → restore plan matches reality), executed manually."

**Also fixed this pass** (결함, 4차 독립 평가 지적 대응, in `packages/supabase-runtime/src/room-backup.ts`
and `scripts/restore-room-backup.mjs`):

- `huai_recovery_snapshots` rows for `snapshot_type='room'` are now pruned automatically to the
  same per-room cap as the on-disk files (`HUAI_ROOM_BACKUP_MAX_SNAPSHOTS`, default 240),
  immediately after each successful snapshot write — no `--apply`-style human gate, on the same
  reasoning as the file-level prune (a newer snapshot always supersedes it; not a sole copy of
  irrecoverable data). Confirmed live: the 5 runs above each triggered a row-prune check (no-op
  this time, since each room had 0-1 prior room-type rows, well under the cap of 240).
- `scripts/restore-room-backup.mjs --apply` no longer writes on the flag alone. It first prints
  the target project URL, room id, and per-table row counts, then requires typing exactly `yes`
  at a terminal prompt; `--yes` skips the prompt for CI/automation. In a non-interactive shell
  (no TTY) without `--yes`, it now prints the same summary and declines immediately
  (`취소됨 — 아무 것도 쓰지 않았다.`, exit code 1) instead of hanging — verified live in this
  pass by running `--apply` without `--yes` against the real project: it showed the summary and
  declined without writing anything.

## 2026-08-31 KST — 스케줄러 무인 실행과 복구 쓰기 경로, 라이브 실증

이 절 이전까지 이 문서는 두 가지를 미검증으로 남겨두고 있었다. 둘 다 이번에 실제 운영
프로젝트에 대고 실행해 해소했고, 근거를 그대로 적는다.

**1. 무인 스케줄러가 스스로 백업을 남긴다 — 검증됨**

이전 증거는 운영자가 손으로 돌린 `npm run backup:rooms` 1회뿐이었고, 그래서 위 절은
"코드 경로가 동작한다는 증거일 뿐, 스케줄러가 도는 것을 관측한 건 아니다"라고 스스로
선을 그어뒀다. 이번에 `server.ts` 의 `maybeStartRoomBackup` 과 **동일한 배선**
(`startRoomBackupLoop` + `listRoomIdsFromSupabase` + `createRoomBackupRestClient`)을
주기만 15초로 줄여 사람 개입 없이 돌렸다. 3주기 동안 5개 방 × 3 = 15건 전부 성공했고,
`huai_recovery_snapshots` 에 `created_by='bot-service-auto'` 로 15행이 남았다
(수동 실행분 `operator-cli` 5행과 구분됨. 조회 시점 room 타입 총 20행).

주기 값만 다를 뿐 실행 경로는 운영과 같다. 즉 bot-service 가 떠 있으면 자동 백업이
실제로 돈다는 것이 이제 관측된 사실이다.

**2. `restore-room-backup.mjs --apply` 의 실제 쓰기 경로 — 검증됨**

이전까지는 확인 게이트의 *거부* 경로만 프로덕션에서 확인됐고 실제 쓰기는 in-memory
fake store 테스트뿐이었다. 이번에 가장 작은 방(`8d6c738b`)의 스냅샷으로 실제 실행했다.

먼저 dry-run 으로 13개 테이블 전부 `new=0`(모든 행이 이미 존재)임을 확인했다 — 즉
적용해도 동일 값 upsert 라 데이터가 바뀌지 않는 상태에서만 실행했다. 결과 14/14 단계
성공했고, 순환 FK 2-pass(`huai_tasks` 1차 승인 FK 해제 → `huai_events`/`huai_approvals`
삽입 → 2차 승인 연결 복원)도 로그상 실제로 수행됐다.

적용 전후를 직접 대조했다. room-scoped 10개 테이블 행 수가 전부 동일했고
(`huai_room_members` 1, `huai_ai_actors` 4, `huai_task_proposals` 1, `huai_events` 22,
`huai_approvals` 2, `huai_task_dependencies` 0, `huai_agent_personas` 0,
`huai_task_reports` 3, `huai_tasks` 2, `huai_message_bindings` 0), `huai_tasks` 2건의
`status` 와 `approved_by_approval_id` 가 스냅샷 값과 정확히 일치했다 — 2-pass 가 승인
연결을 null 로 남기지 않고 원래대로 복원했다는 뜻이다.

**남은 한계 (과장하지 않기 위해 명시)**: 이 실행은 "이미 존재하는 행을 같은 값으로
다시 쓰는" 경로만 증명한다. 실제로 데이터가 소실된 방에 대해 `new>0` 인 상태로
복원해 되살리는 시나리오는 아직 실행된 적이 없다. 그 검증에는 데이터를 지웠다
되살리는 파괴적 리허설이 필요하고, 운영 방에서 할 일이 아니다.

**부수 발견과 그 수정**: 백업이 체크섬을 DB(`huai_recovery_snapshots.checksum`)에만
기록하고 `.sha256` 사이드카를 만들지 않아, 복구 스크립트가 사이드카가 없으면 체크섬을
인자로 요구했다. 위 복구 검증에서도 DB 에서 체크섬을 꺼내 넘겨야 했다 — 정작 복구가
필요한 상황(DB 손상·접근 불가)에서는 복구를 시작조차 못 한다는 뜻이라 그 자리에서
고쳤다. `writeRoomBackupSnapshotToDisk` 가 스냅샷 옆에 `.sha256` 을 함께 쓰고,
정리(prune)가 스냅샷과 사이드카를 짝지어 지운다(사이드카만 남아 쌓이지 않게).

라이브 확인: 사이드카 도입 후 `npm run backup:rooms` 재실행(5/5 성공) → 방마다
`.sha256` 생성 확인 → 체크섬 인자 **없이** 스냅샷 경로만으로 복구 dry-run 이 정상
동작하는 것 확인. 사이드카 값이 같은 실행이 DB 에 기록한 checksum 과 일치함도 대조했다.
DB 기록은 그대로 유지한다 — 둘이 어긋나면 그 자체가 변조·손상 신호다.

## 2026-08-31 KST — 파괴적 복구 리허설: `new>0` 시나리오 실증 (전용 테스트 방)

바로 위 절이 "남은 한계"로 명시했던 것 — `new>0`(실제 데이터 소실) 시나리오가 한 번도
검증된 적이 없다는 지적 — 을 이번에 해소했다. 운영 5개 방(9a477b32/8d6c738b/61aa6200/
847d1638/ba26dd59)은 조회 외에 전혀 건드리지 않았다. 별도의 전용 테스트 방을 새로
만들어 그 방 안에서만 파괴적 삭제·복구를 실행했다.

**테스트 방**: `16966452-fbb6-43b6-bbd7-5bbb87ca525a` (telegram_chat_id 는 운영 5개
방의 값과 겹치지 않는 임의의 테스트용 값으로, 사전 조회로 중복 없음을 확인 후 사용
— purpose 에 `[REHEARSAL-TEST...]` 로 식별 가능하게 표시). `scripts/onboard-telegram-room.mjs` 는
쓰지 않고 REST API로 직접 최소 행만 심었다 — 그 스크립트는 운영 4개 봇과 공유되는
`huai_telegram_bots` 테이블까지 건드려 이 리허설 목적에는 불필요한 위험이었다.

**심은 데이터** (백업 대상 13개 테이블 전부, `huai_tasks.approved_by_approval_id` ↔
`huai_approvals.task_id` 순환 FK 포함): huai_room_members 1, huai_ai_actors 2,
huai_task_proposals 1, huai_tasks 2, huai_task_dependencies 1, huai_approvals 2,
huai_events 2, huai_agent_personas 1, huai_task_reports 1, huai_artifacts 1,
huai_reports 1, huai_revision_requests 1, huai_message_bindings 1.

**절차와 결과**:

1. `npm run backup:rooms -- --room 16966452-...` 로 스냅샷 생성, `.sha256` 사이드카
   확인, `verify-recovery-snapshot-rehearsal.mjs` 로 무결성 통과(`missingTables=none`).
2. 삭제 전 dry-run: 13개 테이블 전부 `new=0`.
3. **1라운드(부분 삭제)**: huai_artifacts/huai_reports/huai_revision_requests/
   huai_message_bindings/huai_task_reports/huai_agent_personas 6개 테이블 삭제 →
   dry-run 재확인(삭제한 6개만 `new=1`, 나머지 7개는 `new=0`) → `--apply --yes` →
   14/14 단계 성공. 삭제된 6개 테이블이 원래 값(UUID 포함) 그대로 복원됐음을 직접
   조회로 확인 — `huai_message_bindings` 의 event_id/task_id/proposal_id/approval_id/
   report_id 참조까지 전부 원래 값과 일치.
4. **2라운드(전면 삭제)**: 나머지 삭제 가능한 테이블(huai_room_members/huai_ai_actors/
   huai_task_proposals/huai_task_dependencies + 1라운드에서 되살아난 6개, 총 10개)을
   전부 삭제. `huai_tasks` 의 `proposal_id`/`assignee_actor_id` 는 삭제 전에 UPDATE 로
   null 처리해뒀다. dry-run → 정확히 그 10개 테이블만 `new>0`(모두 total 과 동일),
   나머지 3개(huai_tasks/huai_approvals/huai_events)는 `new=0`. `--apply --yes` →
   14/14 단계 성공.
5. **복구 후 검증표** (스냅샷 대비 실제 DB, 2라운드 기준):

| 테이블 | 스냅샷 건수 | 복구 후 실제 건수 | 비고 |
|---|---|---|---|
| huai_room_members | 1 | 1 | 일치 |
| huai_ai_actors | 2 | 2 | 일치 |
| huai_task_proposals | 1 | 1 | 일치 |
| huai_task_dependencies | 1 | 1 | 일치 |
| huai_events | 2 | 2 | 애초에 삭제 불가(append-only) — 변화 없음, 중복 없음 |
| huai_approvals | 2 | 2 | 애초에 삭제 불가(append-only) — 변화 없음, 중복 없음 |
| huai_agent_personas | 1 | 1 | 일치 |
| huai_task_reports | 1 | 1 | 일치 |
| huai_artifacts | 1 | 1 | 일치 |
| huai_reports | 1 | 1 | 일치 |
| huai_revision_requests | 1 | 1 | 일치 |
| huai_message_bindings | 1 | 1 | 일치 |
| huai_tasks | 2 | 2 | `approved_by_approval_id`(순환 FK) 2건 모두 원래 값으로 복원. `proposal_id`/`assignee_actor_id`(수동으로 null 처리했던 값)도 원래 값으로 복원됨 — upsert 가 전체 컬럼을 덮어쓴다는 것을 실증 |

6. 복구 후 재차 dry-run → 13개 테이블 전부 `new=0` (멱등성 확인, 중복 행 없음).

**부수 발견(예상 못 했던 사실)**: `huai_approvals`/`huai_events` 의 append-only
트리거는 `UPDATE`/`DELETE` 를 직접 막을 뿐 아니라, **그 행을 참조하는 `huai_tasks`
행을 삭제하려는 시도(캐스케이드 삭제)까지 같은 트리거로 막는다** — Postgres 의
`ON DELETE CASCADE` 도 대상 테이블에 대한 실제 DELETE 문이라 트리거가 그대로
걸린다. 실제로 `DELETE FROM huai_tasks WHERE task_id=...` 를 시도했더니
`append-only-ledger:huai_approvals is immutable` 로 거부되고 트랜잭션 전체가
롤백됐다(테스트 방에서 직접 확인). 즉 승인/이벤트가 하나라도 걸린 작업 행은 일반
DELETE 경로로는 절대 지워지지 않는다 — 이건 설계 의도(원장 불변성)의 자연스러운
확장이지 결함이 아니다. 다만 "승인·이벤트 테이블에서 행이 통째로 사라지는" 사고는
일반적인 애플리케이션 버그로는 일어날 수 없고, 디스크 손상·잘못된 마이그레이션·
트리거를 우회하는 직접 개입 같은 경로로만 일어날 수 있다는 뜻이다.

**테스트 방 정리 (완전히 지우지 못함 — 정직하게 남긴다)**: 위와 같은 이유로 테스트
방의 `huai_tasks` 2건, `huai_approvals` 2건, `huai_events` 2건, 그리고 그 셋에
캐스케이드로 묶인 `huai_rooms` 행 자체는 일반 DELETE 로 지울 수 없었다(`huai_rooms`
행 삭제도 같은 트리거로 거부됨 — 직접 시도해 확인). 나머지 10개 테이블
(room_members/ai_actors/task_proposals/task_dependencies/agent_personas/task_reports/
artifacts/reports/revision_requests/message_bindings)은 전부 삭제했고, 로컬 스냅샷
파일(`sessions/rooms/recovery/16966452.../*.json[.sha256]`)과 `huai_recovery_snapshots`
행도 지웠다. 남길 수밖에 없는 `huai_rooms` 행은 `status='archived'` 로 바꾸고
purpose 를 `[REHEARSAL-TEST-ARCHIVED]` 로 재작성해 운영 스캔(활성 방만 순회하는
경로들)에서 제외되게 해뒀다 — 완전 삭제는 트리거를 우회하는 직접 DB 접근이 필요해
이 작업 범위를 벗어난다. 남은 잔여물: room_id `16966452-fbb6-43b6-bbd7-5bbb87ca525a`
(status=archived), task_id `cd54c203-ef00-48da-bd6e-7b219340b152` / `84e3b780-f92d-4efc-92c4-f29d090be0da`,
approval_id `e9ae59e9-66e9-45af-8d25-f2f4441a965e` / `74e92db6-8b6b-4269-840c-feecfc70b2c5`,
event_id `09650822-a158-466a-8a52-82530ff84330` / `d00a27c1-cf2a-41e6-94d7-bcdfd9ae185e`.

**결론**: `restore-room-backup.mjs --apply` 는 이제 "이미 있는 값을 다시 쓰는" 경로뿐
아니라 "실제로 지워진 데이터를 되살리는"(`new>0`) 경로도 실제 프로덕션 Supabase
프로젝트(다만 전용 테스트 방 안에서만)에 대해 검증됐다. 이 결과를
`2026_08_12__OPERATION_INCIDENT_RUNBOOK.md` 의 "Current limitations" 절에도 반영한다.
