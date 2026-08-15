// 다방 격리 회귀 테스트 전용 미니 Supabase REST 모사체.
// 기존 테스트들의 "큐에 응답을 순서대로 쌓아두는" 가짜 fetch 는 room_id 필터가
// 실제로 걸리는지 증명하지 못한다 (어떤 필터를 보내든 미리 정해둔 같은 응답이 나가므로).
// 이 모사체는 URL 의 eq./in./not.in./order/limit 을 실제로 파싱해 인메모리 테이블에
// 적용한다 — 필터를 빼면 진짜로 결과가 달라져서 테스트가 빨간불이 된다.
//
// 감사 이력(2026-08-15, "이 fake가 실제 PostgREST보다 관대해서 거짓 초록불을 내는가"):
// unique 제약(huai_approvals.idempotency_key 등) 미검증이 실제로 한 테스트를 거짓
// 통과시키고 있어서(apps/bot-service/test/miniapp-decision-poller.test.ts 의 원장 흡수
// 테스트) 여기서 unique 제약과 append-only 트리거 거부를 추가했다. 그 외 발견된 차이는
// "지금 당장 거짓 통과를 만들고 있진 않다"고 판단해 고치지 않고 아래에 목록만 남긴다 —
// 이 fake 를 완전한 Postgres 로 만드는 게 목적이 아니고, 과하게 엄격해지면 fake 자체가
// 새 버그원이 된다.
//
// ## 이 fake 가 흉내내지 않는 것 (다음 사람이 이 위에 테스트를 쌓기 전에 알아야 한다)
//
// - **NOT NULL**: 컬럼 누락을 막지 않는다. `withDefaults()` 는 테이블의 ID 컬럼과
//   `created_at`(그리고 huai_outbox 의 status/attempts/event_id) 만 채운다. 나머지
//   not null 컬럼(예: huai_rooms.purpose, huai_tasks.status/purpose/scope/
//   completion_criteria, huai_events.payload, huai_verifications.evidence)이 빠진
//   행도 그대로 저장된다. 실제 Postgres 라면 23502 로 거부됐을 값이다.
// - **CHECK 제약**: status/role/stage/decision 등이 허용 목록 밖 값이어도 저장된다
//   (예: huai_tasks_status_check, huai_approvals_stage_check).
// - **FK 참조 무결성**: 존재하지 않는 room_id/task_id 를 참조해도 거부되지 않는다.
// - **huai_room_members 의 실제 PK 는 (room_id, telegram_user_id) 복합키**인데
//   `ID_FIELD_BY_TABLE` 는 `room_id` 하나만 식별자로 다룬다 — 이 테이블에 unique
//   제약을 걸려면 이 매핑부터 고쳐야 한다(지금은 아무 테스트도 이 테이블을 이
//   fake 로 쓰지 않아서 미룬다).
// - **필터 연산자**: `eq.`/`in.()`/`not.in.()`/`ilike.`/`gt.`/`gte.`/`or=(...)` 가
//   구현돼 있다(`gt.`/`gte.` 는 이 저장소가 실제로 쓰는 두 곳 — `received_at`/
//   `created_at`, 둘 다 timestamptz — 만 보고 문자열 비교로 구현했다). `lt./lte.`,
//   `is.null`/`is.not.null` 은 이 저장소 어디서도 안 쓰여서(grep 확인) 구현하지
//   않았다 — 과잉 구현 금지 원칙. **미지 연산자를 만나면 조용히 무시하지 않고
//   명시적으로 던진다** — 예전엔 필터링 없이 전체 행을 돌려줘서 에러 없이 결과만
//   조용히 틀려졌는데, `gt.` 처럼 실제로 쓰이는 연산자가 이 정책 때문에 회귀를
//   못 잡았던 전례가 있어(Bravo, `fetchLastWorkCreatedAt` 테스트) 폐기했다.
// - **`or=(...)` 는 평평한 조건만 지원한다** — `or=(a.ilike.x,b.eq.y,...)`. 중첩
//   `and(...)`/`or(...)` 나 괄호로 안 감싼 값, `column.operator.value` 형태가 아닌
//   조건을 만나면 **조용히 틀리지 않고 명시적으로 던진다**(이 저장소의 유일한 실사용처
//   인 `/search` 가 평평한 형태만 써서 이걸로 충분하다고 판단했다 — 필요해지면
//   그때 확장하되, 조용히 잘못 판정하는 쪽보다 던지는 쪽을 우선했다).
// - **`order=col1.asc,col2.asc` 다중 컬럼 정렬은 깨져 있다.** `order.split(".")` 가
//   전체 문자열을 점(`.`) 기준으로 다 쪼갠 뒤 앞 두 조각만 쓰기 때문에, 두 번째
//   정렬 키가 통째로 사라지고, `col1.desc,col2.asc` 처럼 첫 컬럼이 desc 인 경우엔
//   direction 이 `"desc,col2"` 가 되어 `"desc"` 매칭에 실패해 **오름차순으로 뒤집힌다.**
//   (2026-08-15 기준 이 저장소의 어떤 프로덕션 쿼리도 이 fake 가 서빙하는 테이블에
//   다중 컬럼 order 를 안 써서 지금은 잠재 위험일 뿐이다.)
// - **`select=col1,col2` 프로젝션이 응답에 적용되지 않는다** — 무엇을 select 했든
//   행 전체가 그대로 돌아온다. select 목록에서 컬럼이 빠지는 회귀(과거에 실제로
//   있었던 종류의 버그)를 이 fake 는 못 잡는다.
// - **POST 는 `Prefer` 헤더를 안 읽는다** — `return=minimal` 을 보내도 항상 전체
//   행을 담은 201 을 돌려준다. 지금 이 fake 를 쓰는 프로덕션 코드는 `return=minimal`
//   응답에서 `.json()` 을 부르지 않아 무해하지만, 앞으로 그런 코드가 생기면 실제
//   Postgres(빈 바디)와 다르게 동작한다.
// - **409 응답 바디 모양이 실제 PostgREST(`{code:"23505", message:...}`)와 다르다**
//   (아래 unique 위반 시 `{error: "..."}` 형태로 돌려준다). 지금 애플리케이션 코드는
//   `response.status===409` 만 보고 바디 내용은 안 보므로 무해하다.
import { randomUUID } from "node:crypto";

export type MiniRow = Record<string, unknown>;

const ID_FIELD_BY_TABLE: Record<string, string> = {
  huai_rooms: "room_id",
  huai_events: "event_id",
  huai_tasks: "task_id",
  huai_approvals: "approval_id",
  huai_task_proposals: "proposal_id",
  huai_outbox: "huai_outbox_id",
  huai_artifacts: "artifact_id",
  huai_verifications: "verification_id",
  huai_ai_actors: "actor_id",
  huai_room_members: "room_id"
};

// supabase/schema.sql 의 실제 unique 제약(+ 부분 unique 인덱스)을 그대로 옮긴 것.
// 각 항목은 "이 컬럼 조합이 같은 값이면 충돌" 이다. null/undefined 값은 Postgres
// unique 제약과 동일하게 충돌 판정에서 제외한다(NULL 은 서로 달라도 같은 것으로
// 안 본다 — 그래서 huai_approvals.idempotency_key 처럼 nullable 인 컬럼도 그대로
// 이 목록에 올릴 수 있다. null 인 행끼리는 절대 충돌하지 않는다).
const UNIQUE_KEYS_BY_TABLE: Record<string, readonly string[][]> = {
  huai_rooms: [["telegram_chat_id"]], // schema.sql:8
  huai_ai_actors: [["room_id", "role"]], // schema.sql:43
  huai_telegram_bots: [["bot_username"]], // schema.sql:49
  huai_approvals: [["idempotency_key"]], // schema.sql:200 (unique, nullable)
  huai_events: [["idempotency_key"]], // schema.sql:285 (not null unique)
  huai_outbox: [["idempotency_key"]], // schema.sql:302 (not null unique)
  huai_tasks: [["idempotency_key"], ["proposal_id"]], // schema.sql:163, 175-177(부분 인덱스)
  huai_artifacts: [["task_id", "uri", "version"]] // schema.sql:261-262
};

// 원장 테이블 — UPDATE/DELETE 금지(huai_reject_ledger_mutation 트리거,
// schema.sql:264-278, huai_events 쪽 트리거는 schema.sql:549-552).
const APPEND_ONLY_TABLES = new Set(["huai_approvals", "huai_events"]);

export class MiniSupabaseFake {
  readonly tables: Record<string, MiniRow[]> = {};
  readonly requests: Array<{ url: string; method: string; body: unknown }> = [];

  seed(table: string, rows: MiniRow[]): void {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows];
  }

  countRequestsTo(table: string): number {
    return this.requests.filter((request) => new URL(request.url).pathname === `/rest/v1/${table}`).length;
  }

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ url: String(input), method, body });

    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    if (path.startsWith("rpc/")) {
      throw new Error("mini-supabase-fake: rpc not supported in room-isolation tests: " + path);
    }
    const table = path;
    if (!this.tables[table]) this.tables[table] = [];

    if (method === "GET") {
      return jsonResponse(200, applyQuery(this.tables[table], url.searchParams));
    }
    if (method === "POST") {
      const incoming = (Array.isArray(body) ? body : [body]) as MiniRow[];
      const inserted = incoming.map((row) => withDefaults(table, row));
      const conflict = findUniqueConflict(table, this.tables[table], inserted);
      if (conflict) {
        // 실제 PostgREST 의 23505 응답을 흉내낸다(바디 모양이 완전히 같진 않다 —
        // 파일 상단 주석 참고). 애플리케이션 코드는 status 만 보므로 이걸로 충분하다.
        return jsonResponse(409, { code: "23505", message: `duplicate key value violates unique constraint (${conflict.join(", ")})` });
      }
      this.tables[table].push(...inserted);
      return jsonResponse(201, inserted);
    }
    if (method === "PATCH") {
      if (APPEND_ONLY_TABLES.has(table)) {
        // huai_reject_ledger_mutation() 이 실제로 던지는 메시지 형태를 그대로 흉내낸다.
        return jsonResponse(400, { message: `append-only-ledger:${table} is immutable (attempted UPDATE)` });
      }
      const matches = applyQuery(this.tables[table], url.searchParams);
      for (const row of matches) Object.assign(row, body as MiniRow);
      return jsonResponse(200, matches);
    }
    throw new Error("mini-supabase-fake: unsupported method " + method);
  };
}

// 배치 안의 새 행들이 (a) 이미 저장된 행과, (b) 같은 배치 안의 서로와 충돌하는지 본다.
// 첫 충돌의 제약 컬럼 목록을 돌려주고, 없으면 undefined.
function findUniqueConflict(table: string, existing: readonly MiniRow[], incoming: readonly MiniRow[]): string[] | undefined {
  const keySets = UNIQUE_KEYS_BY_TABLE[table];
  if (!keySets) return undefined;

  for (const columns of keySets) {
    const seen = new Set(
      existing
        .map((row) => uniqueValueOrNull(row, columns))
        .filter((value): value is string => value !== null)
    );
    for (const row of incoming) {
      const value = uniqueValueOrNull(row, columns);
      if (value === null) continue; // null 컬럼은 Postgres 처럼 충돌 대상에서 제외.
      if (seen.has(value)) return columns;
      seen.add(value); // 같은 배치 안에서의 중복도 잡는다.
    }
  }
  return undefined;
}

// 지정된 컬럼들 중 하나라도 null/undefined 면 이 행은 그 unique 제약에서 제외된다
// (Postgres 의 "NULL 은 서로 달라도 같은 것으로 안 본다" 규칙과 동일).
function uniqueValueOrNull(row: MiniRow, columns: readonly string[]): string | null {
  const values = columns.map((column) => row[column]);
  if (values.some((value) => value === null || value === undefined)) return null;
  return JSON.stringify(values);
}

function applyQuery(rows: MiniRow[], params: URLSearchParams): MiniRow[] {
  let result = rows;
  for (const [key, raw] of params.entries()) {
    if (key === "select" || key === "order" || key === "limit" || key === "prefer") continue;
    if (key === "or") {
      result = result.filter((row) => matchesOrGroup(row, raw));
      continue;
    }
    result = result.filter((row) => matchesCondition(row, key, raw));
  }
  const order = params.get("order");
  if (order) {
    const [field, direction] = order.split(".");
    result = [...result].sort((a, b) => {
      const left = String(a[field] ?? "");
      const right = String(b[field] ?? "");
      return direction === "desc" ? right.localeCompare(left) : left.localeCompare(right);
    });
  }
  const limit = params.get("limit");
  if (limit) result = result.slice(0, Number(limit));
  return result;
}

// 컬럼 하나에 대한 단일 조건(eq./in.()/not.in.()/ilike.) 판정. applyQuery 의 최상위
// 필터 루프와 matchesOrGroup(or=(...) 안의 각 조건) 이 이 로직을 공유한다 — 실제
// PostgREST 도 or=(...) 안의 조건이 최상위 필터와 같은 연산자 문법을 쓴다.
function matchesCondition(row: MiniRow, key: string, raw: string): boolean {
  if (raw.startsWith("eq.")) {
    const target = decodeURIComponent(raw.slice(3));
    return String(row[key] ?? "") === target;
  }
  if (raw.startsWith("not.in.(") && raw.endsWith(")")) {
    const options = decodeURIComponent(raw.slice(8, -1)).split(",").map((value) => value.trim());
    return !options.includes(String(row[key] ?? ""));
  }
  if (raw.startsWith("in.(") && raw.endsWith(")")) {
    const options = decodeURIComponent(raw.slice(4, -1)).split(",").map((value) => value.trim().replace(/^"|"$/g, ""));
    return options.includes(String(row[key] ?? ""));
  }
  if (raw.startsWith("ilike.")) {
    const pattern = decodeURIComponent(raw.slice(6));
    return ilikePatternToRegExp(pattern).test(String(row[key] ?? ""));
  }
  // gt./gte. — 이 저장소가 실제로 쓰는 유일한 두 연산자다(둘 다 grep 으로 확인):
  //   supabase-store.ts:352  received_at=gt.<since>   (huai_telegram_updates)
  //   miniapp-decision-poller.ts:371  created_at=gte.<cursor>  (huai_approvals)
  // 둘 다 timestamptz 컬럼이라 문자열 비교로 충분하다 — PostgREST 가 이 컬럼들을
  // 항상 같은 고정 폭 ISO 8601(+00:00 오프셋, 초 단위 정밀도까지 zero-pad)로
  // 직렬화하고, 이 fake 의 order=... 정렬(바로 아래 applyQuery)도 이미 같은 가정
  // (localeCompare 문자열 비교)으로 동작하고 있다. lt./lte./is.null 은 이 저장소
  // 어디에서도 안 쓰여서(grep 확인) 구현하지 않았다 — 과잉 구현 금지 원칙.
  if (raw.startsWith("gte.")) {
    const target = decodeURIComponent(raw.slice(4));
    return String(row[key] ?? "") >= target;
  }
  if (raw.startsWith("gt.")) {
    const target = decodeURIComponent(raw.slice(3));
    return String(row[key] ?? "") > target;
  }
  // 그 외 미지 연산자(lt./lte./is.null 등, 혹은 오타) — 조용히 통과시키던 예전
  // 정책은 "필터가 소리 없이 사라지는" 위험한 기본값이라 폐기했다. 여기까지 왔다는
  // 것 자체가 이 fake 가 못 흉내내는 연산자를 만났다는 뜻이니 명시적으로 던진다.
  throw new Error("mini-supabase-fake: unsupported filter operator for column '" + key + "': " + raw);
}

// PostgREST ILIKE 패턴(SQL LIKE 와 같은 와일드카드 문법: `*` = 임의 길이 문자열,
// `_` = 문자 1개, 대소문자 무시)을 정규식으로 옮긴다. 예전엔 맨 앞/뒤 `*` 만 벗겨내고
// 나머지를 리터럴로 비교했다 — 중간 와일드카드(`*foo*bar*`)를 못 다뤘고 대소문자도
// 구분했다. `/search` 가 이 연산자를 or=(...) 안에서 쓰므로(supabase-store.ts:670)
// 실제 문법과 다르면 검색 결과가 fake 에서만 조용히 달라진다.
function ilikePatternToRegExp(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "_") return ".";
      return /[.*+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
    })
    .join("");
  return new RegExp("^" + body + "$", "is");
}

// or=(cond1,cond2,...) — 실제 PostgREST 문법: 조건은 콤마로 구분되고, 각 조건은
// column.operator.value 형태다(최상위 필터와 같은 연산자 문법). 한 행은 조건 중
// 하나라도 맞으면 통과한다(OR). 값 안에 콤마가 있으면 큰따옴표로 감싸는 PostgREST
// 관례를 그대로 따라, 큰따옴표 안의 콤마는 분리 기준에서 제외한다.
//
// 중첩 and(...)/or(...) 는 지원하지 않는다 — 이 저장소의 유일한 실사용처(/search,
// supabase-store.ts 의 renderTaskSearchQuery)가 평평한 or=(a.ilike.x,b.ilike.x,
// c.ilike.x) 형태만 쓴다. 지원 안 하는 걸 조용히 잘못 판정하느니 명시적으로 던진다.
function matchesOrGroup(row: MiniRow, raw: string): boolean {
  if (!raw.startsWith("(") || !raw.endsWith(")")) {
    throw new Error("mini-supabase-fake: or=(...) must be wrapped in parentheses, got: " + raw);
  }
  const conditions = splitTopLevelCommas(raw.slice(1, -1));
  return conditions.some((condition) => {
    if (condition.startsWith("and(") || condition.startsWith("or(")) {
      throw new Error("mini-supabase-fake: nested and()/or() inside or=(...) is not supported: " + condition);
    }
    const dotIndex = condition.indexOf(".");
    if (dotIndex === -1) {
      throw new Error("mini-supabase-fake: malformed or=(...) condition (expected column.operator.value): " + condition);
    }
    const key = condition.slice(0, dotIndex);
    const conditionOperatorAndValue = condition.slice(dotIndex + 1);
    return matchesCondition(row, key, conditionOperatorAndValue);
  });
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\"" && text[i - 1] !== "\\") inQuotes = !inQuotes;
    if (!inQuotes) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
    }
    if (ch === "," && depth === 0 && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function withDefaults(table: string, row: MiniRow): MiniRow {
  const idField = ID_FIELD_BY_TABLE[table];
  const defaults: MiniRow = { created_at: "2026-08-15T00:00:00.000Z" };
  if (idField && row[idField] === undefined) defaults[idField] = randomUUID();
  if (table === "huai_outbox") {
    defaults.status = "pending";
    defaults.attempts = 0;
    defaults.event_id = row.event_id ?? null;
  }
  return { ...defaults, ...row };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { "content-type": "application/json" }
  });
}
