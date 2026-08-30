// index.ts 에서 뽑아낸 범용 문자열/식별자 유틸. 순수 함수만 있다 (I/O 없음).
// God module 분리 — 여러 모듈이 공용으로 쓴다.

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength) + "...";
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function requireSingle<T>(rows: T[], error: string): T {
  if (rows.length !== 1) throw new Error(error);
  return rows[0] as T;
}
