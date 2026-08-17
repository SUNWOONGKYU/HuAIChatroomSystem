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
- Completion buttons remain compact text: `검증`, `보완`, `완료`.
- Multi-AI collaboration requests are now routed as `multi_ai_review` when the request mentions Claude/Codex/Audit collaboration or asks for improvement review.
- The user phrase `추가로 개선할 사항을 찾는 작업이다` was live-smoke tested through the Telegram webhook path and stored as `intent=multi_ai_review`.
- Multi-AI approval no longer starts AuditBot before ClaudeBot/CodexBot results exist. ClaudeBot and CodexBot are queued first.
- After both ClaudeBot and CodexBot gateway results exist for the same multi-AI attempt, one AuditBot local-gateway audit is queued idempotently.

## Known Historical Failures

Older Telegram messages may show `process-timeout`, `spawn EINVAL`, `spawn claude ENOENT`, Windows `os error 206`, premature AuditBot `판정 보류`, or old button labels. Treat those as historical unless reproduced by a new task after this verification.

## Required Reporting Rule

When asked for current project progress, first report the verified live-operation state above, then distinguish remaining product-development work from already connected runtime infrastructure.
