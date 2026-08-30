// index.ts 에서 뽑아낸 Supabase REST 얇은 클라이언트 계층. HTTP 왕복만 한다 — 비즈니스 로직 없음.
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import { stripUndefined } from "./outbox-row-mapping.js";
import type { SupabaseRuntimeConfig } from "./index.js";

export class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: SupabaseRuntimeConfig) {
    this.baseUrl = input.url.replace(/\/+$/, "");
    this.serviceRoleKey = input.serviceRoleKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async rpc<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rpc/${name}`, { body }).then((response) => response.json<T>());
  }

  async request(method: string, path: string, options: { body?: unknown; prefer?: string } = {}): Promise<SupabaseRestResponse> {
    // 게이트웨이 결과 기록도 루프 안에서 돈다. 끊기지 않으면 다음 결과가 못 들어온다.
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      signal: AbortSignal.timeout(20_000),
      method,
      headers: stripUndefined({
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: options.prefer
      }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return new SupabaseRestResponse(response);
  }
}

export class SupabaseRestResponse {
  constructor(private readonly response: Response) {}

  get status(): number {
    return this.response.status;
  }

  async expectOk(): Promise<void> {
    if (!this.response.ok) {
      throw new Error(`supabase-rest-error:${this.response.status}:${maskSensitiveText(await safeResponseText(this.response))}`);
    }
  }

  async json<T>(): Promise<T> {
    await this.expectOk();
    if (this.response.status === 204) return undefined as T;
    return (await this.response.json()) as T;
  }
}

export async function safeResponseText(response: Response): Promise<string> {
  return response.text().catch(() => "unreadable-response");
}
