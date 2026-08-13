import { validateOperationEnv } from "./verify-operation-env.mjs";

export function buildServiceStartupPreflight(env) {
  const errors = validateOperationEnv(env, "all");
  validatePort(env.BOT_SERVICE_PORT ?? "8787", "BOT_SERVICE_PORT", errors);
  if (env.LOCAL_GATEWAY_HEALTH_PORT) validatePort(env.LOCAL_GATEWAY_HEALTH_PORT, "LOCAL_GATEWAY_HEALTH_PORT", errors);

  const botPort = env.BOT_SERVICE_PORT ?? "8787";
  const gatewayHealthPort = env.LOCAL_GATEWAY_HEALTH_PORT;
  const ready = errors.length === 0;

  return {
    ready,
    errors,
    commands: [
      "npm run build",
      "node dist/apps/bot-service/src/cli.js",
      "node dist/apps/local-gateway/src/cli.js"
    ],
    checks: [
      `http://127.0.0.1:${botPort}/healthz`,
      gatewayHealthPort ? `http://127.0.0.1:${gatewayHealthPort}/healthz` : undefined,
      gatewayHealthPort ? `http://127.0.0.1:${gatewayHealthPort}/readyz` : undefined
    ].filter(Boolean)
  };
}

export function formatServiceStartupPreflight(preflight) {
  const lines = [`Service startup preflight: ${preflight.ready ? "READY" : "BLOCKED"}`];
  if (preflight.errors.length > 0) {
    lines.push("Blocking checks:");
    for (const error of preflight.errors) lines.push(`- ${error}`);
  }
  lines.push("Commands:");
  for (const command of preflight.commands) lines.push(`- ${command}`);
  lines.push("Health checks:");
  for (const check of preflight.checks) lines.push(`- ${check}`);
  return lines.join("\n");
}

function validatePort(value, key, errors) {
  if (!/^\d+$/.test(String(value))) {
    errors.push(`invalid-env:${key}`);
    return;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) errors.push(`invalid-env:${key}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const preflight = buildServiceStartupPreflight(process.env);
  console.log(formatServiceStartupPreflight(preflight));
  if (!preflight.ready) process.exit(1);
}
