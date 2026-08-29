import { applyOperationEnvFile } from "./operation-env-loader.mjs";

const OWNER_CONTROL_CALLBACK = /^(proposal|task):[^:]+:(approve|reject|revise|request_revision|mid_approve|mid_reject|reverify|final_approve|cancel|rv|rr|fa)$/;

export async function repairButtonCallbackOutbox(env, options = {}, fetchImpl = fetch) {
  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const apply = options.apply === true;
  const selectedIds = new Set(options.ids ?? []);
  if (apply && selectedIds.size === 0) {
    throw new Error("apply-requires-explicit-id");
  }

  const rows = await getJson(
    fetchImpl,
    `${baseUrl}/rest/v1/huai_outbox?status=eq.dead&last_error=like.*BUTTON_DATA_INVALID*&select=huai_outbox_id,payload,attempts,created_at&order=created_at.desc&limit=100`,
    serviceRoleKey
  );

  const candidates = [];
  for (const row of rows) {
    if (selectedIds.size > 0 && !selectedIds.has(row.huai_outbox_id)) continue;
    const { payload, changedCallbacks } = rewritePayloadCallbacks(row.payload);
    if (changedCallbacks === 0) continue;
    const candidate = {
      id: row.huai_outbox_id,
      attempts: row.attempts ?? 0,
      changedCallbacks,
      action: apply ? "requeued" : "dry-run"
    };
    candidates.push(candidate);

    if (apply) {
      await patchJson(fetchImpl, `${baseUrl}/rest/v1/huai_outbox?huai_outbox_id=eq.${encodeURIComponent(row.huai_outbox_id)}`, serviceRoleKey, {
        payload,
        status: "retry_pending",
        last_error: "manual-retry-after-short-callback-fix",
        locked_until: null,
        next_attempt_at: new Date().toISOString()
      });
    }
  }

  return { apply, scanned: rows.length, selected: selectedIds.size, candidates };
}

export function formatRepairButtonCallbackResult(result) {
  const lines = [`button-callback-repair mode=${result.apply ? "apply" : "dry-run"} scanned=${result.scanned} selected=${result.selected} candidates=${result.candidates.length}`];
  for (const candidate of result.candidates) {
    lines.push(`candidate id=${candidate.id} attempts=${candidate.attempts} changed_callbacks=${candidate.changedCallbacks} action=${candidate.action}`);
  }
  if (!result.apply && result.candidates.length > 0) {
    lines.push("to_apply: node scripts/repair-button-callback-outbox.mjs --apply --id <candidate_id>");
  }
  return lines.join("\n");
}

export function rewritePayloadCallbacks(payload) {
  let changedCallbacks = 0;
  const rewritten = rewriteValue(payload);
  return { payload: rewritten, changedCallbacks };

  function rewriteValue(value) {
    if (Array.isArray(value)) return value.map(rewriteValue);
    if (!value || typeof value !== "object") return value;
    const next = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key === "keyboard" && hasOwnerControlCallback(raw)) {
        changedCallbacks += countOwnerControlCallbacks(raw);
        next.ownerActionRedirect = true;
        continue;
      }
      next[key] = rewriteValue(raw);
    }
    return next;
  }
}

function hasOwnerControlCallback(value) {
  return countOwnerControlCallbacks(value) > 0;
}

function countOwnerControlCallbacks(value) {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countOwnerControlCallbacks(item), 0);
  if (!value || typeof value !== "object") return 0;
  if (typeof value.callback_data === "string" && OWNER_CONTROL_CALLBACK.test(value.callback_data)) return 1;
  return Object.values(value).reduce((count, item) => count + countOwnerControlCallbacks(item), 0);
}

async function getJson(fetchImpl, url, serviceRoleKey) {
  const response = await fetchImpl(url, { method: "GET", headers: authHeaders(serviceRoleKey) });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
  return response.json();
}

async function patchJson(fetchImpl, url, serviceRoleKey, body) {
  const response = await fetchImpl(url, {
    method: "PATCH",
    headers: { ...authHeaders(serviceRoleKey), prefer: "return=minimal" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
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

function sanitize(value) {
  return String(value)
    .replace(/service_role_[A-Za-z0-9_-]+/g, "service_role_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

function parseArgs(argv) {
  const ids = [];
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--id") {
      const value = argv[i + 1];
      if (!value) throw new Error("missing-id-value");
      ids.push(value);
      i += 1;
    } else {
      throw new Error(`unknown-arg:${arg}`);
    }
  }
  return { apply, ids };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  applyOperationEnvFile(process.env);
  const result = await repairButtonCallbackOutbox(process.env, parseArgs(process.argv.slice(2)));
  console.log(formatRepairButtonCallbackResult(result));
}
