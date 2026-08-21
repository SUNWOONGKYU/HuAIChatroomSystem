// 배포된 웹 산출물을 실제로 열어 스크린샷을 찍는다.
//
// 왜 필요한가: 지금은 웹 산출물이 배포되면 링크 하나만 방에 온다. 방장이 폰에서 눌러
// 열어봐야만 실제로 뭐가 만들어졌는지 안다. 배포+미리보기까지 자동으로 붙이면(버즈가
// 하듯) 결과를 화면 전환 없이 바로 확인한다.
//
// Playwright chromium 하나로 충분하다 — 스크린샷 한 장 찍는 일에 별도 브라우저 자동화
// 인프라(웹세션-자동화 스킬의 CDP 상시 연결 Chrome)까지 끌어올 이유가 없다. 매 실행마다
// 새 headless 브라우저를 띄우고 바로 닫는다.

export type ScreenshotCapturer = {
  capture(input: { url: string; outPath: string }): Promise<void>;
};

export function createPlaywrightScreenshotCapturer(options: { timeoutMs?: number } = {}): ScreenshotCapturer {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return {
    async capture({ url, outPath }) {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
        await page.screenshot({ path: outPath });
      } finally {
        await browser.close();
      }
    }
  };
}

// playwright/chromium 이 아예 없는 환경(설치 안 됨)에서도 게이트웨이 기동 자체는
// 막지 않는다 — 스크린샷은 있으면 좋은 기능이지, 없으면 실행 자체를 못 하게 만들
// 이유가 아니다. 실제로 뜰 수 있는지 한 번 확인해보고, 안 되면 undefined 를 돌려준다.
export async function tryCreateScreenshotCapturer(
  options: { timeoutMs?: number } = {}
): Promise<ScreenshotCapturer | undefined> {
  try {
    await import("playwright");
    return createPlaywrightScreenshotCapturer(options);
  } catch {
    return undefined;
  }
}
