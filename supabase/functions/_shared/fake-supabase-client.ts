// 이 파일이 메우는 격차(테스트 갭): miniapp-tasks/miniapp-proposals 의 기존 handler 단위
// 테스트는 deps.fetchXxx 함수 자체를 통짜 가짜 함수로 갈아끼워서 "handler 가 요청받은
// roomId 를 그 함수에 정확히 넘기는가"만 증명했다. 그 가짜 함수가 roomId 인자를 완전히
// 무시하고 항상 전체 행을 돌려줘도 그 테스트는 그대로 통과한다 — 즉 index.ts 의
// buildDeps() 안에서 실제로 조립되는 `.from(table).eq("room_id", roomId)` 쿼리가 "정말로"
// 필터링을 거는지는 지금까지 아무 테스트도 실행 검증하지 않았다.
//
// 이 갭을 닫으려면 진짜 Supabase 클라이언트 대신, 실제 쿼리 빌더 체인을 그대로 받아서
// "실제로 필터링"하는 인메모리 대역이 필요하다 — 호출 인자만 기록하는 스파이가 아니라,
// room_id=eq.room-A 쿼리가 room-B 행을 절대 돌려주지 않는다는 것을 실행으로 증명할 수 있는
// 최소 구현. 그것이 이 FakeSupabaseClient 다.
//
// 설계 결정(판단 사항, 문서화):
//   - Deno.* 참조 없음, "https://esm.sh/..." 임포트 없음 — node --test 로 컴파일·실행되는
//     테스트 전용 파일이라서다.
//   - 그래도 handler.ts/deps.ts(운영 코드, Deno 런타임에서도 로드됨)가 아래 MinimalSupabaseClient
//     타입을 "타입 전용"으로 가져다 쓴다(런타임 참조 없이 tsc 컴파일 시 지워짐) — buildDepsFromClient
//     의 인자 타입을 실제 @supabase/supabase-js 의 SupabaseClient 타입으로 잡으면 그 타입 자체가
//     "https://esm.sh/..." 모듈 해석을 요구해서 일반 node tsc 컴파일이 막힌다(membership.ts 가
//     이미 겪고 있는 문제, _shared/types.ts 상단 주석 참고). 대신 여기서 실제 사용 범위만 담은
//     최소 덕타이핑 인터페이스를 정의해 두면, 진짜 SupabaseClient 도 구조적으로 이 인터페이스를
//     만족하므로(상위 집합이므로) buildDepsFromClient(realClient) 와 buildDepsFromClient(fakeClient)
//     양쪽에 그대로 쓸 수 있다.
//   - 지원 범위는 의도적으로 최소다: `.from(table).select(cols)` 로 먼저 필터 빌더를 얻고,
//     그 위에서 `.eq(col,val)`(여러 번 체이닝하면 AND) `.order(col,{ascending})` `.limit(n)`
//     `.maybeSingle()` 을 호출한 뒤 `await` 로 `{data, error}` 를 받는 흐름만 지원한다 — 실제
//     PostgREST 빌더도 `.from()` 단계에는 eq/order/limit 이 없고 `.select()` 이후에만 생긴다는
//     점을 그대로 반영했다(단계를 섞어서 선언하면 실제 SupabaseClient 가 구조적으로 안 맞는
//     타입이 될 수 있어서다). `.neq`/`.in`/`.gt`/`payload->>x` 같은 연산자는 miniapp-tasks 와
//     miniapp-proposals 둘 다 안 쓴다(직접 대조 확인함 — 그건 miniapp-approve 만 쓰고,
//     miniapp-approve 는 이번 작업 대상이 아니다) — 그래서 넣지 않았다.
//   - `select(cols)` 는 컬럼 프로젝션(조인 포함)을 흉내내지 않는다 — 시드한 행 객체를 그대로
//     돌려준다. 이 대역의 목적은 "room_id 필터가 실제로 걸리는가"의 검증이지 PostgREST 의
//     select 문법 재현이 아니다.

export type FakeRow = Record<string, unknown>;

export interface MinimalSupabaseClient {
  from(table: string): MinimalTableBuilder;
}

export interface MinimalTableBuilder {
  select(columns: string): MinimalFilterBuilder;
}

// PromiseLike 를 구현해서 `await supabase.from(t).select(c).eq(...).order(...).limit(...)` 가
// 그대로 동작한다 — 진짜 PostgrestFilterBuilder 도 동일하게 thenable 이다.
export interface MinimalFilterBuilder extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  eq(column: string, value: unknown): MinimalFilterBuilder;
  order(column: string, options?: { ascending?: boolean }): MinimalFilterBuilder;
  limit(count: number): MinimalFilterBuilder;
  maybeSingle(): MinimalFilterBuilder;
}

class FakeFilterBuilder implements MinimalFilterBuilder {
  private readonly filters: Array<[string, unknown]> = [];
  private orderColumn: string | undefined;
  private orderAscending = true;
  private limitCount: number | undefined;
  private wantsSingle = false;

  constructor(private readonly rows: readonly FakeRow[]) {}

  eq(column: string, value: unknown): MinimalFilterBuilder {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): MinimalFilterBuilder {
    this.orderColumn = column;
    this.orderAscending = options?.ascending ?? true;
    return this;
  }

  limit(count: number): MinimalFilterBuilder {
    this.limitCount = count;
    return this;
  }

  maybeSingle(): MinimalFilterBuilder {
    this.wantsSingle = true;
    return this;
  }

  // 실제 필터링이 일어나는 지점 — 여기가 이 대역의 핵심이다. 시드된 행 중 모든 .eq() 조건을
  // AND 로 만족하는 것만 남긴다. room_id 필터를 안 걸거나 값을 무시하면 여기서 바로 드러난다.
  private compute(): FakeRow[] {
    let result = this.rows.filter((row) => this.filters.every(([column, value]) => row[column] === value));
    if (this.orderColumn) {
      const column = this.orderColumn;
      const ascending = this.orderAscending;
      result = [...result].sort((a, b) => {
        const left = a[column];
        const right = b[column];
        if (left === right) return 0;
        if (left === undefined || left === null) return ascending ? -1 : 1;
        if (right === undefined || right === null) return ascending ? 1 : -1;
        if (left < right) return ascending ? -1 : 1;
        return ascending ? 1 : -1;
      });
    }
    if (this.limitCount !== undefined) result = result.slice(0, this.limitCount);
    return result;
  }

  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.compute();
    const value = this.wantsSingle
      ? { data: rows[0] ?? null, error: null }
      : { data: rows, error: null };
    return Promise.resolve(value).then(onfulfilled, onrejected);
  }
}

class FakeTableBuilder implements MinimalTableBuilder {
  constructor(private readonly rows: readonly FakeRow[]) {}

  select(_columns: string): MinimalFilterBuilder {
    // 컬럼 프로젝션은 흉내내지 않는다(위 파일 상단 설계 결정 참고) — 시드 행을 그대로 넘긴다.
    return new FakeFilterBuilder(this.rows);
  }
}

// 테이블명 → 시드 행 배열. 실사용 예: new FakeSupabaseClient({ huai_tasks: [...], huai_events: [...] })
export class FakeSupabaseClient implements MinimalSupabaseClient {
  constructor(private readonly tables: Record<string, FakeRow[]>) {}

  from(table: string): MinimalTableBuilder {
    return new FakeTableBuilder(this.tables[table] ?? []);
  }
}
