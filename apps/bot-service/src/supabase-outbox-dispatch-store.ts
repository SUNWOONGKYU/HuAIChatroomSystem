// God class 분리(2026-08, 2차) — SupabaseBotServiceStore 는 서로 이질적인 두 인터페이스
// (OrchestratorPersistencePort, OutboxDispatcherStore)를 동시에 구현하고 있었다.
// OutboxDispatcherStore 쪽(leasePending/leasePendingLocalGateway/markSent/markRetry/markDead)은
// 사설 헬퍼(leaseOutbox/patchOutbox) 둘만 필요할 뿐 OrchestratorPersistencePort 쪽의 방대한
// hydrate*/record*/render* 헬퍼와 아무 것도 공유하지 않는 완전히 독립된 덩어리라 여기로
// 뽑아 별도 클래스로 만들고, SupabaseBotServiceStore 는 이 클래스에 위임(합성)한다.
// SupabaseRestClient 인스턴스는 SupabaseBotServiceStore 생성자가 만든 것을 그대로 주입받는다
// (새로 만들지 않는다) — 동작을 한 글자도 바꾸지 않기 위함이다.
import {
  type OutboxRecord,
  type TelegramSendResult
} from "../../../packages/contracts/src/index.js";
import { maskTelegramSensitiveText as maskSensitiveText } from "../../../packages/telegram-ui/src/sanitize.js";
import { summarizeSupabaseSendResult } from "../../../packages/supabase-runtime/src/index.js";
import { type OutboxDispatcherStore } from "./outbox.js";
import { type OutboxRow } from "./command-prompt-helpers.js";
import { toOutboxRecord } from "./event-row-mapping.js";
import { SupabaseRestClient } from "./rest-client.js";

export class SupabaseOutboxDispatchStore implements OutboxDispatcherStore {
  constructor(private readonly client: SupabaseRestClient) {}

  async leasePending(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "telegram_bot");
  }

  async leasePendingLocalGateway(limit: number, leaseUntil: string): Promise<OutboxRecord[]> {
    return this.leaseOutbox(limit, leaseUntil, "local_gateway");
  }

  async markSent(outboxId: string, result: TelegramSendResult): Promise<void> {
    const updated = await this.client.rpc<boolean>("mark_huai_outbox_sent", {
      p_huai_outbox_id: outboxId,
      p_send_result: summarizeSupabaseSendResult(result)
    });
    if (updated !== true) throw new Error("outbox-state-conflict:mark-sent");
  }

  async markRetry(outboxId: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "retry_pending",
      last_error: maskSensitiveText(error),
      next_attempt_at: nextAttemptAt,
      locked_until: null
    });
  }

  async markDead(outboxId: string, error: string): Promise<void> {
    await this.patchOutbox(outboxId, {
      status: "dead",
      last_error: maskSensitiveText(error),
      locked_until: null
    });
  }

  private async leaseOutbox(limit: number, leaseUntil: string, targetKind: "telegram_bot" | "local_gateway"): Promise<OutboxRecord[]> {
    const rows = await this.client.rpc<OutboxRow[]>("lease_huai_outbox", {
      p_limit: limit,
      p_locked_until: leaseUntil,
      p_target_kind: targetKind
    });
    return rows.map(toOutboxRecord);
  }

  private async patchOutbox(outboxId: string, body: Record<string, unknown>): Promise<void> {
    await this.client
      .request("PATCH", `/huai_outbox?huai_outbox_id=eq.${encodeURIComponent(outboxId)}&status=eq.processing`, {
        body,
        prefer: "return=representation"
      })
      .then((response) => response.json<OutboxRow[]>())
      .then((rows) => {
        if (rows.length !== 1) throw new Error("outbox-state-conflict:patch");
      });
  }
}
