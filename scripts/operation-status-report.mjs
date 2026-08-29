import { applyOperationEnvFile } from "./operation-env-loader.mjs";
import { inspectOutbox } from "./inspect-outbox.mjs";

export async function buildOperationStatusReport(env, options = {}, fetchImpl = fetch) {
  const now = options.now ?? new Date().toISOString();
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const botHealthUrl = options.botHealthUrl ?? env.BOT_SERVICE_HEALTH_URL ?? "http://127.0.0.1:8787/healthz";
  const gatewayHealthUrl = options.gatewayHealthUrl ?? env.LOCAL_GATEWAY_HEALTH_URL ?? "http://127.0.0.1:8797/healthz";

  // Gemini 웹 실행기는 CLI 가 아니라 전용 Chrome(CDP 9222)에 붙는다. 그 Chrome 이 없으면
  // gemini_web 실행만 전부 gemini-web-cdp-unavailable 로 죽고 Claude·Codex 는 멀쩡하다 —
  // 그래서 "down" 이 아니라 "attention" 이다. 이 머신이 gemini_web 을 허용할 때만 본다.
  const geminiWebEnabled = String(env.LOCAL_GATEWAY_ALLOWED_ADAPTERS ?? "").split(/[;,]/).map((s) => s.trim()).includes("gemini_web");
  const geminiCdpUrl = options.geminiCdpUrl ?? env.GEMINI_WEB_CDP_URL ?? "http://127.0.0.1:9222/json/version";

  const [botService, localGateway, updates, outbox, approvals, geminiWeb] = await Promise.all([
    fetchHealth(fetchImpl, botHealthUrl),
    fetchHealth(fetchImpl, gatewayHealthUrl),
    fetchTelegramUpdateSummary(fetchImpl, baseUrl, serviceRoleKey),
    inspectOutbox(env, fetchImpl),
    fetchApprovalLedgerSummary(fetchImpl, baseUrl, serviceRoleKey),
    geminiWebEnabled ? fetchGeminiCdpHealth(fetchImpl, geminiCdpUrl) : Promise.resolve({ enabled: false, ok: true })
  ]);

  const status = decideOverallStatus({ botService, localGateway, updates, outbox, approvals, geminiWeb });
  return { generatedAt: now, status, botService, localGateway, updates, outbox, approvals, geminiWeb };
}

export function formatOperationStatusReport(report) {
  const lines = [
    `operation_status status=${report.status} generated_at=${report.generatedAt}`,
    `service bot_service=${formatHealth(report.botService)} local_gateway=${formatHealth(report.localGateway)}`,
    `telegram_updates scanned=${report.updates.scanned} processed=${report.updates.processed} failed=${report.updates.failed} pending=${report.updates.pending} latest_at=${report.updates.latestAt ?? "none"}`,
    `outbox scanned=${report.outbox.scanned} sent=${report.outbox.counts.sent ?? 0} dead=${report.outbox.counts.dead ?? 0} retry_pending=${report.outbox.counts.retry_pending ?? 0} processing=${report.outbox.counts.processing ?? 0} stale_processing=${report.outbox.staleProcessing}`,
    `approvals scanned=${report.approvals.scanned} task_approved=${report.approvals.taskApproved} orphaned=${report.approvals.orphaned}${report.approvals.error ? ` error=${report.approvals.error}` : ""}`
  ];
  if (report.geminiWeb?.enabled) {
    lines.push(`gemini_web cdp=${report.geminiWeb.ok ? "ok" : "down"}${report.geminiWeb.browser ? ` browser=${report.geminiWeb.browser}` : ""}${report.geminiWeb.error ? ` error=${report.geminiWeb.error}` : ""}${report.geminiWeb.ok ? "" : " action=자동화 Chrome(CDP 9222)을 띄워라. 런북 'Gemini Web Executor Health' 참조."}`);
  }
  for (const row of report.approvals.orphanRows ?? []) {
    lines.push(`approval_orphan entity_ref=${row.entityRef} decided_at=${row.decidedAt} action=승인은 기록됐으나 대응 task 가 없다. 아웃박스 hydration 실패 여부를 확인하라.`);
  }
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

// 고아 승인 탐지.
// 승인 원장은 append-only 라서 "승인은 났는데 task 물질화가 실패한" 상태를 제약으로 막지 않는다.
// 대신 여기서 탐지한다. task_approval/approved 인데 대응 task 가 없으면 아웃박스 hydration 이 실패한 것이다.
// (거부·취소·중간승인은 원래 task 가 없을 수 있으므로 task_approval + approved 만 대상으로 한다.)
async function fetchApprovalLedgerSummary(fetchImpl, baseUrl, serviceRoleKey) {
  const summary = { scanned: 0, taskApproved: 0, orphaned: 0, orphanRows: [], error: undefined };
  let approvals;
  try {
    approvals = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_approvals?select=approval_id,stage,decision,entity_ref,task_id,created_at&order=created_at.desc&limit=200`,
      serviceRoleKey
    );
  } catch (error) {
    // 조회 실패를 조용히 넘기면 점검 기능이 죽어도 아무도 모른다. 상태에 드러낸다.
    summary.error = sanitize(error instanceof Error ? error.message : String(error));
    return summary;
  }
  summary.scanned = approvals.length;
  const candidates = [];
  for (const row of approvals) {
    if (row.stage !== "task_approval" || row.decision !== "approved") continue;
    summary.taskApproved += 1;
    if (row.task_id) continue;
    if (typeof row.entity_ref === "string" && row.entity_ref) candidates.push(row);
  }
  if (candidates.length === 0) return summary;

  const keys = candidates.map((row) => `"task:approved-proposal:${String(row.entity_ref).replace(/"/g, "")}"`).join(",");
  let tasks;
  try {
    tasks = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_tasks?idempotency_key=in.(${encodeURIComponent(keys)})&select=idempotency_key`,
      serviceRoleKey
    );
  } catch (error) {
    summary.error = sanitize(error instanceof Error ? error.message : String(error));
    return summary;
  }
  const materialized = new Set(tasks.map((task) => task.idempotency_key));

  for (const row of candidates) {
    if (materialized.has(`task:approved-proposal:${row.entity_ref}`)) continue;
    summary.orphaned += 1;
    if (summary.orphanRows.length < 10) {
      summary.orphanRows.push({ entityRef: row.entity_ref, decidedAt: row.created_at });
    }
  }
  return summary;
}

async function fetchGeminiCdpHealth(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    return { enabled: true, ok: response.ok, status: response.status, browser: typeof body.Browser === "string" ? body.Browser : undefined };
  } catch (error) {
    return { enabled: true, ok: false, status: 0, error: sanitize(error instanceof Error ? error.message : String(error)) };
  }
}

function decideOverallStatus({ botService, localGateway, updates, outbox, approvals, geminiWeb }) {
  if (!botService.ok || !localGateway.ok) return "down";
  if (localGateway.hasLastError || (localGateway.consecutiveErrors ?? 0) > 0 || outbox.staleProcessing > 0) return "attention";
  if ((outbox.counts.dead ?? 0) > 0 || updates.failed > 0 || updates.pending > 0) return "attention";
  if ((approvals?.orphaned ?? 0) > 0 || approvals?.error) return "attention";
  if (geminiWeb?.enabled && !geminiWeb.ok) return "attention";
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

