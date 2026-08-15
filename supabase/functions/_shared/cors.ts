// Mini App Edge Functions는 정적 페이지(별도 오리진, 호스팅 방식은 작업 4 참조)에서
// fetch() 로 호출된다. 같은 오리진이 아니므로 CORS 프리플라이트 응답이 필요하다.
//
// 참고(구조만): buzzlab-nextjs supabase/functions/decrypt-api-key/index.ts:27-37 의
// Deno.serve + OPTIONS 프리플라이트 골격을 채택했다 (하는 일은 무관 — 이쪽은 initData 검증/작업판 API).

export const MINIAPP_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type"
};

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: MINIAPP_CORS_HEADERS });
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...MINIAPP_CORS_HEADERS, "content-type": "application/json" }
  });
}
