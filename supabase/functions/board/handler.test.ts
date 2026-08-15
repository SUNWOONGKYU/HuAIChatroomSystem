// handleBoardRequest 회귀 테스트. 실행 방법은 ../_shared/proposal-payload.test.ts 상단
// 주석 참고(스크래치 디렉터리 복사 + .ts 확장자 제거 + tsc + node --test).
//
// 핵심 회귀 대상(팀장님 지시 그대로):
//   - Content-Type: text/html 로 응답한다 — GET 과 HEAD 둘 다 각각 확인한다(실측 버그가
//     정확히 이 둘의 불일치였다 — GET 은 text/plain+nosniff, HEAD 는 text/html)
//   - upstream(Storage)이 어떤 헤더를 실어 보내도(text/plain, X-Content-Type-Options:
//     nosniff 포함) 최종 응답 헤더에는 절대 안 섞인다
//   - 업스트림이 준 HTML 본문을 그대로(변형 없이) 돌려준다
//   - 요청 URL에 쿼리 파라미터(tgWebAppStartParam 등)가 있어도 정상 200 — 그리고 그
//     쿼리 유무가 응답에 어떤 영향도 안 준다(이 함수가 쿼리를 읽지 않는다는 것의 증명)
//   - 인증 헤더 없이 200 — 이 함수에 auth 게이트가 없다는 것의 증명
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { handleBoardRequest, type BoardHandlerDeps, type FetchHtmlResult } from "./handler";

// __dirname 은 CommonJS 전역이다(이 파일은 node --test 실행을 위해 CommonJS 로 컴파일된다 —
// proposal-payload.test.ts 상단 주석의 실행 절차 참고). import.meta.url 은 module 옵션이
// ESNext 계열일 때만 허용돼 여기선 못 쓴다.
declare const __dirname: string;

const SAMPLE_HTML = "<!doctype html><html><body>테스트 작업판</body></html>";

// 실측 버그를 그대로 재현하는 "적대적" 업스트림 응답 — Storage 가 실제로 이 헤더를 보낸다.
// nosniff 가 붙으면 브라우저가 절대 HTML 로 추론하지 않으므로, 이게 최종 응답에 안 섞이는
// 것이 이번 수정의 핵심이다.
const HOSTILE_UPSTREAM_HEADERS = { "content-type": "text/plain; charset=UTF-8", "x-content-type-options": "nosniff" };

function makeDeps(overrides: Partial<BoardHandlerDeps> = {}): BoardHandlerDeps {
  const fetchHtml: () => Promise<FetchHtmlResult> = async () => ({
    ok: true,
    status: 200,
    text: SAMPLE_HTML,
    upstreamHeaders: HOSTILE_UPSTREAM_HEADERS
  });
  return { fetchHtml, ...overrides };
}

function req(url: string, init: RequestInit = {}): Request {
  // 의도적으로 authorization 헤더를 안 붙인다 — 인증 없이 통과하는지가 이 테스트의 요점이다.
  return new Request(url, { method: "GET", ...init });
}

test("인증 헤더 없이 200을 반환한다 (이 함수엔 auth 게이트가 없다)", async () => {
  const res = await handleBoardRequest(req("https://x/board"), makeDeps());
  assert.equal(res.status, 200);
});

// ── 실측 버그(GET 은 text/plain+nosniff, HEAD 는 text/html) 직접 재현 + 수정 증명 ──
// makeDeps() 의 기본 fetchHtml 이 이미 HOSTILE_UPSTREAM_HEADERS(text/plain+nosniff)를
// 싣고 있다 — 즉 "upstream 이 나쁜 헤더를 줘도" 라는 전제가 모든 테스트에 깔려 있다.

test("GET — Content-Type: text/html, upstream의 nosniff가 안 섞인다", async () => {
  const res = await handleBoardRequest(req("https://x/board", { method: "GET" }), makeDeps());
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/, "GET 응답이 upstream의 text/plain을 물려받으면 안 된다(실측 버그 그 자체)");
  assert.equal(res.headers.get("x-content-type-options"), null, "nosniff가 섞이면 브라우저가 절대 HTML로 렌더링하지 않는다");
});

test("HEAD — Content-Type: text/html, upstream의 nosniff가 안 섞인다 (GET과 동일해야 한다)", async () => {
  const res = await handleBoardRequest(req("https://x/board", { method: "HEAD" }), makeDeps());
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(res.headers.get("x-content-type-options"), null);
});

test("GET과 HEAD는 완전히 같은 헤더를 낸다 (이번 버그의 본질 — 둘이 갈리면 안 된다)", async () => {
  const deps = makeDeps();
  const getRes = await handleBoardRequest(req("https://x/board", { method: "GET" }), deps);
  const headRes = await handleBoardRequest(req("https://x/board", { method: "HEAD" }), deps);
  assert.equal(getRes.headers.get("content-type"), headRes.headers.get("content-type"));
  assert.equal(getRes.headers.get("x-content-type-options"), headRes.headers.get("x-content-type-options"));
  assert.equal(getRes.status, headRes.status);
});

test("cache-control: no-store — 방장이 열 때마다 최신 Storage 원본을 반영해야 한다(캐시로 인한 GET/HEAD 상태 불일치 재발 방지)", async () => {
  const res = await handleBoardRequest(req("https://x/board", { method: "GET" }), makeDeps());
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("업스트림 HTML 본문을 그대로(가공 없이) 돌려준다", async () => {
  const res = await handleBoardRequest(req("https://x/board"), makeDeps());
  const body = await res.text();
  assert.equal(body, SAMPLE_HTML);
});

test("쿼리 파라미터(tgWebAppStartParam 등)가 있어도 정상 200이고 본문은 쿼리 없을 때와 동일하다", async () => {
  const deps = makeDeps();
  const withoutQuery = await handleBoardRequest(req("https://x/board"), deps);
  const withQuery = await handleBoardRequest(
    req("https://x/board?tgWebAppStartParam=847d1638-d23b-43a8-a445-54ecb29560f7&foo=bar"),
    deps
  );
  assert.equal(withQuery.status, 200);
  assert.equal(await withoutQuery.text(), await withQuery.text());
  // 이 핸들러가 쿼리를 읽지 않는다는 것 자체가 "삼키지 않는다"의 증명이다 — 쿼리는
  // 브라우저가 유지하는 문서 URL(location.search)의 몫이지 이 응답 바디의 몫이 아니다.
});

test("업스트림(Storage) fetch 실패 시 502를 반환하되 text/html 로 안내문을 준다(빈 화면 대신)", async () => {
  const deps = makeDeps({ fetchHtml: async () => ({ ok: false, status: 404 }) });
  const res = await handleBoardRequest(req("https://x/board"), deps);
  assert.equal(res.status, 502);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  const body = await res.text();
  assert.ok(body.length > 0);
});

test("POST 등 GET/HEAD 이외 메서드는 405", async () => {
  const res = await handleBoardRequest(req("https://x/board", { method: "POST" }), makeDeps());
  assert.equal(res.status, 405);
});

test("OPTIONS 프리플라이트는 CORS 헤더와 함께 처리된다(해로울 것 없어 유지, 팀장님 언급대로)", async () => {
  const res = await handleBoardRequest(req("https://x/board", { method: "OPTIONS" }), makeDeps());
  assert.notEqual(res.status, 405);
});

// 실제 배포 페이지와의 정합성 — Storage 에 실제로 올라가는 파일과 이 함수가 "그대로
// 돌려준다"는 계약을 지키는지, 실제 index.html 파일 텍스트로도 확인한다(가짜 샘플만이
// 아니라). Node 파일시스템으로 직접 읽는다 — Deno 의존 없음.
//
// 경로: 이 테스트 파일은 회귀 테스트 실행 시 스크래치 디렉터리로 복사되어 컴파일되므로
// (proposal-payload.test.ts 상단 주석 참고) supabase/miniapp-web/ 을 상대경로로 못 찾을 수
// 있다 — 그 경우 이 서브테스트만 건너뛴다(다른 테스트는 이 파일 없이도 유효하다). 실제
// 저장소 안에서 돌릴 때는(또는 MINIAPP_INDEX_HTML_PATH 환경변수로 절대경로를 주면) 그대로
// 실행된다.
test("실제 supabase/miniapp-web/index.html 내용을 업스트림으로 줘도 한 글자도 안 바뀐 채 반환된다", async (t) => {
  const candidatePath = process.env.MINIAPP_INDEX_HTML_PATH || path.join(__dirname, "..", "..", "miniapp-web", "index.html");
  if (!fs.existsSync(candidatePath)) {
    t.skip(`index.html을 ${candidatePath}에서 못 찾음 — 스크래치 복사본에는 miniapp-web/이 없다. MINIAPP_INDEX_HTML_PATH로 절대경로를 지정하면 실행된다.`);
    return;
  }
  const realHtml = fs.readFileSync(candidatePath, "utf8");

  const deps = makeDeps({ fetchHtml: async () => ({ ok: true, status: 200, text: realHtml }) });
  const res = await handleBoardRequest(req("https://x/board"), deps);
  const body = await res.text();
  assert.equal(body, realHtml);
  assert.equal(body.length, realHtml.length);
});
