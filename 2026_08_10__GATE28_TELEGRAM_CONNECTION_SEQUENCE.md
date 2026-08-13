# Gate28 Telegram Connection Sequence

## Scope

- Added a token-free connection sequence tool for the real Telegram operating cutover.
- The tool blocks when live operation values are missing.
- The tool fixes the execution order from environment loading through webhook apply and live checks.

## Artifacts

- `scripts/telegram-connection-sequence.mjs`
- `scripts/telegram-connection-sequence.test.mjs`
- `package.json`
- `scripts/verify-operation-ready.mjs`

## Execution Order Covered

1. Load real operation environment values.
2. Discover Telegram chat and owner user identifiers before webhook activation.
3. Generate and apply Supabase room seed.
4. Dry-run role bot webhook URLs.
5. Apply four distinct Telegram role bot webhooks.
6. Check live bot identity, webhook state, and outbox state.
7. Start bot-service and local-gateway, then run `/newtask` in the Telegram project group.

## Verification

- `npm run verify:gate28`
- `npm run verify:operation-ready`

## Live Connection Status

Not executed in this gate. Real network connection still requires the production operation environment values:

- Supabase URL and service role key
- Four Telegram role bot tokens
- Four role webhook secrets
- Public HTTPS bot-service base URL
- Target Telegram chat id
- Owner Telegram user id
- Local gateway allowed roots and adapters
