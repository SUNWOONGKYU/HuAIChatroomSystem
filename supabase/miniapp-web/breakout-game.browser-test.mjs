import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const port = process.env.CHROME_DEBUG_PORT || "9333";
const gameUrl = process.env.BREAKOUT_GAME_URL;
assert.ok(gameUrl, "BREAKOUT_GAME_URL is required");
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
assert.ok(page?.webSocketDebuggerUrl, "Chrome page target not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

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
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft" });
await wait(200);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft" });
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

const scoreText = await evaluate(`document.querySelector('#score').textContent`);
assert.equal(scoreText, "점수 " + latest.score, "score DOM text did not match internal score state");

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(new URL("./breakout-game-playing.png", import.meta.url), Buffer.from(shot.data, "base64"));

console.log(JSON.stringify({
  result: "pass",
  checks: ["initial-state", "mouse-paddle", "keyboard-paddle", "brick-collision", "score-increment", "sound-playback"],
  finalScore: latest.score,
  bricksDestroyed: 24 - latest.bricksLeft,
  audioStarts,
  screenshot: "breakout-game-playing.png"
}));
socket.close();
