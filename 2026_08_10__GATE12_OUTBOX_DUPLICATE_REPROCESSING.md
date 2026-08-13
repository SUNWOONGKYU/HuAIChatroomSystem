# Gate12 Outbox Duplicate And Reprocessing Rules

## Scope
- Prevent stale workers from overwriting outbox rows already completed or terminally failed.
- Preserve payload while storing only non-secret send result summary.
- Keep DB lease behavior as the single concurrency gate.

## Rules
- Leasing uses `for update skip locked` and moves eligible `pending`/`retry_pending` rows to `processing` while incrementing `attempts`.
- `mark_huai_outbox_sent` updates only rows currently in `processing` status and returns whether one row was changed.
- Retry/dead transitions from runtime stores PATCH only rows still in `processing` status.
- Successful send adds `payload.sendResult` with `{ telegramMessageId }` only.
- Raw Telegram response, bot token, authorization header, and service role values are not stored in outbox payload or errors.

## Current Verification
- `npm run verify:supabase-store`
- `npm run verify:local-gateway-supabase-store`
- `npm run verify:outbox-consumer`
- `npm run verify:secrets`
- `supabase db push --dry-run`
- `npm run verify:telegram-fetch-sender`
- `npm run verify:bot-token-resolver`
- `npm run verify:bot-service-runtime`

