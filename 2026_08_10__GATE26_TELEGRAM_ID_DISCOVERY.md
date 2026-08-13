# Gate26 Telegram Id Discovery

## Scope

A setup-only Telegram id discovery script was added to help obtain `telegram_chat_id` and owner `telegram_user_id` before webhook activation.

## Script

- `scripts/discover-telegram-ids.mjs`
  - Uses one role bot token, default `PLATOON`.
  - Calls Telegram `getUpdates`.
  - Extracts unique chat ids and human user ids.
  - Does not print bot token values.

## Usage Constraints

Use this only before webhook activation. Send one message in the target Telegram group first, then run the script. After webhook is active, use webhook-based operation checks instead.

## Verification

- `npm run verify:telegram-id-discovery`
- `npm run verify:gate26`
- `npm run verify:operation-ready`
