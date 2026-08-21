import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureScreenshots } from "../src/executor.js";
import { createPlaywrightScreenshotCapturer } from "../src/screenshot.js";
import { type ArtifactManifest } from "../../../packages/contracts/src/index.js";

// 배포된 .html 산출물마다 미리보기 스크린샷을 별도 산출물로 만든다. 실제 브라우저를
// 띄우지 않고, 캡처기 자체는 가짜로 대신한다 — 여기서 검증할 것은 "어떤 산출물을
// 골라 어떤 이름으로 저장하는가"지 playwright 가 잘 도는가가 아니다(그건 screenshot.ts
// 자체의 관심사이고, 실제 chromium 은 운영 환경 의존이라 유닛테스트 대상이 아니다).

function fakeArtifact(overrides: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return { path: "index.html", sizeBytes: 10, checksum: "abc", version: "attempt-1", ...overrides };
}

test("배포 주소가 있는 .html 산출물만 스크린샷을 찍는다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-screenshot-test-"));
  try {
    const captured: Array<{ url: string; outPath: string }> = [];
    const capturer = {
      async capture(input: { url: string; outPath: string }) {
        captured.push(input);
        writeFileSync(input.outPath, Buffer.from("fake-png-bytes"));
      }
    };

    const artifacts = [
      fakeArtifact({ path: "index.html" }),
      fakeArtifact({ path: "readme.md" }), // .html 아님 — 스킵
      fakeArtifact({ path: "unpublished.html" }) // publicUrl 없음 — 스킵
    ];
    const publishedUrlByPath = new Map([["index.html", "https://example.vercel.app/index.html"]]);

    const results = await captureScreenshots(capturer, artifacts, publishedUrlByPath, dir);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://example.vercel.app/index.html");
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "index-preview.png");
    assert.equal(results[0].sizeBytes, Buffer.from("fake-png-bytes").length);
    assert.match(results[0].uri ?? "", /index-preview\.png$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("파일명이 -broken/-debug 같은 작업 부산물 패턴에 안 걸리는 -preview 접미사를 쓴다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-screenshot-test-"));
  try {
    mkdirSync(path.join(dir, "games"), { recursive: true });
    const capturer = { async capture(input: { outPath: string }) { writeFileSync(input.outPath, Buffer.from("x")); } };
    const results = await captureScreenshots(
      capturer,
      [fakeArtifact({ path: "games/egg-game.html" })],
      new Map([["games/egg-game.html", "https://x.vercel.app/egg-game.html"]]),
      dir
    );
    assert.equal(results[0].path, "games/egg-game-preview.png");
    assert.doesNotMatch(results[0].path, /-broken|-debug|-temp|-tmp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("캡처가 실패해도(예: chromium 없음) 던지지 않고 그 산출물만 건너뛴다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-screenshot-test-"));
  try {
    const capturer = { async capture() { throw new Error("browserType.launch: executable doesn't exist"); } };
    const results = await captureScreenshots(
      capturer,
      [fakeArtifact({ path: "a.html" }), fakeArtifact({ path: "b.html" })],
      new Map([
        ["a.html", "https://x.vercel.app/a.html"],
        ["b.html", "https://x.vercel.app/b.html"]
      ]),
      dir
    );
    assert.deepEqual(results, [], "실패한 캡처는 결과에서 조용히 빠져야 한다 — 실행 자체를 막으면 안 된다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("배포 주소가 하나도 없으면(vercelProject 미설정 등) 아무것도 찍지 않는다", async () => {
  const calls: unknown[] = [];
  const capturer = { async capture(input: unknown) { calls.push(input); } };
  const results = await captureScreenshots(capturer, [fakeArtifact()], new Map(), "C:\\irrelevant");
  assert.deepEqual(results, []);
  assert.equal(calls.length, 0);
});

// 가짜 캡처기 테스트는 우리 쪽 호출 규약만 보증한다. 진짜 chromium 이 실제로 페이지를
// 열고 픽셀을 남기는지는 여기서 확인한다 — 이 환경에 playwright chromium 이 설치돼
// 있으므로(오늘 세션에서 확인) 건너뛰지 않고 실행한다.
test("실제 playwright chromium 으로 데이터 URL 을 찍어 진짜 PNG 를 남긴다 (통합)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-screenshot-real-"));
  try {
    const capturer = createPlaywrightScreenshotCapturer({ timeoutMs: 15_000 });
    const html = "<html><body style='background:#1e90ff;width:200px;height:200px'></body></html>";
    const dataUrl = "data:text/html," + encodeURIComponent(html);
    const outPath = path.join(dir, "real-preview.png");

    await capturer.capture({ url: dataUrl, outPath });

    const { statSync } = await import("node:fs");
    const stat = statSync(outPath);
    assert.ok(stat.size > 0, "실제 PNG 바이트가 저장돼야 한다");

    const bytes = (await import("node:fs/promises")).readFile;
    const pngBytes = await bytes(outPath);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    assert.ok(pngBytes.subarray(0, 4).equals(pngSignature), "PNG 시그니처가 맞아야 진짜 이미지다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
