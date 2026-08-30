# Gate20 Gateway Result Ingestion

## Scope

Local gateway execution results are now written back to Supabase before the leased local gateway outbox row is marked sent/retry/dead.

## Completed behavior

- Completed gateway execution creates a `meaningful_intermediate_ready` event.
- Failed or rejected gateway execution creates an `execution_delayed_or_failed` event.
- A Telegram report outbox row is created for the role bot that ran the adapter:
  - `codex` -> `codex_leader`
  - `claude_code` -> `claude_leader`
- Raw stdout/stderr and error text are masked before persistence.
- Existing local gateway outbox state conflict guards remain in force.

## Verification

- `npm run typecheck`
- `npm run verify:gateway-result-ingestion`
- `npm run verify:local-gateway-consumer`
- `npm run verify:local-gateway-supabase-store`
- `npm run verify:gate20`
