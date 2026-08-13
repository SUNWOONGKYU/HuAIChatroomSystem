import { applyOperationEnvFile } from "./operation-env-loader.mjs";
const OUTBOX_STATUSES = ["pending", "processing", "retry_pending", "sent", "dead", "failed"];

export async function inspectOutbox(env, fetchImpl = fetch) {
  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const rows = await getJson(
    fetchImpl,
    `${baseUrl}/rest/v1/huai_outbox?select=huai_outbox_id,target_kind,status,attempts,locked_until,next_attempt_at,last_error,created_at&order=created_at.desc&limit=500`,
    serviceRoleKey
  );
  const counts = Object.fromEntries(OUTBOX_STATUSES.map((status) => [status, 0]));
  let staleProcessing = 0;
  let rowsWithErrors = 0;
  const problemRows = [];
  const now = Date.now();
  for (const row of rows) {
    if (row.status in counts) counts[row.status] += 1;
    if (row.status === "processing" && row.locked_until && Date.parse(row.locked_until) < now) staleProcessing += 1;
    if (row.last_error) rowsWithErrors += 1;
    if (problemRows.length < 10 && isProblemRow(row, now)) {
      problemRows.push(summarizeProblemRow(row, now));
    }
  }
  return { counts, staleProcessing, rowsWithErrors, scanned: rows.length, problemRows };
}

export function formatOutboxInspection(summary) {
  const countText = OUTBOX_STATUSES.map((status) => `${status}=${summary.counts[status] ?? 0}`).join(" ");
  const lines = [`outbox scanned=${summary.scanned} ${countText} stale_processing=${summary.staleProcessing} rows_with_errors=${summary.rowsWithErrors}`];
  for (const row of summary.problemRows ?? []) {
    lines.push(`problem id=${row.id} target=${row.targetKind} status=${row.status} attempts=${row.attempts} kind=${row.kind} action=${row.action}`);
  }
  return lines.join("\n");
}

async function getJson(fetchImpl, url, serviceRoleKey) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json"
    }
  });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
  return response.json();
}

function isProblemRow(row, now) {
  return (
    row.status === "dead" ||
    row.status === "failed" ||
    row.last_error ||
    (row.status === "processing" && row.locked_until && Date.parse(row.locked_until) < now)
  );
}

function summarizeProblemRow(row, now) {
  const error = sanitize(row.last_error ?? "");
  const stale = row.status === "processing" && row.locked_until && Date.parse(row.locked_until) < now;
  const kind = classifyOutboxProblem(error, stale);
  return {
    id: row.huai_outbox_id,
    targetKind: row.target_kind,
    status: row.status,
    attempts: row.attempts ?? 0,
    kind,
    action: recommendedOutboxAction(kind)
  };
}

function classifyOutboxProblem(error, stale) {
  if (stale) return "stale_processing";
  if (/BUTTON_DATA_INVALID/i.test(error)) return "telegram_button_data_invalid";
  if (/invalid-telegram-message-id/i.test(error)) return "telegram_invalid_message_id";
  if (/query is too old|query ID is invalid|response timeout expired/i.test(error)) return "telegram_callback_expired";
  if (/bot was kicked|Forbidden/i.test(error)) return "telegram_bot_not_in_chat";
  if (/spawn .*ENOENT/i.test(error)) return "missing_executable";
  if (/process-timeout/i.test(error)) return "process_timeout";
  if (/telegram-api-error:429|retry_after/i.test(error)) return "telegram_rate_limit";
  if (error) return "error";
  return "unknown";
}

function recommendedOutboxAction(kind) {
  switch (kind) {
    case "telegram_button_data_invalid":
      return "apply-short-callback-fix-then-requeue-selected";
    case "stale_processing":
      return "unlock-and-requeue-selected-if-no-process-running";
    case "missing_executable":
      return "fix-adapter-executable-path-then-requeue-selected";
    case "process_timeout":
      return "review-task-scope-or-timeout-before-requeue";
    case "telegram_invalid_message_id":
      return "fixed-by-grammy-optional-reply-id-change-do-not-requeue-old-row";
    case "telegram_callback_expired":
      return "ignore-expired-callback-answer-new-code-marks-sent";
    case "telegram_bot_not_in_chat":
      return "verify-bot-membership-before-requeue";
    case "telegram_rate_limit":
      return "wait-for-retry-after";
    default:
      return "inspect-last-error";
  }
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function sanitize(value) {
  return String(value)
    .replace(/service_role_[A-Za-z0-9_-]+/g, "service_role_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  applyOperationEnvFile(process.env);
  const summary = await inspectOutbox(process.env);
  console.log(formatOutboxInspection(summary));
  if (summary.staleProcessing > 0) process.exit(1);
}
