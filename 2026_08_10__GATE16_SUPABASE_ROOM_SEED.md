# Gate16 Supabase Room Seed

## Scope
- Generate idempotent SQL for creating one operational Telegram project room in `huai_` tables.
- Store only `env:...` secret references for role bot tokens and webhook secrets.
- Never write raw bot token values to SQL, DB rows, logs, or prompts.

## Command
- `node scripts/generate-supabase-room-seed.mjs > C:\tmp\huai-room-seed.sql`
- Review the SQL before applying it to Supabase.

## Required Env
- `BOT_SERVICE_ROOM_ID`
- `BOT_SERVICE_TELEGRAM_CHAT_ID`
- `BOT_SERVICE_OWNER_TELEGRAM_USER_ID`
- `BOT_SERVICE_PLATOON_BOT_USERNAME`
- `BOT_SERVICE_CLAUDE_BOT_USERNAME`
- `BOT_SERVICE_CODEX_BOT_USERNAME`
- `BOT_SERVICE_AUDITOR_BOT_USERNAME`

## Optional Env
- `BOT_SERVICE_EXECUTION_GATEWAY_ID`
- `BOT_SERVICE_EXECUTION_PROJECT_PATH`

## Verification
- `npm run verify:supabase-room-seed`
- `npm run verify:structure`
- `npm run verify:secrets`
