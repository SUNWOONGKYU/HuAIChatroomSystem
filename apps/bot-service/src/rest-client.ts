// supabase-store.ts 에서 뽑아낸 Supabase REST 얇은 클라이언트 계층. HTTP 왕복만 한다.
import { stripUndefined, safeResponseText } from "./event-row-mapping.js";

// 바깥으로 나가는 호출은 반드시 스스로 끊는다.
//
// 라이브에서 폴링 한 바퀴가 Supabase 기록 단계에서 영영 돌아오지 않아, 텔레그램에서 가져온
// 메시지의 offset 이 확정되지 못했다. 프로세스는 살아 있고 로그는 조용한데 방의 말은 하나도
// 처리되지 않았다(pending_update_count 가 1 에서 안 움직였다). 끊기지 않는 호출 하나가
// 루프 전체를 멈춘다 — 재기동 말고는 빠져나올 길이 없다.
const SUPABASE_REQUEST_TIMEOUT_MS = 20_000;

export class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: { url: string; serviceRoleKey: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = input.url.replace(/\/+$/, "");
    this.serviceRoleKey = input.serviceRoleKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async rpc<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request("POST", `/rpc/${name}`, { body }).then((response) => response.json<T>());
  }

  async request(method: string, path: string, options: { body?: unknown; prefer?: string } = {}): Promise<SupabaseRestResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      method,
      headers: stripUndefined({
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        prefer: options.prefer
      }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS)
    });
    return new SupabaseRestResponse(response);
  }
}

export class SupabaseRestResponse {
  constructor(private readonly response: Response) {}

  get status(): number {
    return this.response.status;
  }

  header(name: string): string | null {
    return this.response.headers.get(name);
  }

  async expectOk(): Promise<void> {
    if (!this.response.ok) {
      throw new Error(`supabase-rest-error:${this.response.status}:${await safeResponseText(this.response)}`);
    }
  }

  async json<T>(): Promise<T> {
    await this.expectOk();
    if (this.response.status === 204) return undefined as T;
    return (await this.response.json()) as T;
  }
}
