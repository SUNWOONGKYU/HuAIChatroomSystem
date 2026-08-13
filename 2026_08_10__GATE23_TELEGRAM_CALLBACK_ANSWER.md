# Gate23 Telegram Callback Answer

## Scope

Telegram callback query ids are preserved and can be answered through the existing outbox dispatcher.

## Completed behavior

- `TelegramUpdateEnvelope` now stores `callbackQueryId` from `callback_query.id`.
- Owner callback outbox payloads include `callbackQueryId` when present.
- Telegram sender supports `answerCallbackQuery`.
- Outbox dispatch calls `answerCallbackQuery` when `payload.callbackQueryId` exists.
- Existing `sendMessage` and `editMessageText` behavior remains unchanged.

## Verification

- `npm run typecheck`
- `npm run verify:callback-answer`
- `npm run verify:telegram-fetch-sender`
- `npm run verify:gate23`
- `npm run verify:operation-ready`
