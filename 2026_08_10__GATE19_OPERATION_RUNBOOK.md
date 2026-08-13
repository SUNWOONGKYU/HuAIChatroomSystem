# Gate19 Operation Runbook

## Goal
Run one production Telegram project room with four separate AI bot accounts and one local work-PC gateway.

## Order
1. Create four Telegram bots with BotFather and keep each token only in local/host secrets.
2. Create one private Telegram group and invite the human owner plus the four role bots.
3. Export production env and run `node scripts/verify-operation-env.mjs --profile=all`.
4. Generate Supabase room seed SQL with `node scripts/generate-supabase-room-seed.mjs` and apply it after review.
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

## GitHub Quick Start\n- New operators should follow GITHUB_QUICKSTART.md first.\n- Release maintainers should check GITHUB_RELEASE_CHECKLIST.md before publishing.\n- Default local AI execution timeout is 15 minutes (900000 ms).\n\n## Verification
- `npm run verify:operation-ready`
- `npm run verify:operation-runbook`
