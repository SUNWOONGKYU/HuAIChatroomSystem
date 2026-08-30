# Gate13 Operation Env Preflight

## Scope
- Preflight validation before starting bot-service and local-gateway in production.
- Prevent startup with missing/duplicated role bot tokens, missing/duplicated webhook secrets, invalid adapter allowlist, invalid numeric loop settings, or missing Supabase connection settings.

## Command
- Bot service only: `node scripts/verify-operation-env.mjs --profile=bot-service`
- Local gateway only: `node scripts/verify-operation-env.mjs --profile=local-gateway`
- Both: `node scripts/verify-operation-env.mjs --profile=all`

## Required Bot-Service Env
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BOT_SERVICE_ROOM_ID` or `BOT_SERVICE_TELEGRAM_CHAT_ID`
- `BOT_SERVICE_PLATOON_BOT_TOKEN`
- `BOT_SERVICE_CLAUDE_BOT_TOKEN`
- `BOT_SERVICE_CODEX_BOT_TOKEN`
- `BOT_SERVICE_AUDITOR_BOT_TOKEN`
- `BOT_SERVICE_PLATOON_WEBHOOK_SECRET`
- `BOT_SERVICE_CLAUDE_WEBHOOK_SECRET`
- `BOT_SERVICE_CODEX_WEBHOOK_SECRET`
- `BOT_SERVICE_AUDITOR_WEBHOOK_SECRET`

## Required Local-Gateway Env
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LOCAL_GATEWAY_ALLOWED_ROOTS`
- `LOCAL_GATEWAY_ALLOWED_ADAPTERS` with values from `codex`, `claude_code`

## Verification
- `npm run verify:operation-env` checks required role tokens, webhook secrets, duplicate token/secret reuse, numeric settings, Supabase connection env, and local gateway adapter/root allowlists.
- `npm run verify:structure`
- `npm run verify:secrets`

