import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { startBrowserGameFixture } from "./browser-test-fixture.mjs";
import { chromium } from "playwright";

const fixture = await startBrowserGameFixture({ envName: "EGG_GAME_URL", fileName: "egg-game.html" });
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

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    window.__eggAudioStarts = 0;
    if (!NativeAudioContext) return;
    class TrackedAudioContext extends NativeAudioContext {
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...args) => {
          window.__eggAudioStarts += 1;
          return start(...args);
        };
        return oscillator;
      }
    }
    window.AudioContext = TrackedAudioContext;
    window.webkitAudioContext = TrackedAudioContext;
  })()`
});
await send("Page.navigate", { url: gameUrl });
await new Promise((resolve) => setTimeout(resolve, 500));

assert.equal(await evaluate(`location.href`), gameUrl, "game page did not open from the execution URL");

const initial = await evaluate(`({
  stage: document.querySelector('#egg').dataset.stage,
  width: document.documentElement.scrollWidth,
  viewport: document.documentElement.clientWidth,
  touchAction: getComputedStyle(document.querySelector('#egg')).touchAction,
  targetWidth: document.querySelector('#egg').getBoundingClientRect().width
  ,audioSupported: Boolean(window.AudioContext || window.webkitAudioContext)
  ,scoreText: document.querySelector('#score').textContent
})`);
assert.equal(initial.stage, "0");
assert.equal(initial.scoreText, "🥚 0개", "initial score must show 0");
assert.equal(initial.width, initial.viewport, "mobile horizontal overflow detected");
assert.equal(initial.touchAction, "manipulation");
assert.ok(initial.targetWidth >= 44);
assert.equal(initial.audioSupported, true, "Web Audio is unavailable in this browser");

async function centerOf(selector) {
  return evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
}

async function tap(selector) {
  const center = await centerOf(selector);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: center.x, y: center.y }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((resolve) => setTimeout(resolve, 40));
}

await tap("#egg");
// 두 값을 한 번에 읽는다 — 따로 읽으면 그 사이에 늦게 도착한 합성 click 이 끼어들어
// stage 는 1, 소리는 2 로 어긋나게 보일 수 있다(병렬 실행에서 실측).
const firstTap = await evaluate(`({ stage: document.querySelector('#egg').dataset.stage, audioStarts: window.__eggAudioStarts })`);
assert.equal(firstTap.stage, "1");
assert.equal(firstTap.audioStarts, 1, "first tap did not start exactly one sound");
await tap("#egg");
const broken = await evaluate(`({
  stage: document.querySelector('#egg').dataset.stage,
  resetVisible: !document.querySelector('#reset').hidden,
  latency: Number((document.querySelector('#latency').textContent.match(/\\d+/)||[])[0]),
  audioStarts: window.__eggAudioStarts,
  scoreText: document.querySelector('#score').textContent
})`);
assert.equal(broken.stage, "2");
assert.equal(broken.resetVisible, true);
assert.ok(Number.isFinite(broken.latency) && broken.latency < 100, `visual response was ${broken.latency}ms`);
assert.equal(broken.audioStarts, 2, "each egg tap must start one sound");
assert.equal(broken.scoreText, "🥚 1개", "score did not increment when the egg fully broke");

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(new URL("./_task-artifacts/egg-game-broken.png", import.meta.url), Buffer.from(shot.data, "base64"));

await tap("#reset");
assert.equal(await evaluate(`document.querySelector('#egg').dataset.stage`), "0");
assert.equal(await evaluate(`window.__eggAudioStarts`), 3, "reset tap did not start its sound");
assert.equal(await evaluate(`document.querySelector('#score').textContent`), "🥚 1개", "score must stay cumulative across reset");

await tap("#egg");
await tap("#egg");
assert.equal(await evaluate(`document.querySelector('#score').textContent`), "🥚 2개", "score did not increment on second egg");

console.log(JSON.stringify({ result: "pass", viewport: "390x844", stages: [0, 1, 2, 0], latencyMs: broken.latency, screenshot: "egg-game-broken.png" }));
await page.close();
await fixture.close();
await browser.close();
