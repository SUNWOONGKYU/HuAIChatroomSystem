# Gate15 Bot Service Healthz

## Scope
- Add token-free health endpoint for process monitoring.

## Endpoint
- `GET /healthz`

## Response
- `ok`
- `service`
- `bots`
- `allowedChats`

## Safety Rules
- Does not expose bot tokens.
- Does not expose webhook secrets.
- Does not expose Supabase service role key.

## Verification
- `npm run verify:bot-service-health`
- `npm run typecheck`
- `npm run verify:secrets`

