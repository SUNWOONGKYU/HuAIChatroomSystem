# Gate21 Owner Verification And Completion Outbox

## Scope

Owner verification and completion decisions now create role-specific Telegram outbox messages instead of only recording events.

## Completed behavior

- `/verify <id>` creates `owner_verification_requested` and routes a message to the `auditor` bot.
- `reverify` callback creates `owner_reverification_requested` and routes a message to the `auditor` bot.
- `final_approve` callback creates `owner_final_approved` and routes a completion message to the `platoon_leader` bot.
- `request_revision` callback routes a supplement request message with completion controls.
- `/approve` and approve callback still enqueue local gateway execution as before.

## Verification

- `npm run typecheck`
- `npm run verify:orchestrator-owner-flow`
- `npm run verify:gate21`
- `npm run verify:operation-ready`
