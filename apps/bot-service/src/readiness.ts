// bot-service 의 /readyz 판정.
//
// /healthz 는 설정값(봇 개수·허용 chat 개수)만 돌려주는 liveness 라서, Telegram 수신이
// 멎었거나 Supabase 가 끊겨도 200 이다 — 프로젝트 최우선 규칙 "curl 200 ≠ 동작함" 을 정면
// 위배한다(local-gateway 는 이미 /readyz 로 실제 DB 도달성을 본다, health.ts 참고).
//
// /readyz 는 실제로 두 가지를 확인한다.
//   1) Supabase 에 지금 닿는가 — 가벼운 조회로 실제 왕복을 시켜본다.
//   2) 수신 경로가 살아 있는가 — polling 이면 마지막 성공 폴링이 임계치 안인지,
//      webhook 이면 Telegram 에 등록된 webhook 이 이 서비스를 가리키는지.
//
// 둘 다 판정 불가(아직 확인 전, 또는 확인 수단 자체가 없음)일 때는 "괜찮다고 가정"이
// 아니라 실패로 본다 — 확인 못 한 것을 통과로 접으면 이 엔드포인트를 만든 이유가
// 없어진다.

export type BotServiceReceiveMode = "polling" | "webhook";

export type BotServiceReadinessState = {
  receiveMode: BotServiceReceiveMode;
  // polling 모드 전용: getUpdates 왕복이 마지막으로 "성공"(fetch 자체가 끝남, 결과 0건이어도
  // 성공)한 시각. 값이 없으면 기동 후 한 번도 성공한 적이 없다는 뜻이라 실패로 본다.
  lastPollAt?: string;
  // 이 시간을 넘게 갱신이 없으면 폴링 루프가 멈춘 것으로 본다.
  pollStaleMs: number;
};

export type BotServiceReadinessCheck = { ok: boolean; detail?: string };

export type BotServiceReceiveCheck = BotServiceReadinessCheck & { mode: BotServiceReceiveMode };

export type BotServiceReadinessResult = {
  ready: boolean;
  checks: {
    supabase: BotServiceReadinessCheck;
    receive: BotServiceReceiveCheck;
  };
};

export type BotServiceReadinessDeps = {
  state: BotServiceReadinessState;
  // local(비-Supabase) 모드에는 확인할 Supabase 의존성 자체가 없으므로 undefined 로 두면
  // 그 항목은 통과로 본다. Supabase 모드에서는 항상 채워서 넘겨야 한다.
  pingSupabase?: () => Promise<void>;
  // webhook 모드에서만 쓴다. polling 모드에서는 무시된다.
  checkWebhookRegistered?: () => Promise<boolean>;
  now?: () => number;
};

export async function checkBotServiceReadiness(deps: BotServiceReadinessDeps): Promise<BotServiceReadinessResult> {
  const supabase = await checkSupabase(deps.pingSupabase);
  const receive = await checkReceivePath(deps);
  return { ready: supabase.ok && receive.ok, checks: { supabase, receive } };
}

async function checkSupabase(pingSupabase?: () => Promise<void>): Promise<BotServiceReadinessCheck> {
  if (!pingSupabase) return { ok: true };
  try {
    await pingSupabase();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: maskReadinessError(error) };
  }
}

async function checkReceivePath(deps: BotServiceReadinessDeps): Promise<BotServiceReceiveCheck> {
  const { state } = deps;
  const now = deps.now ?? (() => Date.now());

  if (state.receiveMode === "polling") {
    if (!state.lastPollAt) return { ok: false, mode: "polling", detail: "no-successful-poll-yet" };
    const elapsedMs = now() - new Date(state.lastPollAt).getTime();
    if (elapsedMs > state.pollStaleMs) return { ok: false, mode: "polling", detail: `stale-poll:${elapsedMs}ms` };
    return { ok: true, mode: "polling" };
  }

  // webhook 모드: 등록 상태를 확인할 방법이 없으면 통과가 아니라 실패다 — 못 봤다는 것과
  // 괜찮다는 것은 다르다.
  if (!deps.checkWebhookRegistered) return { ok: false, mode: "webhook", detail: "webhook-check-unavailable" };
  try {
    const registered = await deps.checkWebhookRegistered();
    return registered ? { ok: true, mode: "webhook" } : { ok: false, mode: "webhook", detail: "webhook-not-registered" };
  } catch (error) {
    return { ok: false, mode: "webhook", detail: maskReadinessError(error) };
  }
}

function maskReadinessError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization|service_role)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}
