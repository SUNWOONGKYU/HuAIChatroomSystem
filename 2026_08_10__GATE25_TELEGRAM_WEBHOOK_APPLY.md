# Gate25 Telegram Webhook Apply

## Scope

A safe webhook apply script was added for the four role-specific Telegram bots.

## Script

- `scripts/apply-telegram-webhooks.mjs`
  - Default mode: `--dry-run`
  - Apply mode: `--apply`
  - Calls Telegram `setWebhook` for the four role bots.
  - Uses token and webhook secret from env.
  - Does not print token or secret values.

## Required Runtime Env

- `BOT_SERVICE_PUBLIC_BASE_URL`
- `BOT_SERVICE_PLATOON_BOT_TOKEN`
- `BOT_SERVICE_CLAUDE_BOT_TOKEN`
- `BOT_SERVICE_CODEX_BOT_TOKEN`
- `BOT_SERVICE_AUDITOR_BOT_TOKEN`
- `BOT_SERVICE_PLATOON_WEBHOOK_SECRET`
- `BOT_SERVICE_CLAUDE_WEBHOOK_SECRET`
- `BOT_SERVICE_CODEX_WEBHOOK_SECRET`
- `BOT_SERVICE_AUDITOR_WEBHOOK_SECRET`
- optional role usernames, otherwise defaults are used

## Actual Connection Status

This Codex session does not currently have the live Telegram/Supabase env values set, so actual network connection was not executed in this gate.

## Verification

- `npm run verify:telegram-webhook-apply`
- `npm run verify:gate25`
- `npm run verify:operation-ready-runner`\n- `npm run verify:operation-ready`
\n## Verification Runner Stabilization\n\nerify:operation-ready now uses scripts/verify-operation-ready.mjs instead of one long Windows npm && chain. This keeps the same gate order while avoiding intermittent nested npm chain termination.\n