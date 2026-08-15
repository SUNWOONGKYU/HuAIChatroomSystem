import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FUNCTIONS_BASE_URL_PLACEHOLDER,
  MINIAPP_WEB_ASSETS,
  buildMiniAppWeb,
  renderMiniAppIndex,
  resolveFunctionsBaseUrl
} from "./build-miniapp-web.mjs";

test("derives the functions origin from SUPABASE_URL", () => {
  assert.equal(
    resolveFunctionsBaseUrl({ SUPABASE_URL: "https://smxtewoijwelmmpyogwt.supabase.co" }),
    "https://smxtewoijwelmmpyogwt.functions.supabase.co"
  );
  assert.equal(
    resolveFunctionsBaseUrl({ SUPABASE_URL: "https://abc.supabase.co/" }),
    "https://abc.functions.supabase.co"
  );
});

test("prefers an explicit override over the derived origin", () => {
  assert.equal(
    resolveFunctionsBaseUrl({
      SUPABASE_URL: "https://abc.supabase.co",
      MINIAPP_FUNCTIONS_BASE_URL: "https://other.functions.supabase.co/"
    }),
    "https://other.functions.supabase.co"
  );
});

test("rejects missing and malformed SUPABASE_URL", () => {
  assert.throws(() => resolveFunctionsBaseUrl({}), /missing-env:SUPABASE_URL/);
  assert.throws(
    () => resolveFunctionsBaseUrl({ SUPABASE_URL: "http://abc.supabase.co" }),
    /invalid-env:SUPABASE_URL/
  );
  assert.throws(
    () => resolveFunctionsBaseUrl({ SUPABASE_URL: "https://abc.example.com" }),
    /invalid-env:SUPABASE_URL/
  );
});

test("substitutes the placeholder and refuses to leave one behind", () => {
  const html = `var CONFIG = { functionsBaseUrl: "${FUNCTIONS_BASE_URL_PLACEHOLDER}" };`;
  const rendered = renderMiniAppIndex(html, "https://abc.functions.supabase.co");

  assert.match(rendered, /functionsBaseUrl: "https:\/\/abc\.functions\.supabase\.co"/);
  assert.equal(rendered.includes(FUNCTIONS_BASE_URL_PLACEHOLDER), false);
});

test("fails loudly when the source has no placeholder to fill", () => {
  // 소스에서 자리표시자가 사라지면(리팩터링·머지 사고) 조용히 원본을 그대로 배포해서
  // 라이브에서 "배포 설정이 끝나지 않았습니다"만 뜨는 상태가 된다. 그건 여기서 막는다.
  assert.throws(
    () => renderMiniAppIndex("var CONFIG = { functionsBaseUrl: \"\" };", "https://abc.functions.supabase.co"),
    /placeholder-not-found/
  );
});

test("builds only the publishable assets and writes hosting headers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "miniapp-build-"));
  const sourceDir = path.join(root, "src");
  const outDir = path.join(root, "out");
  await mkdir(sourceDir, { recursive: true });

  await writeFile(
    path.join(sourceDir, "index.html"),
    `<!doctype html><script>var CONFIG={functionsBaseUrl:"${FUNCTIONS_BASE_URL_PLACEHOLDER}"};</script>`,
    "utf8"
  );
  await writeFile(path.join(sourceDir, "egg-game.html"), "<!doctype html><title>egg</title>", "utf8");
  await writeFile(path.join(sourceDir, "robots.txt"), "User-agent: *\nDisallow: /\n", "utf8");
  // 배포되면 안 되는 것들 — 테스트 스크립트와 디버그 스크린샷.
  await writeFile(path.join(sourceDir, "egg-game.test.mjs"), "// test", "utf8");
  await writeFile(path.join(sourceDir, "egg-game-broken.png"), "png", "utf8");

  const result = await buildMiniAppWeb({
    sourceDir,
    outDir,
    env: { SUPABASE_URL: "https://smxtewoijwelmmpyogwt.supabase.co" }
  });

  assert.equal(result.functionsBaseUrl, "https://smxtewoijwelmmpyogwt.functions.supabase.co");
  assert.deepEqual((await readdir(outDir)).sort(), [...MINIAPP_WEB_ASSETS, "vercel.json"].sort());

  const builtIndex = await readFile(path.join(outDir, "index.html"), "utf8");
  assert.match(builtIndex, /https:\/\/smxtewoijwelmmpyogwt\.functions\.supabase\.co/);
  assert.equal(builtIndex.includes(FUNCTIONS_BASE_URL_PLACEHOLDER), false);

  const vercelConfig = JSON.parse(await readFile(path.join(outDir, "vercel.json"), "utf8"));
  const headers = vercelConfig.headers[0].headers.map((entry) => entry.key);
  assert.deepEqual(headers.sort(), ["Cache-Control", "X-Robots-Tag"]);
});

test("the shipped board page hardcodes no per-room artifact links", async () => {
  // 작업판 한 벌을 21개 방이 공유한다. 마크업에 특정 방의 산출물 링크를 박으면 그
  // 산출물과 무관한 모든 방의 화면에 뜬다 — 달걀깨기 미니게임 링크가 실제로 그렇게
  // 새어나가서 라이브에서 잡혔다. 방이 보는 것은 roomId 로 조회해 서버가 멤버십을
  // 검증한 데이터뿐이어야 한다.
  const html = await readFile("supabase/miniapp-web/index.html", "utf8");
  const staticLinks = [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].map((match) => match[1]);
  const siblingPageLinks = staticLinks.filter((href) => /\.html(\?|#|$)/i.test(href));

  assert.deepEqual(
    siblingPageLinks,
    [],
    `작업판 마크업에 하드코딩된 페이지 링크가 있다: ${siblingPageLinks.join(", ")}`
  );
});

test("the shipped page still carries the placeholder the build fills", async () => {
  // 이 테스트가 소스와 빌드를 묶는다. 누가 index.html 의 CONFIG 를 바꾸면
  // 배포 파이프라인이 조용히 무력화되는데, 그걸 커밋 전에 잡는다.
  const html = await readFile("supabase/miniapp-web/index.html", "utf8");
  assert.equal(html.includes(FUNCTIONS_BASE_URL_PLACEHOLDER), true);
});
