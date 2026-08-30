# Gate29 Service Startup Preflight

## Scope

- Added a service startup preflight tool for real operation.
- The tool validates operation environment readiness before starting bot-service and local-gateway.
- The tool fixes production startup commands and health check URLs without printing secret values.

## Artifacts

- `scripts/service-startup-preflight.mjs`
- `scripts/service-startup-preflight.test.mjs`
- `package.json`
- `scripts/verify-operation-ready.mjs`

## Startup Commands Covered

1. `npm run build`
2. `node dist/apps/bot-service/src/cli.js`
3. `node dist/apps/local-gateway/src/cli.js`

## Health Checks Covered

- `http://127.0.0.1:<BOT_SERVICE_PORT>/healthz`
- `http://127.0.0.1:<LOCAL_GATEWAY_HEALTH_PORT>/healthz`
- `http://127.0.0.1:<LOCAL_GATEWAY_HEALTH_PORT>/readyz`

## Verification

- `npm run verify:gate29`
- `npm run verify:operation-ready`

## Live Startup Status

Not executed in this gate. Real startup still requires the production operation environment values and live Supabase/Telegram credentials.
