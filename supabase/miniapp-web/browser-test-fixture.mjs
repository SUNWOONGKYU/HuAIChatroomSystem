import { createReadStream } from "node:fs";
import { createServer } from "node:http";

// Browser tests default to an ephemeral loopback server. An explicitly supplied
// URL remains supported for an operator-run browser session; no public URL is
// embedded in the test suite.
export async function startBrowserGameFixture({ envName, fileName }) {
  const configuredUrl = process.env[envName];
  if (configuredUrl) return { url: configuredUrl, close: async () => {} };

  const fileUrl = new URL(`./${fileName}`, import.meta.url);
  const server = createServer((request, response) => {
    // 쿼리스트링(?fn=…)이 붙어도 같은 파일이다 — 운영센터 페이지는 함수 베이스를 쿼리로 받는다.
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname !== `/${fileName}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    createReadStream(fileUrl).pipe(response);
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  return {
    url: `http://127.0.0.1:${port}/${fileName}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
