// 순수 핸들러 — Deno.* 를 참조하지 않는다. index.ts 가 실제 fetch 를 주입한다(다른
// handler.ts 들과 같은 이유: node --test 로 회귀 테스트를 돌리기 위함).
//
// 이 함수가 존재하는 이유: BotFather 의 Main App URL 입력란이 64자 제한인데, Supabase
// Storage 공개 URL은 접두사(`/storage/v1/object/public/`)만 26자라 어떤 버킷명·파일명을
// 써도 64자를 넘긴다(라이브 실측: `.../object/publi`에서 정확히 64자로 잘려 요청이
// `Route GET:/object/publi?...` 로 들어가 404). Edge Function 경로
// (`https://<project>.functions.supabase.co/board`)는 훨씬 짧다.
//
// 단일 출처 원칙 — HTML 을 손으로 복사해 갖고 있지 않는다. supabase/miniapp-web/index.html
// 이 유일한 원본이고 그게 그대로 Storage 공개 버킷에 올라간다. 이 함수는 매 요청마다 그
// Storage URL을 fetch 해서 응답을 그대로 돌려주는 프록시다(index.ts 의 fetchHtml 참고) —
// 페이지를 고치면 Storage 에 새로 올리는 것만으로 이 함수도 함께 최신화된다(이 함수 코드
// 자체는 안 바뀐다). "한 홉 늘지만 출처는 하나"를 택했다 — Deno 로컬 파일시스템으로
// supabase/miniapp-web/index.html 을 직접 읽어 인라인하는 안(홉 없음)도 검토했지만, 그 파일이
// `supabase/functions/board/` 트리 밖에 있어서 `supabase functions deploy` 가 실제로 그걸
// 번들에 포함시키는지를 Deno CLI 없이는 확인할 방법이 없었다 — 확인 못 한 가정에 기대는
// 것보다, 이미 검증된 Storage 배포 경로를 그대로 재사용하는 쪽이 안전하다고 판단했다.
//
// 인증 없음(의도) — 이 함수는 정적 HTML만 준다. 실제 데이터 접근은 페이지가 miniapp-tasks
// 등을 호출할 때 initData 로 검증된다(그 함수들은 그대로 인증을 요구한다). 여기 인증을
// 걸면 Telegram 클라이언트가 문서 자체를 못 열어 협업 운영센터가 통째로 안 열린다.
//
// 쿼리 파라미터 처리 — 이 핸들러는 요청 URL의 쿼리스트링을 읽지도, 업스트림에 전달하지도
// 않는다. 그럴 필요가 없다: Telegram 이 `?tgWebAppStartParam=...` 을 붙여 이 문서를
// "내비게이션"으로 로드하면, 리다이렉트가 없는 한 브라우저는 그 요청 URL 그대로를 현재
// 문서의 location 으로 유지한다 — 응답 바디가 무엇이든 상관없다. 그래서 정적 페이지의
// resolveRoomId() 가 location.search 를 그대로 읽을 수 있고, 이 함수가 따로 쿼리를
// 전달할 이유가 없다(전달하면 오히려 "쿼리를 이 함수가 책임진다"는 잘못된 인상을 준다).
import { corsPreflightResponse } from "../_shared/cors.ts";

// 실측 버그(라이브 배포 후 발견): Storage 가 이 객체를 text/plain + X-Content-Type-Options:
// nosniff 로 서빙한다(Supabase Storage 의 기본 동작으로 보인다 — 확장자만으로 정확한
// text/html 을 항상 보장하지 않는다). nosniff 가 붙으면 브라우저는 절대 내용을 보고
// HTML로 추론하지 않고 그대로 평문 렌더링한다. 그래서 upstream 의 헤더는 "본문을 얻기
// 위해 거쳐가는 것"일 뿐 우리 응답에 절대 반영하면 안 된다 — upstreamHeaders 필드는
// 그 사실을 deps 계약에 명시하고 테스트가 "받아도 무시하는지"를 증명할 수 있게 하기
// 위해 존재한다(실제로 이 값을 최종 응답에 쓰지 않는다 — 아래 buildResponseHeaders 참고).
export type FetchHtmlResult = {
  ok: boolean;
  status: number;
  text?: string;
  upstreamHeaders?: Record<string, string>;
};

export type BoardHandlerDeps = {
  fetchHtml(): Promise<FetchHtmlResult>;
};

// 이 함수가 최종 응답에 실제로 쓰는 헤더는 이 두 개뿐이다 — upstream(Storage)이 무엇을
// 보내든 절대 안 섞는다(실측 버그의 직접적인 수정). cache-control: no-store 는 이 버그를
// 조사하며 확인된 GET/HEAD 응답 불일치 가능성(CDN·엣지 캐시가 메서드별로 다른 상태를
// 오래 들고 있을 수 있다)을 원천 차단하기 위해 추가했다 — 이 페이지는 방장이 열 때마다
// Storage 원본을 그대로 반영해야 하므로 애초에 캐시할 이유가 없다.
function boardResponseHeaders(): HeadersInit {
  return { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
}

export async function handleBoardRequest(req: Request, deps: BoardHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }

  const upstream = await deps.fetchHtml();
  if (!upstream.ok || typeof upstream.text !== "string") {
    console.error(`board: upstream fetch failed (status ${upstream.status})`);
    // 방장에게 원인을 노출하지 않되(Storage 경로·버킷 구조 등), 완전한 침묵보다는 나은
    // 최소한의 안내를 준다. Content-Type 을 text/html 로 유지해 WebView 가 빈 화면 대신
    // 이 문구를 실제로 렌더링하게 한다.
    return new Response("<!doctype html><meta charset=utf-8><p>협업 운영센터를 잠시 불러올 수 없습니다. 잠시 후 다시 열어주세요.</p>", {
      status: 502,
      headers: boardResponseHeaders()
    });
  }

  return new Response(upstream.text, {
    status: 200,
    headers: boardResponseHeaders()
  });
}
