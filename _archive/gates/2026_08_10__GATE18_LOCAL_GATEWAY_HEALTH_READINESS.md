# Gate18 Local Gateway Health Readiness

## Scope
- Add token-free health/readiness endpoints for local-gateway process monitoring.

## Endpoints
- `GET /healthz`: process/config/loop state only.
- `GET /readyz`: readiness check result only.

## Enablement
- Set `LOCAL_GATEWAY_HEALTH_PORT` to start the health server from the local-gateway CLI.

## Safety Rules
- No env values in health response.
- No Supabase keys, bot tokens, or authorization headers in readiness failures.
- Readiness failure returns 503 without raw error detail.

## Verification
- `npm run verify:local-gateway-health`
