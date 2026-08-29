import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MINIAPP_WEB_ASSETS } from "../../scripts/build-miniapp-web.mjs";

const html = await readFile(new URL("./egg-game.html", import.meta.url), "utf8");
const board = await readFile(new URL("./index.html", import.meta.url), "utf8");

test("게임은 배포되지만 모든 방이 공유하는 협업 운영센터에는 하드코딩하지 않는다", () => {
  assert.ok(MINIAPP_WEB_ASSETS.includes("egg-game.html"));
  assert.doesNotMatch(board, /href="\.\/egg-game\.html"/);
  assert.match(html, /href="\.\/index\.html"/);
});

test("모바일 입력은 pointerdown과 touch-action manipulation으로 즉시 처리한다", () => {
  assert.match(html, /touch-action:\s*manipulation/);
  assert.match(html, /addEventListener\("pointerdown"/);
  assert.doesNotMatch(html, /setTimeout\s*\(/);
});

test("터치와 동시에 Web Audio 효과음을 재생하고 미지원 환경에서도 입력을 유지한다", () => {
  assert.match(html, /window\.AudioContext \|\| window\.webkitAudioContext/);
  assert.match(html, /playTapSound\(stage \+ 1\);\s*stage \+= 1/);
  assert.match(html, /catch \(_\)/);
  assert.doesNotMatch(html, /new Audio\s*\(/);
});

test("게임은 두 단계 파손과 재시작·키보드 click 경로를 제공한다", () => {
  assert.match(html, /data-stage="0"/);
  assert.match(html, /stage === 1/);
  assert.match(html, /stage >= 2/);
  assert.match(html, /reset\.addEventListener\("click"/);
  assert.match(html, /egg\.addEventListener\("click"/);
});

test("모션 접근성과 성능 레드플래그를 방지한다", () => {
  assert.match(html, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(html, /transition:\s*all/);
  assert.doesNotMatch(html, /scale\(0\)/);
  assert.doesNotMatch(html, /ease-in(?:\s|;)/);
});
