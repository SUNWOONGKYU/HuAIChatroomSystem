const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ args: ['--user-data-dir=C:/Dev/HuAIChatroomSystem/.pw-verify-profile'] });
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 400, height: 600 } });
  const page = await context.newPage();
  const filePath = 'file:///' + path.resolve('supabase/miniapp-web/breakout-game.html').replace(/\\/g, '/');
  await page.goto(filePath);

  const rect = await page.evaluate(() => {
    const c = document.getElementById('board');
    return { width: c.width, height: c.height };
  });
  console.log('canvas size', rect);

  // Read internal constants by re-declaring via page context is not possible (closure), so screenshot + pixel scan.
  await page.screenshot({ path: '_verify_before.png' });

  // Pixel-scan a vertical column at paddle center x to measure paddle thickness (color #118ab2 = rgb(17,138,178))
  const paddleInfo = await page.evaluate(() => {
    const c = document.getElementById('board');
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    // scan column x = width/2
    const x = Math.floor(c.width / 2);
    let rows = [];
    for (let y = 0; y < c.height; y++) {
      const idx = (y * c.width + x) * 4;
      const r = img[idx], g = img[idx+1], b = img[idx+2];
      if (r === 17 && g === 138 && b === 178) rows.push(y);
    }
    return { top: rows[0], bottom: rows[rows.length-1], thickness: rows.length, canvasHeight: c.height };
  });
  console.log('paddle pixel scan', paddleInfo);

  // Test touch drag moves paddle
  const canvasBox = await page.locator('#board').boundingBox();
  const beforeX = await page.evaluate(() => {
    // find leftmost paddle-colored pixel in bottom rows
    const c = document.getElementById('board');
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const y = c.height - 5;
    let left = -1, right = -1;
    for (let x = 0; x < c.width; x++) {
      const idx = (y * c.width + x) * 4;
      if (img[idx] === 17 && img[idx+1] === 138 && img[idx+2] === 178) {
        if (left === -1) left = x;
        right = x;
      }
    }
    return { left, right };
  });
  console.log('paddle x-range before touch', beforeX);

  // simulate touch move via dispatching touch events with CDP-ish approach: use page.touchscreen
  await page.touchscreen.tap(canvasBox.x + 20, canvasBox.y + canvasBox.height - 10);
  await page.waitForTimeout(100);

  const afterX = await page.evaluate(() => {
    const c = document.getElementById('board');
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    const y = c.height - 5;
    let left = -1, right = -1;
    for (let x = 0; x < c.width; x++) {
      const idx = (y * c.width + x) * 4;
      if (img[idx] === 17 && img[idx+1] === 138 && img[idx+2] === 178) {
        if (left === -1) left = x;
        right = x;
      }
    }
    return { left, right };
  });
  console.log('paddle x-range after touch tap near left', afterX);

  await page.screenshot({ path: '_verify_after_touch.png' });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
