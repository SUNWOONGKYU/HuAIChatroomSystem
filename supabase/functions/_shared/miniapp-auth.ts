// Mini App 요청 인증 공통 진입점.
//
// 클라이언트는 Telegram 이 준 initData 원문을 `Authorization: tma <initData>` 헤더로 보낸다
// ("tma" 스킴은 Telegram Mini App 생태계 표준 관행 — @telegram-apps/init-data-node 등이 쓰는
// 것과 동일한 이름을 채택해 향후 라이브러리 교체 여지를 남겼다).
//
// 어느 봇 토큰으로 검증하는가: 리더(leader) 봇 하나로 고정한다.
//   - packages/contracts/src/index.ts 의 isCommandForThisBot 은 봇 이름이 없는 명령을
//     기본적으로 leader 가 받도록 되어 있고, /tasks·/approve 같은 협업 운영센터 성격의
//     명령이 전부 이 기본 창구를 통한다. 협업 운영센터(Mini App)도 같은 성격의 창구이므로
//     리더 봇 하나로 여는 것이 대화 채널과의 일관성이 가장 높다.
//   - 봇 4개 토큰을 순차로 시도하는 방식은 (a) 매 요청 최대 4배의 HMAC 연산 + 타이밍 표면을
//     늘리고 (b) "어느 봇이 열었는지"가 모호해져 감사 로그 해석이 어려워진다.
//   - 추후 클로드/코덱스/감사관 봇에서도 열게 하려면 이 함수에 botRole 파라미터를 추가하고
//     TELEGRAM_{ROLE}_BOT_TOKEN 중 하나를 선택하게 확장하면 된다 (작은 변경).
import { verifyTelegramInitData, DEFAULT_MAX_AUTH_DATE_AGE_SECONDS } from "./telegram-init-data.ts";
import type { MiniAppAuthResult } from "./types.ts";

export type { MiniAppAuthResult };

export async function authenticateMiniAppRequest(req: Request): Promise<MiniAppAuthResult> {
  const botToken = Deno.env.get("TELEGRAM_LEADER_BOT_TOKEN");
  if (!botToken) {
    // 운영 설정 누락. 공격자에게 원인을 노출하지 않되 로그에는 남긴다.
    console.error("miniapp-auth: TELEGRAM_LEADER_BOT_TOKEN not set");
    return { ok: false, status: 500, message: "server-misconfigured" };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const match = /^tma\s+(.+)$/i.exec(authHeader);
  if (!match) return { ok: false, status: 401, message: "unauthorized" };
  const initData = match[1];

  const maxAgeSeconds = parsePositiveIntOr(
    Deno.env.get("MINIAPP_INITDATA_MAX_AGE_SECONDS"),
    DEFAULT_MAX_AUTH_DATE_AGE_SECONDS
  );

  const verified = await verifyTelegramInitData(initData, botToken, maxAgeSeconds);
  if (!verified.ok) {
    // 실패 사유(서명 불일치 vs 만료 vs 형식 오류)는 응답에 흘리지 않는다 — 공격자에게
    // "어디까지 맞았는지" 정보를 주지 않기 위함. 서버 로그에만 사유를 남긴다.
    console.error(`miniapp-auth: rejected (${verified.reason})`);
    return { ok: false, status: 401, message: "unauthorized" };
  }

  return { ok: true, telegramUserId: verified.telegramUserId, startParam: verified.startParam };
}

function parsePositiveIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
