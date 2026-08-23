# HuAI Collab Chatroom Operation Status

Last verified: 2026-08-17 KST

This file is the current runtime evidence anchor for Telegram operation status reports.
Do not treat older Gate setup documents as proof that operation is still incomplete.

## Current Operation State

- Product scope wording: 완성 제품 / 정식 운영 버전. Do not call this an MVP.
- Primary UI: Telegram private project group.
- Telegram group is connected to bot-service through HTTPS webhook.
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

- Three engines are in use: Claude Code, Codex, Antigravity (`agy`). A quota-blocked engine hands
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

- Antigravity has no Telegram bot of its own; its messages are sent under ClaudeBot's account while
  the text names AntigravityBot.
- Antigravity has no read-only mode, so an audit running there is constrained by prompt only, unlike
  Claude's dontAsk and Codex's read-only sandbox.
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
