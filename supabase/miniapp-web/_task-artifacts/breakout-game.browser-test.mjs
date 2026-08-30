import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { startBrowserGameFixture } from "../browser-test-fixture.mjs";
import { chromium } from "playwright";

const fixture = await startBrowserGameFixture({ envName: "BREAKOUT_GAME_URL", fileName: "_task-artifacts/breakout-game.html" });
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    window.__breakoutAudioStarts = 0;
    if (!NativeAudioContext) return;
    class TrackedAudioContext extends NativeAudioContext {
      createOscillator() {
        const osc = super.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (...args) => { window.__breakoutAudioStarts += 1; return start(...args); };
        return osc;
      }
    }
    window.AudioContext = TrackedAudioContext;
    window.webkitAudioContext = TrackedAudioContext;
  })()`
});
await send("Page.navigate", { url: gameUrl });
await new Promise((resolve) => setTimeout(resolve, 500));

assert.equal(await evaluate(`location.href`), gameUrl, "game page did not open from the given URL");

const initial = await evaluate(`window.__breakout.getState()`);
assert.equal(initial.score, 0, "initial score must be 0");
assert.equal(initial.lives, 3, "initial lives must be 3");
assert.equal(initial.bricksLeft, 24, "initial brick count must be 24 (4 rows x 6 cols)");
assert.equal(await evaluate(`document.querySelector('#score').textContent`), "점수 0");
assert.equal(await evaluate(`document.querySelector('#lives').textContent`), "기회 3");

const audioSupported = await evaluate(`Boolean(window.AudioContext || window.webkitAudioContext)`);
assert.equal(audioSupported, true, "Web Audio is unavailable");

// --- paddle control: mouse ---
const canvasRect = await evaluate(`(() => {
  const r = document.querySelector('#board').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
const targetMouseX = canvasRect.x + 40;
const targetMouseY = canvasRect.y + canvasRect.height - 20;
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: targetMouseX, y: targetMouseY });
await wait(80);
const afterMouse = await evaluate(`window.__breakout.getState()`);
assert.ok(afterMouse.paddleX <= 10, `paddle did not follow mouse to the left edge (paddleX=${afterMouse.paddleX})`);

const targetMouseX2 = canvasRect.x + canvasRect.width - 40;
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: targetMouseX2, y: targetMouseY });
await wait(80);
const afterMouse2 = await evaluate(`window.__breakout.getState()`);
assert.ok(afterMouse2.paddleX > afterMouse.paddleX, "paddle did not move right when mouse moved right");

// --- paddle control: keyboard ---
await page.keyboard.down("ArrowLeft");
await wait(200);
await page.keyboard.up("ArrowLeft");
const afterKey = await evaluate(`window.__breakout.getState()`);
assert.ok(afterKey.paddleX < afterMouse2.paddleX, "paddle did not move left on ArrowLeft key hold");

// --- ball collision / brick destruction / score ---
let latest = await evaluate(`window.__breakout.getState()`);
const deadline = Date.now() + 8000;
while (latest.bricksLeft === 24 && Date.now() < deadline) {
  await wait(150);
  latest = await evaluate(`window.__breakout.getState()`);
}
assert.ok(latest.bricksLeft < 24, "ball did not break any brick within the wait window (no collision detected)");
assert.equal(latest.score, (24 - latest.bricksLeft) * 10, "score did not increase by 10 per destroyed brick");
assert.ok(latest.ballX >= 0 && latest.ballX <= canvasRect.width, "ball left the play field horizontally, collision handling broken");

const audioStarts = await evaluate(`window.__breakoutAudioStarts`);
assert.ok(audioStarts >= 1, `brick break did not play a sound (audioStarts=${audioStarts})`);

// State와 DOM을 서로 다른 animation frame에서 읽으면 다음 충돌이 끼어
// 점수만 한 단계 앞서 보일 수 있다. 한 번의 브라우저 평가에서 같은 시점의
// state/DOM을 함께 캡처해 비교한다.
const finalSnapshot = await evaluate(`(() => {
  const state = window.__breakout.getState();
  return { ...state, scoreText: document.querySelector('#score').textContent };
})()`);
assert.equal(finalSnapshot.score, (24 - finalSnapshot.bricksLeft) * 10, "score state did not match destroyed brick count");
assert.equal(finalSnapshot.scoreText, "점수 " + finalSnapshot.score, "score DOM text did not match internal score state");

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(new URL("./breakout-game-playing.png", import.meta.url), Buffer.from(shot.data, "base64"));

console.log(JSON.stringify({
  result: "pass",
  checks: ["initial-state", "mouse-paddle", "keyboard-paddle", "brick-collision", "score-increment", "sound-playback"],
  finalScore: finalSnapshot.score,
  bricksDestroyed: 24 - finalSnapshot.bricksLeft,
  audioStarts,
  screenshot: "breakout-game-playing.png"
}));
await page.close();
await fixture.close();
await browser.close();
