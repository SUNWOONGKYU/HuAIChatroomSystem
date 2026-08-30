# Gate14 Telegram Webhook Setup

## Scope
- Generate role-specific Telegram `setWebhook` commands.
- Keep actual bot token values out of generated output.
- Keep webhook URL path token-free: `/telegram/webhook/{botUsername}`.

## Command
- `BOT_SERVICE_PUBLIC_BASE_URL=https://your-public-host node scripts/generate-telegram-webhook-commands.mjs`

## Required Env
- `BOT_SERVICE_PUBLIC_BASE_URL`
- `BOT_SERVICE_PLATOON_BOT_TOKEN`
- `BOT_SERVICE_CLAUDE_BOT_TOKEN`
- `BOT_SERVICE_CODEX_BOT_TOKEN`
- `BOT_SERVICE_AUDITOR_BOT_TOKEN`
- `BOT_SERVICE_PLATOON_WEBHOOK_SECRET`
- `BOT_SERVICE_CLAUDE_WEBHOOK_SECRET`
- `BOT_SERVICE_CODEX_WEBHOOK_SECRET`
- `BOT_SERVICE_AUDITOR_WEBHOOK_SECRET`

## Safety Rules
- Generated webhook URL never includes bot token.
- Generated command references token env vars instead of printing token values.
- Each role has an independent webhook command.
