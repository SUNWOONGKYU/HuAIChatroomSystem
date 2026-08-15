// 외부 모듈(esm.sh, Deno 전역)을 전혀 참조하지 않는 순수 타입 정의만 모은 파일.
// handler.ts(Deno.* 없는 순수 핸들러)들이 이 파일만 import 하면 node --test 로도
// 컴파일·실행이 가능하다 — membership.ts/miniapp-auth.ts 를 직접 import 하면 그 파일들이
// "https://esm.sh/..." 타입 참조를 갖고 있어 일반 tsc 모듈 해석에서 막힌다.
export type MiniAppAuthResult =
  | { ok: true; telegramUserId: string; startParam?: string }
  | { ok: false; status: number; message: string };

export type MembershipCheckResult =
  | { ok: true; room: { roomId: string; purpose: string }; viewerRole: string }
  | { ok: false; status: number; message: string };
