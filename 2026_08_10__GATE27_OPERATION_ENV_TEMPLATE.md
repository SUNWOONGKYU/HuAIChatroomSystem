# Gate27 Operation Env Template

## Scope

A token-free operation env template was added for Telegram/Supabase/local-gateway setup.

## File

- `.env.operation.example`

## Coverage

The template includes:

- Supabase URL and service role placeholder
- room/chat/owner identifiers
- four role bot usernames
- four role bot token placeholders
- four webhook secret placeholders
- bot-service outbox settings
- local-gateway adapter/root/runtime settings
- local-gateway health port

## Verification

- `npm run verify:operation-env-template`
- `npm run verify:gate27`
- `npm run verify:operation-ready`
