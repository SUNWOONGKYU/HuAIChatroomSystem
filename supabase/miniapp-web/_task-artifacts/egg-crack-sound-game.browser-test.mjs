import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { startBrowserGameFixture } from "../browser-test-fixture.mjs";
import { chromium } from "playwright";

const fixture = await startBrowserGameFixture({ envName: "EGG_GAME_URL", fileName: "_task-artifacts/egg-crack-sound-game.html" });
const gameUrl = fixture.url;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
function send(method, params = {}) { return cdp.send(method, params); }

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

// 조건이 참이 될 때까지 짧게 폴링하고, 상한을 넘으면 무엇을 기다리다 실패했는지 밝히며 죽는다.
//
// 왜 고정 대기를 안 쓰는가: 고정 대기는 느린 순간에 아직 준비 안 된 상태로 평가를 시작해
// 실패했고, verify-operation-ready.mjs 의 내장 재시도가 그걸 삼켜 겉으로는 통과처럼 보였다
// (5차·6차 감사 연속 지적). 재시도가 flakiness 를 가리면 진짜 결함도 같이 가려진다.
async function waitUntil(expression, whatWeWaitedFor, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    let ready = false;
    try {
      ready = Boolean(await evaluate(expression));
    } catch {
      ready = false;
    }
    if (ready) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timeout(${timeoutMs}ms): ${whatWeWaitedFor} 기다리다 실패했다 — ${expression}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    window.__eggAudioStarts = 0;
    if (!NativeAudioContext) return;
    class TrackedAudioContext extends NativeAudioContext {
      createBufferSource() {
        const src = super.createBufferSource();
        const start = src.start.bind(src);
        src.start = (...args) => { window.__eggAudioStarts += 1; return start(...args); };
        return src;
      }
    }
    window.AudioContext = TrackedAudioContext;
    window.webkitAudioContext = TrackedAudioContext;
  })()`
});
await send("Page.navigate", { url: gameUrl });
await waitUntil(`document.readyState === "complete" && location.href === ${JSON.stringify(gameUrl)}`, "게임 페이지가 열리고 준비되기를");

assert.equal(await evaluate(`location.href`), gameUrl, "game page did not open from the given URL");

const initial = await evaluate(`({
  eggText: document.querySelector('#egg').textContent,
  resetVisible: getComputedStyle(document.querySelector('#reset')).display !== 'none',
  audioSupported: Boolean(window.AudioContext || window.webkitAudioContext),
  scoreText: document.querySelector('#score').textContent
})`);
assert.equal(initial.eggText, "🥚");
assert.equal(initial.resetVisible, false);
assert.equal(initial.audioSupported, true, "Web Audio is unavailable");
assert.equal(initial.scoreText, "🥚 0개", "initial score must show 0");

async function click(selector) {
  const center = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: center.x, y: center.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: center.x, y: center.y, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 60));
}

await click("#egg");
const afterFirst = await evaluate(`({ cls: document.querySelector('#egg').className, audioStarts: window.__eggAudioStarts })`);
assert.equal(afterFirst.cls, "crack1", "first click did not show crack1 state");
assert.equal(afterFirst.audioStarts, 1, "first click did not start a sound");

await click("#egg");
const afterSecond = await evaluate(`({
  cls: document.querySelector('#egg').className,
  eggText: document.querySelector('#egg').textContent,
  resetVisible: getComputedStyle(document.querySelector('#reset')).display !== 'none',
  audioStarts: window.__eggAudioStarts,
  scoreText: document.querySelector('#score').textContent
})`);
assert.equal(afterSecond.cls, "broken", "second click did not show broken state");
assert.equal(afterSecond.eggText, "🐣");
assert.equal(afterSecond.resetVisible, true, "reset button did not appear after breaking");
assert.equal(afterSecond.audioStarts, 2, "second click did not start a sound");
assert.equal(afterSecond.scoreText, "🥚 1개", "score did not increment when the egg fully broke");

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(new URL("./egg-crack-sound-game-broken.png", import.meta.url), Buffer.from(shot.data, "base64"));

await click("#reset");
const afterReset = await evaluate(`({ cls: document.querySelector('#egg').className, eggText: document.querySelector('#egg').textContent, scoreText: document.querySelector('#score').textContent })`);
assert.equal(afterReset.cls, "");
assert.equal(afterReset.eggText, "🥚");
assert.equal(afterReset.scoreText, "🥚 1개", "score must stay cumulative across reset");

await click("#egg");
await click("#egg");
assert.equal(await evaluate(`document.querySelector('#score').textContent`), "🥚 2개", "score did not increment on second egg");

console.log(JSON.stringify({ result: "pass", stages: ["initial", "crack1", "broken", "reset"], audioStarts: afterSecond.audioStarts, screenshot: "egg-crack-sound-game-broken.png" }));
await page.close();
await fixture.close();
await browser.close();
