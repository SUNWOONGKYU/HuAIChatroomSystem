// 테스트 전용 유틸리티. 런타임(Deno) 코드가 이 파일을 import 하는 일은 없다 — 프로덕션
// 코드에서 절대 참조하지 마라. node --test 로 handler 를 검증할 때만 쓴다.
//
// 여기 두 가지가 있다:
//   1) signInitData — Telegram 공식 initData 서명 절차를 검증 코드(telegram-init-data.ts)와
//      독립적으로 재구현한 "서명 생성기". 여러 테스트 파일(telegram-init-data.test.ts,
//      각 handler 의 happy-path 테스트)이 똑같이 필요해서 한 곳에 모았다 — 각자 베끼면
//      알고리즘이 갈릴 위험이 있다.
//   2) installDenoEnvShim — _shared/miniapp-auth.ts 의 진짜 authenticateMiniAppRequest() 를
//      Node 에서 그대로 호출하려면 그 함수가 부르는 Deno.env.get() 이 있어야 한다(함수
//      "본문"에서만 참조되므로 import 시점엔 안 터지고 호출 시점에만 필요하다). 이 셈은
//      "인증 로직을 흉내"내는 게 아니라 "설정값을 어디서 읽을지"라는 순수 플랫폼 API 하나만
//      제공한다 — authenticateMiniAppRequest/verifyTelegramInitData 자체는 원본 그대로 실행된다.
import { createHmac } from "node:crypto";

export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

export function validInitDataFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 123456789, first_name: "방장", username: "owner_user" }),
    ...overrides
  };
}

export function installDenoEnvShim(vars: Record<string, string>): void {
  (globalThis as unknown as { Deno: { env: { get(key: string): string | undefined } } }).Deno = {
    env: { get: (key: string) => vars[key] }
  };
}
