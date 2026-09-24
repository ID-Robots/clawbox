import { expect, test } from "@playwright/test";
import { installClawboxMocks } from "../e2e/helpers/clawbox";
const SETUP = {
  timeoutCapMs: 300_000,
  chatFacts: { hasClawaiToken: true },
  initialSetup: { setup_complete: true, wifi_configured: true, update_completed: true, password_configured: true, ai_model_configured: true, telegram_configured: true },
  preferences: { desktop_apps: ["clawbox", "files", "settings"], wp_id: "clawbox" },
};
test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
for (const path of ["/", "/app/clawbox"]) {
  test(`strip geometry ${path}`, async ({ page }) => {
    await installClawboxMocks(page, SETUP);
    await page.goto(path);
    const strip = page.getByTestId("chat-header-strip");
    await expect(strip).toBeVisible();
    await page.waitForTimeout(1500);
    const g = await strip.evaluate(el => {
      const r = el.getBoundingClientRect();
      return {
        strip: { x: r.x, y: r.y, w: r.width, h: r.height },
        buttons: [...el.querySelectorAll("button")].map(b => { const q = b.getBoundingClientRect(); return { id: b.getAttribute("data-testid"), x: Math.round(q.x), y: Math.round(q.y), w: Math.round(q.width), h: Math.round(q.height), glyph: (() => { const s = b.querySelector(".material-symbols-rounded"); if (!s) return null; const z = s.getBoundingClientRect(); return { y: Math.round(z.y), h: Math.round(z.height), w: Math.round(z.width), font: getComputedStyle(s).fontFamily.slice(0, 30) }; })() }; }),
        scrollW: document.documentElement.scrollWidth,
      };
    });
    console.log(path, JSON.stringify(g));
  });
}
