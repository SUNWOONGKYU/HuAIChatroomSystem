export const REPEATED_FINDING = "approval-result-not-returned";

export function buildOutboxTimeoutDiagnostic(taskId, lastObserved) {
  return lastObserved
    ? {
        taskId,
        rowFound: true,
        idempotencyKey: lastObserved.idempotency_key ?? null,
        status: lastObserved.status ?? null,
        lastError: lastObserved.last_error ?? null,
        createdAt: lastObserved.created_at ?? null,
        repeatedFinding: REPEATED_FINDING,
        repeatedFindingAssessment: "same-symptom-reproduction-candidate"
      }
    : {
        taskId,
        rowFound: false,
        status: null,
        lastError: null,
        repeatedFinding: REPEATED_FINDING,
        repeatedFindingAssessment: "same-symptom-reproduction-candidate"
      };
}

export async function checkLocalGatewayHealth(fetchImpl = fetch, url = "http://127.0.0.1:8797/healthz") {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`local-gateway-health-unreachable:${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true || body?.service !== "local-gateway") {
    throw new Error(`local-gateway-health-unhealthy:${response.status}`);
  }
  return {
    status: response.status,
    ok: true,
    service: body.service,
    startedAt: body.startedAt ?? null,
    lastTickAt: body.lastTickAt ?? null,
    consecutiveErrors: body.consecutiveErrors ?? null,
    hasLastError: body.hasLastError ?? null
  };
}
