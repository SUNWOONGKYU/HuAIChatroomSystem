# Gate24 Operation Check Scripts

## Scope

Production preflight scripts were added for Telegram bot identity, Telegram webhook state, and Supabase outbox health.

## Scripts

- `scripts/check-telegram-bots.mjs`
  - Calls `getMe` for the four role bot tokens.
  - Verifies expected usernames.
  - Prints token-free status lines.

- `scripts/check-telegram-webhooks.mjs`
  - Calls `getWebhookInfo` for the four role bots.
  - Verifies webhook URL against `BOT_SERVICE_PUBLIC_BASE_URL` and role usernames.
  - Prints pending update count and sanitized last error.

- `scripts/inspect-outbox.mjs`
  - Reads recent `huai_outbox` rows through Supabase REST.
  - Prints status counts, stale processing count, and error row count.
  - Exits non-zero when stale processing rows are detected.

## Verification

- `npm run verify:operation-checks`
- `npm run verify:gate24`
- `npm run verify:operation-ready`
