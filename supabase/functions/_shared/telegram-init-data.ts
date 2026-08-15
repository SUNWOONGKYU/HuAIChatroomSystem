// Telegram Mini App initData 서명 검증.
//
// Telegram 공식 절차 (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
//   1) initData 에서 hash 필드를 분리한다.
//   2) 나머지 필드를 key 알파벳 순으로 "key=value\n" 조인한다 (data_check_string).
//   3) secret_key = HMAC_SHA256(key="WebAppData", message=<bot_token>)
//   4) computed  = HMAC_SHA256(key=secret_key, message=data_check_string)
//   5) computed 와 hash 를 상수시간 비교한다.
//
// 상수시간 비교는 buzzlab-nextjs supabase/functions/decrypt-api-key/index.ts:11-25 의
// "양측을 SHA-256으로 해시한 뒤 XOR 비교" 패턴을 그대로 이식했다 (길이 조기반환이 없어
// 기대 해시 길이조차 타이밍으로 새지 않는다). 원본은 두 시크릿 문자열 비교용이었고,
// 여기서는 두 해시(hex) 문자열 비교로 그대로 재사용했다.

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return new Uint8Array(digest);
}

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function hmacSha256(keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type TelegramInitDataUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type VerifiedTelegramInitData = {
  ok: true;
  telegramUserId: string;
  user: TelegramInitDataUser;
  authDate: number;
  startParam?: string;
};

export type RejectedTelegramInitData = {
  ok: false;
  reason: "malformed" | "bad-signature" | "expired" | "missing-user";
};

// maxAgeSeconds: initData 는 Mini App 을 "다시 여는" 시점에만 새로 서명되고, 한 세션 안에서는
// 고정된 값을 계속 재사용한다(승인처럼 세션 내내 호출되는 액션이 있다). 그래서 5~10분처럼
// 촘촘한 창을 두면 오래 켜둔 세션에서 정상 요청이 거절된다. 반대로 재생 공격 창은 너무 넓으면
// 안 된다. 업계 공통 관행(예: @telegram-apps/init-data-node 기본값)인 24시간(86400초)을
// 기본값으로 채택 — 세션 UX 를 깨지 않으면서 "탈취된 initData 가 영원히 유효"는 막는다.
export const DEFAULT_MAX_AUTH_DATE_AGE_SECONDS = 86400;

export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number = DEFAULT_MAX_AUTH_DATE_AGE_SECONDS
): Promise<VerifiedTelegramInitData | RejectedTelegramInitData> {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "malformed" };
  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const computed = await hmacSha256(secretKey, dataCheckString);
  const computedHex = bytesToHex(computed);

  const signatureValid = await timingSafeEqualStr(computedHex, hash.toLowerCase());
  if (!signatureValid) return { ok: false, reason: "bad-signature" };

  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) return { ok: false, reason: "malformed" };

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) return { ok: false, reason: "expired" };

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "missing-user" };
  let user: TelegramInitDataUser;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof user?.id !== "number") return { ok: false, reason: "missing-user" };

  return {
    ok: true,
    telegramUserId: String(user.id),
    user,
    authDate,
    startParam: params.get("start_param") ?? undefined
  };
}
