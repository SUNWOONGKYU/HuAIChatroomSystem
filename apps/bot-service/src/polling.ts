// Telegram long polling 수신.
//
// webhook 방식은 Telegram 이 우리 쪽 공개 URL 로 밀어넣기 때문에 터널이나 클라우드 호스팅이 필요하다.
// 임시 터널은 주소가 매번 바뀌고 끊기면 방 전체가 멎는다.
//
// long polling 은 우리가 Telegram 에 가서 가져온다. 아웃바운드 인터넷만 있으면 되고
// 공개 URL·도메인·추가 가입이 전혀 필요 없다.
//
// 대가: 봇 토큰 하나당 수신자가 하나여야 한다(같은 토큰으로 두 곳에서 폴링하면 서로 뺏는다).
// 그래서 폴링을 켤 때는 등록된 webhook 을 먼저 지운다.

import { type TelegramInboundQueueMessage } from "../../../packages/contracts/src/index.js";
import { routeTelegramUpdate, type BotServiceConfig, type TelegramWebhookPorts } from "./index.js";

export type TelegramPollingBot = {
  botUsername: string;
  token: string;
};

export type TelegramPollingDependencies = {
  fetchImpl?: typeof fetch;
  now?: () => string;
  onIgnored?: (botUsername: string, reason: string) => void;
};

export type PollingCycleResult = {
  fetched: number;
  queued: number;
  duplicated: number;
  ignored: number;
};

// Telegram 은 확인한 update 를 offset 으로 알려주기 전까지 계속 돌려준다.
// offset 은 메모리에 두되, 재시작으로 잃어도 저장소의 update 멱등 처리가 중복을 흡수한다.
export class TelegramPollingOffsets {
  private readonly offsets = new Map<string, number>();

  next(botUsername: string): number | undefined {
    return this.offsets.get(botUsername);
  }

  advance(botUsername: string, updateId: number): void {
    const current = this.offsets.get(botUsername) ?? 0;
    if (updateId + 1 > current) this.offsets.set(botUsername, updateId + 1);
  }
}

// 폴링을 시작하기 전에 webhook 을 해제한다.
// 남아 있으면 Telegram 이 getUpdates 를 409 로 거절한다.
export async function releaseTelegramWebhooks(
  bots: readonly TelegramPollingBot[],
  fetchImpl: typeof fetch = fetch
): Promise<Array<{ botUsername: string; ok: boolean }>> {
  const results: Array<{ botUsername: string; ok: boolean }> = [];
  for (const bot of bots) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${bot.token}/deleteWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false })
      });
      const payload = await response.json().catch(() => ({ ok: false }));
      results.push({ botUsername: bot.botUsername, ok: payload?.ok === true });
    } catch {
      results.push({ botUsername: bot.botUsername, ok: false });
    }
  }
  return results;
}

export async function runTelegramPollingCycle(input: {
  bots: readonly TelegramPollingBot[];
  config: BotServiceConfig;
  ports: TelegramWebhookPorts;
  offsets: TelegramPollingOffsets;
  timeoutSeconds?: number;
  deps?: TelegramPollingDependencies;
}): Promise<PollingCycleResult> {
  const fetchImpl = input.deps?.fetchImpl ?? fetch;
  const now = input.deps?.now ?? (() => new Date().toISOString());
  const result: PollingCycleResult = { fetched: 0, queued: 0, duplicated: 0, ignored: 0 };

  for (const bot of input.bots) {
    const updates = await fetchUpdates(fetchImpl, bot, input.offsets.next(bot.botUsername), input.timeoutSeconds ?? 25);
    for (const update of updates) {
      result.fetched += 1;
      const updateId = Number((update as { update_id?: number }).update_id);
      if (Number.isFinite(updateId)) input.offsets.advance(bot.botUsername, updateId);

      const decision = routeTelegramUpdateSafe(bot.botUsername, update, input.config);
      if (decision.kind === "ignored") {
        result.ignored += 1;
        input.deps?.onIgnored?.(bot.botUsername, decision.reason);
        if (decision.envelope) await input.ports.updates.recordUpdateOnce(decision.envelope, update, "ignored");
        continue;
      }

      const receipt = await input.ports.updates.recordUpdateOnce(decision.input.envelope, update, "received");
      if (!receipt.inserted) {
        result.duplicated += 1;
        continue;
      }

      const message: TelegramInboundQueueMessage = {
        input: decision.input,
        idempotencyKey: receipt.idempotencyKey,
        receivedAt: now()
      };
      await input.ports.inboundQueue.enqueue(message);
      result.queued += 1;
    }
  }

  return result;
}

async function fetchUpdates(
  fetchImpl: typeof fetch,
  bot: TelegramPollingBot,
  offset: number | undefined,
  timeoutSeconds: number
): Promise<unknown[]> {
  // long-poll 은 Telegram 이 timeout 초까지 응답을 붙들고 있는 게 정상이다. 그래서 이 요청만
  // 오래 걸리는 것과 연결이 죽은 것을 겉으로 구분할 수 없다 — 끊어줄 사람은 우리뿐이다.
  //
  // 라이브에서 이 fetch 가 영영 돌아오지 않아 폴링 루프 전체가 멈췄다. 프로세스는 살아 있고
  // 로그도 조용한데 방의 말이 하나도 접수되지 않았다(대기 중이던 update 2건). 아래 while 문은
  // 이 await 가 끝나야 다음 바퀴를 도는 구조라, 여기서 안 끊으면 재기동 전까지 영구 정지다.
  const response = await fetchImpl(`https://api.telegram.org/bot${bot.token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }),
    // 서버가 붙들기로 한 시간보다 넉넉히 뒤에 끊는다. 정상 long-poll 을 잘라내면 매 바퀴가
    // 오류로 끝나 폴링이 사실상 멎는다.
    signal: AbortSignal.timeout((timeoutSeconds + 15) * 1000)
  });
  const payload = await response.json().catch(() => ({ ok: false, result: [] }));
  return Array.isArray(payload?.result) ? payload.result : [];
}

function routeTelegramUpdateSafe(botUsername: string, payload: unknown, config: BotServiceConfig) {
  try {
    return routeTelegramUpdate(botUsername, payload, config);
  } catch {
    return { kind: "ignored" as const, reason: "malformed-update" as const };
  }
}
