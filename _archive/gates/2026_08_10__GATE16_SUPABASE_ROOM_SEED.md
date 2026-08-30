# Gate16 Supabase Room Seed

## Scope
- Create/update one operational Telegram project room in `huai_` tables — including a new room added to an already-running multi-room deployment, not just the first room.
- Store only `env:...` secret references for role bot tokens and webhook secrets.
- Never write raw bot token values to SQL, DB rows, logs, or prompts.

## Command — onboard-telegram-room.mjs (recommended)
- `node scripts/onboard-telegram-room.mjs --room-id <uuid> --chat-id <id> --owner-id <id> --project-path <path>` applies the room directly to Supabase via PostgREST upserts (idempotent — safe to re-run for the same room). This is the primary path now; it does not require a human to review and paste SQL by hand.
- Add `--dry-run` to see the plan without writing anything, or `--json` for machine-readable output.

## Command — generate-supabase-room-seed.mjs (SQL preview / manual apply)
- `node scripts/generate-supabase-room-seed.mjs > C:\tmp\huai-room-seed.sql`
- Review the SQL before applying it to Supabase by hand. Use this path only when you specifically want to read the SQL before it runs — for normal onboarding, prefer `onboard-telegram-room.mjs` above.

## Required Env (or CLI args)
These are inputs to the seed/onboarding tools themselves, not requirements for booting bot-service — the room selector env vars below are no longer required to start bot-service in a multi-room deployment (see `.env.operation.example`). `--room-id`/`--chat-id`/`--owner-id`/`--project-path`/`--gateway-id`/`--machine-label` CLI args override the matching env var if both are given.
- `BOT_SERVICE_ROOM_ID`
- `BOT_SERVICE_TELEGRAM_CHAT_ID`
- `BOT_SERVICE_OWNER_TELEGRAM_USER_ID`
- `BOT_SERVICE_PLATOON_BOT_USERNAME`
- `BOT_SERVICE_CLAUDE_BOT_USERNAME`
- `BOT_SERVICE_CODEX_BOT_USERNAME`
- `BOT_SERVICE_AUDITOR_BOT_USERNAME`

## Optional Env
- `BOT_SERVICE_EXECUTION_GATEWAY_ID` — fallback only; DB wins if the room already has a `huai_gateway_instances` row. See `.env.operation.example`.
- `BOT_SERVICE_EXECUTION_PROJECT_PATH` — same fallback-only rule as above.
- `BOT_SERVICE_EXECUTION_MACHINE_LABEL` — defaults to `primary`. Used to derive the room's `huai_gateway_instances.gateway_id`; a room seeded on two different machine labels gets two separate gateway rows.

## Multi-Room Reminder
- `huai_gateway_instances.room_id` is `NOT NULL` — every room, including ones added after the first, needs its own gateway row. Both tools create this row; skipping onboarding for a new room means it has no execution path.
- `LOCAL_GATEWAY_ALLOWED_ROOTS` on the machine that will run this room's executions must include this room's `--project-path`, or local-gateway will reject its execution requests even though the room exists in Supabase.

## Verification
- `npm run verify:supabase-room-seed`
- `npm run verify:onboard-telegram-room`
- `npm run verify:structure`
- `npm run verify:secrets`
