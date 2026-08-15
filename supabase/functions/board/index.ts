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
        const res = await fetch(storageUrl, { method: "GET" });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, status: res.status, text: await res.text() };
      } catch (error) {
        console.error(`board: fetch threw: ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, status: 0 };
      }
    }
  };
}
