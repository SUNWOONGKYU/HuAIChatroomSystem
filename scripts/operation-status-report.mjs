import { applyOperationEnvFile } from "./operation-env-loader.mjs";
import { inspectOutbox } from "./inspect-outbox.mjs";

export async function buildOperationStatusReport(env, options = {}, fetchImpl = fetch) {
  const now = options.now ?? new Date().toISOString();
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const botHealthUrl = options.botHealthUrl ?? env.BOT_SERVICE_HEALTH_URL ?? "http://127.0.0.1:8787/healthz";
  const gatewayHealthUrl = options.gatewayHealthUrl ?? env.LOCAL_GATEWAY_HEALTH_URL ?? "http://127.0.0.1:8797/healthz";

  const [botService, localGateway, updates, outbox] = await Promise.all([
    fetchHealth(fetchImpl, botHealthUrl),
    fetchHealth(fetchImpl, gatewayHealthUrl),
    fetchTelegramUpdateSummary(fetchImpl, baseUrl, serviceRoleKey),
    inspectOutbox(env, fetchImpl)
  ]);

  const status = decideOverallStatus({ botService, localGateway, updates, outbox });
  return { generatedAt: now, status, botService, localGateway, updates, outbox };
}

export function formatOperationStatusReport(report) {
  const lines = [
    `operation_status status=${report.status} generated_at=${report.generatedAt}`,
    `service bot_service=${formatHealth(report.botService)} local_gateway=${formatHealth(report.localGateway)}`,
    `telegram_updates scanned=${report.updates.scanned} processed=${report.updates.processed} failed=${report.updates.failed} pending=${report.updates.pending} latest_at=${report.updates.latestAt ?? "none"}`,
    `outbox scanned=${report.outbox.scanned} sent=${report.outbox.counts.sent ?? 0} dead=${report.outbox.counts.dead ?? 0} retry_pending=${report.outbox.counts.retry_pending ?? 0} processing=${report.outbox.counts.processing ?? 0} stale_processing=${report.outbox.staleProcessing}`
  ];
  for (const row of report.outbox.problemRows ?? []) {
    lines.push(`outbox_problem id=${row.id} target=${row.targetKind} status=${row.status} attempts=${row.attempts} kind=${row.kind} action=${row.action}`);
  }
  return lines.join("\n");
}

async function fetchHealth(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok && body.ok === true,
      status: response.status,
      service: body.service,
      ready: body.ready,
      consecutiveErrors: body.consecutiveErrors,
      hasLastError: body.hasLastError === true
    };
  } catch (error) {
    return { ok: false, status: 0, error: sanitize(error instanceof Error ? error.message : String(error)) };
  }
}

async function fetchTelegramUpdateSummary(fetchImpl, baseUrl, serviceRoleKey) {
  const rows = await getJson(
    fetchImpl,
    `${baseUrl}/rest/v1/huai_telegram_updates?select=status,received_at,processed_at,last_error&order=received_at.desc&limit=100`,
    serviceRoleKey
  );
  const summary = { scanned: rows.length, processed: 0, failed: 0, pending: 0, withErrors: 0, latestAt: rows[0]?.received_at };
  for (const row of rows) {
    if (row.status === "processed") summary.processed += 1;
    else if (row.status === "failed") summary.failed += 1;
    else if (["received", "processing", "retry_pending"].includes(row.status)) summary.pending += 1;
    if (row.last_error) summary.withErrors += 1;
  }
  return summary;
}

function decideOverallStatus({ botService, localGateway, updates, outbox }) {
  if (!botService.ok || !localGateway.ok) return "down";
  if (localGateway.hasLastError || (localGateway.consecutiveErrors ?? 0) > 0 || outbox.staleProcessing > 0) return "attention";
  if ((outbox.counts.dead ?? 0) > 0 || updates.failed > 0 || updates.pending > 0) return "attention";
  return "ok";
}

function formatHealth(health) {
  if (!health.ok) return `down(${health.status})`;
  const details = [];
  if (health.consecutiveErrors !== undefined) details.push(`errors=${health.consecutiveErrors}`);
  if (health.hasLastError) details.push("last_error=true");
  return details.length ? `ok(${details.join(",")})` : "ok";
}

async function getJson(fetchImpl, url, serviceRoleKey) {
  const response = await fetchImpl(url, { method: "GET", headers: authHeaders(serviceRoleKey) });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
  return response.json();
}

function authHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json"
  };
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

export function exitStatusForReport(report) {
  if (report.status === "down") return 2;
  if (report.status === "attention") return 1;
  return 0;
}

function sanitize(value) {
  return String(value)
    .replace(/service_role_[A-Za-z0-9_-]+/g, "service_role_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  applyOperationEnvFile(process.env);
  const report = await buildOperationStatusReport(process.env);
  console.log(formatOperationStatusReport(report));
  process.exitCode = exitStatusForReport(report);

}

