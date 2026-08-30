# Gate17 Webhook HTTP E2E

## Scope
- Verify actual HTTP Telegram webhook route.
- Confirm fast ACK, update idempotency, queue enqueue, and persistence/outbox handoff.

## Covered Cases
- Valid `POST /telegram/webhook/{botUsername}` with correct secret queues command input.
- Queued command can be processed through persistence into an outbound Telegram outbox row.
- Duplicate update returns `duplicate-update` and does not enqueue.
- Invalid webhook secret returns `invalid-webhook-secret` before recording or enqueueing.

## Verification
- `npm run verify:bot-service-webhook-e2e`
