// Mini App 페이지를 짧은 URL로 서빙한다 (BotFather Main App URL 64자 제한 우회).
// 실제 로직은 handler.ts(순수, Deno 미참조)에 있다 — 이 파일은 Deno.serve 배선과 실제
// fetch 주입만 담당한다. 배경·설계 근거는 handler.ts 상단 주석 참고.
//
// STORAGE_HTML_PATH: supabase/miniapp-web/index.html 이 배포되는 Storage 공개 객체 경로.
// 이전 보고(호스팅 절차 문서)에서 이미 이 버킷명/파일명으로 안내했다 — 여기 값은 그
// 경로 그대로다(시크릿 아님, 공개 URL 구성요소).
import { handleBoardRequest, type BoardHandlerDeps, type FetchHtmlResult } from "./handler.ts";

const STORAGE_HTML_PATH = "/storage/v1/object/public/miniapp-web/index.html";

Deno.serve((req: Request) => {
  const deps = buildDeps();
  if (!deps) {
    console.error("board: SUPABASE_URL not set");
    return Promise.resolve(new Response("server-misconfigured", { status: 500 }));
  }
  return handleBoardRequest(req, deps);
});

function buildDeps(): BoardHandlerDeps | undefined {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl) return undefined;
  const storageUrl = supabaseUrl.replace(/\/$/, "") + STORAGE_HTML_PATH;

  return {
    async fetchHtml(): Promise<FetchHtmlResult> {
      try {
        // 요청 메서드와 무관하게 항상 GET 으로 본문을 받아온다 — 우리 함수가 받은 요청이
        // GET 이든 HEAD 든, Storage 에서는 어차피 본문 텍스트가 필요하다(handler.ts 가
        // HEAD 응답에서도 같은 본문을 만들고, 실제로 body 를 자르는 건 런타임/브라우저의
        // 몫이다 — 여기서 메서드를 분기하지 않는 것 자체가 GET/HEAD 경로 불일치를
        // 만들지 않기 위한 설계다).
        const res = await fetch(storageUrl, { method: "GET" });
        // upstreamHeaders 는 실제 Storage 응답 헤더를 담아 handler.ts 의 테스트가 "받아도
        // 무시하는지"를 실행 검증할 수 있게 한다 — 여기서 절대 그대로 리턴하지 않는다
        // (실측 버그: Storage 가 text/plain + X-Content-Type-Options: nosniff 를 보낸다).
        const upstreamHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          upstreamHeaders[key] = value;
        });
        if (!res.ok) return { ok: false, status: res.status, upstreamHeaders };
        return { ok: true, status: res.status, text: await res.text(), upstreamHeaders };
      } catch (error) {
        console.error(`board: fetch threw: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, status: 0 };
      }
    }
  };
}
