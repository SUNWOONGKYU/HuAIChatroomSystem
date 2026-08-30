# Gate11 Telegram Outbox Operation

## Scope
- bot-service outbound Telegram dispatch operation settings.
- Non-secret audit behavior for send results and retry/dead failures.

## Runtime Defaults
- `BOT_SERVICE_OUTBOX_ENABLED=false` disables the outbox loop.
- When runtime exposes `outboxStore` and `BOT_SERVICE_OUTBOX_ENABLED` is not `false`, bot-service starts the Telegram outbox loop. In production this is the Supabase runtime path.
- `BOT_SERVICE_OUTBOX_LIMIT` default: `10`.
- `BOT_SERVICE_OUTBOX_LEASE_MS` default: `30000`.
- `BOT_SERVICE_OUTBOX_POLL_MS` default: `1000`.
- `BOT_SERVICE_OUTBOX_MAX_ATTEMPTS` default: `5`.

## Safety Rules
- Outbound rows are sent only when `target.kind=telegram_bot`.
- `target.telegramChatId` must be included in runtime `allowedChatIds`; otherwise the row is marked dead before Telegram API call.
- Bot tokens are resolved by role through secret refs/env and are never persisted to DB.
- Telegram API failure with valid `parameters.retry_after` controls `next_attempt_at`; otherwise exponential backoff is used.
- Stored send result is limited to `telegramMessageId`; raw Telegram response is not stored.
- Errors recorded in retry/dead/update failure paths are masked before persistence.

## Current Verification (2026-08-10)
- `npm run verify:telegram-fetch-sender`
- `npm run verify:outbox-consumer`
- `npm run verify:bot-service-runtime`
- `npm run verify:secrets`

