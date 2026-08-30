// webhook 모드에서 /readyz 가 "Telegram 에 실제로 이 서비스의 webhook 이 등록돼 있는가"를
// 확인할 때 쓴다.
//
// scripts/check-telegram-webhooks.mjs 와 같은 Telegram getWebhookInfo 호출을 쓰지만, 그건
// 사람이 수동으로 한 번 돌리는 점검 스크립트다. 이건 /readyz 로 몇 초~몇십 초 간격으로
// 찔릴 수 있는 상시 점검이라, 매 호출마다 Telegram API 를 왕복시키면 호출량이 불필요하게
// 늘고 지연도 커진다. 그래서 결과를 짧게 캐시한다.
export type WebhookRegistrationCheckOptions = {
  bots: readonly { botUsername: string; token: string }[];
  // 설정돼 있으면 실제 URL 이 이 서비스의 webhook 경로와 정확히 일치하는지까지 본다.
  // 없으면 "무언가에는 등록돼 있다"만 본다(등록 자체는 됐는데 어디로인지 모를 때).
  publicBaseUrl?: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  now?: () => number;
};

export function createWebhookRegistrationChecker(options: WebhookRegistrationCheckOptions): () => Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  let cachedAt = 0;
  let cachedResult: boolean | undefined;

  return async function checkWebhookRegistered(): Promise<boolean> {
    if (cachedResult !== undefined && now() - cachedAt < cacheTtlMs) return cachedResult;
    const result = await checkAllBotsRegistered();
    cachedResult = result;
    cachedAt = now();
    return result;
  };

  async function checkAllBotsRegistered(): Promise<boolean> {
    if (options.bots.length === 0) return false;
    for (const bot of options.bots) {
      const registered = await isBotWebhookRegistered(bot);
      if (!registered) return false;
    }
    return true;
  }

  async function isBotWebhookRegistered(bot: { botUsername: string; token: string }): Promise<boolean> {
    const response = await fetchImpl(`https://api.telegram.org/bot${bot.token}/getWebhookInfo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000)
    });
    const payload = (await response.json().catch(() => ({ ok: false }))) as { ok?: boolean; result?: { url?: string } };
    if (payload.ok !== true) return false;

    const actualUrl = payload.result?.url ?? "";
    if (!actualUrl) return false;
    if (!options.publicBaseUrl) return true;

    const expectedUrl = `${options.publicBaseUrl.replace(/\/+$/, "")}/telegram/webhook/${encodeURIComponent(bot.botUsername)}`;
    return actualUrl === expectedUrl;
  }
}
