# Gate19 Operation Runbook

## Goal
Run one production Telegram project room with four separate AI bot accounts and one local work-PC gateway.

## Order
1. Create four Telegram bots with BotFather and keep each token only in local/host secrets.
2. Create one private Telegram group and invite the human owner plus the four role bots.
3. Export production env and run `node scripts/verify-operation-env.mjs --profile=all`.
4. Onboard the room: `node scripts/onboard-telegram-room.mjs --room-id <uuid> --chat-id <id> --owner-id <id> --project-path <path>` upserts the room via Supabase directly (idempotent, safe to re-run) and is the recommended path for both the first room and any room added later. Use `node scripts/generate-supabase-room-seed.mjs` instead only when you want to read the generated SQL by eye before applying it manually.
5. Set webhooks with `BOT_SERVICE_PUBLIC_BASE_URL=https://your-public-host node scripts/generate-telegram-webhook-commands.mjs`.
6. Start bot-service with `node dist/apps/bot-service/src/cli.js`.
7. Start local-gateway on the work PC with `node dist/apps/local-gateway/src/cli.js`.
8. Check bot-service `GET /healthz` and local-gateway `GET /healthz`, `GET /readyz`.
9. In the Telegram group, run `/newtask`, approve it, and confirm a local gateway execution outbox is created and processed.
10. Run `npm run verify:operation-ready` after deployment or update.

## Required Safety Checks
- Webhook URL path uses bot username, never a bot token.
- Supabase stores token/webhook secret references only as `env:...`.
- Four role bots must have distinct Telegram tokens and webhook secrets.
- `huai_outbox` retry/recovery is active before real work is assigned.
- Health endpoints must not expose raw env, token, authorization, or service role values.

## Multi-Room Operation Notes
- Each room needs its own `huai_gateway_instances` row (`room_id` is `NOT NULL`, one row per room). One machine running 20 rooms needs 20 gateway rows sharing the same `machine_label` — `onboard-telegram-room.mjs` / `generate-supabase-room-seed.mjs` create these; there is no shortcut that skips per-room rows.
- `LOCAL_GATEWAY_ALLOWED_ROOTS` must list every room's project path this machine is allowed to execute in (semicolon- or comma-separated), not just the first room's. A room's actual execution path still comes from its own `huai_gateway_instances` row; `LOCAL_GATEWAY_ALLOWED_ROOTS` is the machine-wide allowlist local-gateway checks requests against.
- `LOCAL_GATEWAY_CONCURRENCY` and `LOCAL_GATEWAY_LEASE_MS` are coupled — `runtime.ts` rejects boot unless `LEASE_MS > MAX_RUNTIME_MS * ceil(LIMIT / CONCURRENCY)`. Lowering `CONCURRENCY` without raising `LEASE_MS` to match makes local-gateway refuse to start (fail-loud, not a silent double-execution risk, but the error message does not explain the concurrency link). See `.env.operation.example` for the worked example and current live-verified values (`LIMIT=5`, `MAX_RUNTIME_MS=900000`, `CONCURRENCY=3` needs `LEASE_MS > 1800000`; the template uses `1860000`, a 60s margin).
- The env var is `LOCAL_GATEWAY_INTERVAL_MS`, not `LOCAL_GATEWAY_POLL_MS` — `runtime.ts` only reads `LOCAL_GATEWAY_INTERVAL_MS`. A `LOCAL_GATEWAY_POLL_MS` entry in a real `.env` file does nothing silently.

## GitHub Quick Start\n- New operators should follow GITHUB_QUICKSTART.md first.\n- Release maintainers should check GITHUB_RELEASE_CHECKLIST.md before publishing.\n- Default local AI execution timeout is 15 minutes (900000 ms).\n\n## Verification
- `npm run verify:operation-ready`
- `npm run verify:operation-runbook`
