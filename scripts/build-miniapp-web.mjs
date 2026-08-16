import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Mini App 페이지는 *.supabase.co 에 호스팅할 수 없다 — 그 도메인이 text/html 응답을
// text/plain + nosniff 로 덮어써서 브라우저가 소스를 그대로 보여준다(Storage·Edge
// Function 양쪽 동일, 라이브 확인). 그래서 페이지는 외부 정적 호스팅(Vercel)에 올리고
// 데이터만 <ref>.functions.supabase.co 에서 가져온다.
//
// 그 결과 페이지 오리진과 함수 오리진이 갈라져서, 예전처럼 same-origin 상대경로로
// 갈 수 없다. index.html 의 자리표시자를 배포 시점에 실제 함수 베이스로 바꿔야 한다.
// 자리표시자를 소스에 남겨두는 이유는 도메인이 환경별로 다르기 때문이다 — 소스에
// 박아버리면 프로젝트를 옮길 때마다 프로덕션 코드를 고쳐야 한다.
export const FUNCTIONS_BASE_URL_PLACEHOLDER = "__MINIAPP_FUNCTIONS_BASE_URL__";

// 이 목록에 없는 파일은 배포되지 않는다. miniapp-web/ 에는 테스트 스크립트(.mjs)와
// 디버그 스크린샷(.png)도 같이 있는데, 그것들이 공개 호스팅에 딸려 올라가면 안 된다.
export const MINIAPP_WEB_ASSETS = ["index.html", "egg-game.html", "robots.txt"];

export function resolveFunctionsBaseUrl(env = {}) {
  // 명시 지정이 우선. 함수만 다른 프로젝트에 두는 구성을 막지 않는다.
  const explicit = (env.MINIAPP_FUNCTIONS_BASE_URL ?? "").trim();
  if (explicit) return stripTrailingSlash(explicit);

  const supabaseUrl = (env.SUPABASE_URL ?? "").trim();
  if (!supabaseUrl) throw new Error("missing-env:SUPABASE_URL");

  // https://<ref>.supabase.co → https://<ref>.functions.supabase.co
  const match = /^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i.exec(supabaseUrl);
  if (!match) throw new Error(`invalid-env:SUPABASE_URL:${supabaseUrl}`);
  return `https://${match[1]}.functions.supabase.co`;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

export function renderMiniAppIndex(html, functionsBaseUrl) {
  if (!html.includes(FUNCTIONS_BASE_URL_PLACEHOLDER)) {
    throw new Error("placeholder-not-found:" + FUNCTIONS_BASE_URL_PLACEHOLDER);
  }
  const rendered = html.split(FUNCTIONS_BASE_URL_PLACEHOLDER).join(functionsBaseUrl);

  // 치환 후에도 자리표시자가 남아 있으면 배포하면 안 된다. 페이지는 열리는데
  // 데이터만 영영 안 오는 상태가 되고, 원인이 화면에 안 보인다.
  if (rendered.includes(FUNCTIONS_BASE_URL_PLACEHOLDER)) {
    throw new Error("placeholder-still-present");
  }
  return rendered;
}

export async function buildMiniAppWeb({ sourceDir, outDir, env = {} }) {
  const functionsBaseUrl = resolveFunctionsBaseUrl(env);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const asset of MINIAPP_WEB_ASSETS) {
    const from = path.join(sourceDir, asset);
    const to = path.join(outDir, asset);
    if (asset === "index.html") {
      const html = await readFile(from, "utf8");
      await writeFile(to, renderMiniAppIndex(html, functionsBaseUrl), "utf8");
    } else {
      await copyFile(from, to);
    }
  }

  // 정적 호스팅에서 헤더를 우리가 소유한다. no-store 는 작업 현황판이 낡은 목록을
  // 보여주지 않게 하려는 것이고, noindex 는 방 링크가 검색에 뜨지 않게 하려는 것이다.
  await writeFile(
    path.join(outDir, "vercel.json"),
    JSON.stringify(
      {
        $schema: "https://openapi.vercel.sh/vercel.json",
        headers: [
          {
            source: "/(.*)",
            headers: [
              { key: "X-Robots-Tag", value: "noindex, nofollow" },
              { key: "Cache-Control", value: "no-store" }
            ]
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return { functionsBaseUrl, files: (await readdir(outDir)).sort() };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const sourceDir = process.argv[2] ?? "supabase/miniapp-web";
  const outDir = process.argv[3] ?? "dist/miniapp-web";
  const result = await buildMiniAppWeb({ sourceDir, outDir, env: process.env });
  console.log(`functionsBaseUrl=${result.functionsBaseUrl}`);
  console.log(`outDir=${outDir}`);
  console.log(`files=${result.files.join(", ")}`);
}
