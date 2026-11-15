import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { createDesktopStateMock, installClawboxMocks } from "./helpers/clawbox";

/**
 * The bottom shelf at any width (TASK-2565).
 *
 * The desktop bar's tray used to be `absolute`, over a row of apps centred on
 * the whole bar: between ~768 and ~1100 px with several apps the row slid under
 * the tray, and the crab and the clock sat on top of app icons. The assertions
 * here are geometry, not class names — a box that overlaps another, or that a
 * click on it would not reach, is the defect whatever produced it — and they run
 * over a matrix of sizes (phones, a foldable's two screens, tablets in both
 * orientations, laptop windows) with few apps and with many, because the bar
 * must be right by construction and not at the one size somebody screenshotted.
 *
 * Set SHELF_SHOTS_DIR to also write a picture of the bar at every size.
 */

const SETUP_DONE = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

/** [width, height] — the matrix, plus the edges of the 768 switch and a few awkward windows. */
const SIZES: Array<[number, number]> = [
  [280, 653], // a foldable's cover screen
  [320, 640],
  [375, 812],
  [400, 390], // nearly square: neither a portrait phone nor a wide window
  [412, 915],
  [600, 960],
  [667, 375], // a phone on its side
  [640, 400], // a 1280px laptop window at 200% zoom
  [767, 1024], // last width of the phone bar
  [768, 1024], // first width of the desktop bar
  [820, 1180],
  [853, 533], // a 1280px laptop window at 150% zoom
  [880, 1000], // a foldable's inner screen
  [1024, 768], // a 1280px window at 125%, a tablet on its side
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];

/** Pinned by default on the mocked OpenClaw box, as `pinned_apps` overrides turn them off. */
const DEFAULT_PINNED = ["clawbox", "openclaw", "hermes", "hermes-skills", "coding", "clawkeep", "memory-shard", "prime-radiant"];
const EXTRA_APPS = ["terminal", "browser", "vnc", "screenshot", "chrome", "web"];

const SCENARIOS = {
  // Three apps: Settings, Files and the Store.
  few: {
    pinned: Object.fromEntries([...DEFAULT_PINNED.map((id) => [id, false]), ["settings", true], ["files", true], ["store", true]]),
    open: ["settings", "files", "store"],
  },
  // Every default pin, six more pinned, and a dozen windows open — on the phone
  // bar that is Settings and every OPEN app.
  many: {
    pinned: Object.fromEntries(EXTRA_APPS.map((id) => [id, true])),
    open: ["settings", "files", "store", "terminal", "browser", "coding", "clawkeep", "memory-shard", "prime-radiant", "openclaw", "vnc", "screenshot"],
  },
} as const;

interface Box { l: number; r: number; t: number; b: number }

interface Measure {
  width: number;
  flavour: "phone" | "desktop" | "none";
  bar: Box | null;
  launcher: Box | null;
  row: Box | null;
  rowScrolls: boolean;
  rowOverflowX: string;
  tray: Box | null;
  trayPosition: string;
  /** Visible tray controls, left to right. */
  trayButtons: Array<Box & { id: string; covered: string }>;
  /** App buttons wholly inside the row, and whether a click at their centre reaches them. */
  apps: Array<Box & { id: string; covered: string }>;
  appCount: number;
  launcherCovered: string;
  pageOverflow: number;
}

async function settle(page: Page) {
  // The shelf re-reads the width on `resize`; give layout two frames.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom };
    };
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    // "" when a click at the element's centre reaches it, else what answers instead.
    const covered = (el: Element) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && el.contains(hit)) return "";
      return hit ? `${hit.tagName.toLowerCase()}[${hit.getAttribute("data-testid") ?? hit.className}]` : "nothing";
    };
    const bar = document.querySelector("[data-mascot-ground]");
    const row = bar?.querySelector('[data-testid="shelf-desktop-apps"], [data-testid="shelf-mobile-apps"]') ?? null;
    const tray = bar?.querySelector('[data-testid="shelf-tray"]') ?? null;
    const launcher = bar?.querySelector('[data-testid="shelf-launcher-button"]') ?? null;
    const rowBox = row ? box(row) : null;
    const trayButtons = tray
      ? Array.from(tray.querySelectorAll('button, [data-testid="shelf-battery"]')).filter(shown).map((el) => ({
          ...box(el),
          id: el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? "?",
          covered: covered(el),
        }))
      : [];
    const apps = row
      ? Array.from(row.querySelectorAll('[data-testid^="shelf-app-"]')).filter((el) => {
          const b = box(el);
          return rowBox && b.l >= rowBox.l - 0.5 && b.r <= rowBox.r + 0.5;
        }).map((el) => ({ ...box(el), id: el.getAttribute("data-testid") ?? "?", covered: covered(el) }))
      : [];
    return {
      width: window.innerWidth,
      flavour: row?.getAttribute("data-testid") === "shelf-mobile-apps" ? "phone" : row ? "desktop" : "none",
      bar: bar ? box(bar) : null,
      launcher: launcher ? box(launcher) : null,
      row: rowBox,
      rowScrolls: row ? row.scrollWidth > row.clientWidth + 1 : false,
      rowOverflowX: row ? getComputedStyle(row).overflowX : "",
      tray: tray ? box(tray) : null,
      trayPosition: tray ? getComputedStyle(tray).position : "",
      trayButtons,
      apps,
      appCount: row ? row.querySelectorAll('[data-testid^="shelf-app-"]').length : 0,
      launcherCovered: launcher ? covered(launcher) : "no launcher",
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    } satisfies Measure;
  }) as Promise<Measure>;
}

function overlaps(a: Box, b: Box) {
  return a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
}


type Scenario = (typeof SCENARIOS)[keyof typeof SCENARIOS];

/** The desktop with a scenario's pins and open windows, on a 1280x800 screen. */
async function openDesktop(page: Page, scenario: Scenario) {
  const desktopState = createDesktopStateMock();
  desktopState.state = {
    v: 1,
    savedAt: 1_700_000_000_000,
    viewport: { width: 1280, height: 800 },
    windows: scenario.open.map((appId, i) => ({ id: `${appId}-${1_700_000_000_000 + i}`, appId, minimized: true })),
    focusedId: null,
  };
  await installClawboxMocks(page, {
    initialSetup: SETUP_DONE,
    preferences: { pinned_apps: scenario.pinned, ui_mascot_hidden: 1 },
    desktopState,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByTestId("shelf-power-button")).toBeVisible();
  // The mascot is a crab that walks on the shelf by design, a box of its own
  // that can stand over a button; it is not what is measured, and the hit
  // tests must see the shelf's buttons and not it.
  await page.addStyleTag({ content: "[data-mascot] { visibility: hidden !important; pointer-events: none !important; }" });
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`the shelf never overlaps itself at any size, with ${name} apps`, async ({ page }) => {
    test.setTimeout(180_000);
    await openDesktop(page, scenario);

    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await settle(page);
      const m = await measure(page);
      const at = `${name} apps at ${width}x${height}`;

      // The 768 switch: below it the phone bar, from it the desktop one.
      expect(m.flavour, `${at}: which bar`).toBe(width < 768 ? "phone" : "desktop");
      expect(m.bar, `${at}: the bar is drawn`).not.toBeNull();
      expect(m.row && m.tray && m.launcher, `${at}: launcher, app row and tray are all there`).toBeTruthy();

      // The tray takes part in layout: nothing is drawn on top of the apps by
      // lifting the tray out of the row.
      expect(m.trayPosition, `${at}: the tray is in flow`).not.toBe("absolute");
      expect(m.rowOverflowX, `${at}: the app row scrolls instead of overflowing`).toBe("auto");

      const { launcher, row, tray } = m as { launcher: Box; row: Box; tray: Box };
      // Bounded on both sides: the launcher, then the apps, then the tray.
      expect(launcher.r, `${at}: the apps start after the launcher`).toBeLessThanOrEqual(row.l + 0.5);
      const firstTray = m.trayButtons[0];
      expect(firstTray, `${at}: the tray is not empty`).toBeTruthy();
      expect(row.r, `${at}: the apps end before the tray's first button`).toBeLessThanOrEqual(firstTray.l + 0.5);
      expect(row.r, `${at}: the apps end before the tray`).toBeLessThanOrEqual(tray.r + 0.5);

      // The whole bar is on screen: nothing pushed past either edge, the page
      // does not grow a sideways scroll.
      expect(launcher.l, `${at}: launcher inside the left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(Math.max(...m.trayButtons.map((b) => b.r)), `${at}: tray inside the right edge`).toBeLessThanOrEqual(width + 0.5);
      expect(m.pageOverflow, `${at}: no sideways page scroll`).toBeLessThanOrEqual(0);

      // The buttons that never leave the tray are always there.
      const ids = m.trayButtons.map((b) => b.id);
      expect(ids, `${at}: power stays`).toContain("shelf-power-button");

      // No two tray controls overlap, and a click at the centre of every
      // visible control — launcher, apps in view, tray — reaches that control.
      for (let i = 0; i < m.trayButtons.length; i++) {
        for (let j = i + 1; j < m.trayButtons.length; j++) {
          expect(overlaps(m.trayButtons[i], m.trayButtons[j]), `${at}: ${m.trayButtons[i].id} over ${m.trayButtons[j].id}`).toBe(false);
        }
      }
      expect(m.launcherCovered, `${at}: what answers a click on the launcher instead of it`).toBe("");
      for (const b of [...m.trayButtons, ...m.apps]) {
        expect(b.covered, `${at}: what answers a click on ${b.id} instead of it`).toBe("");
      }
      expect(m.apps.length, `${at}: some app is in view`).toBeGreaterThan(0);

      // A row that has more apps than room is a scroller, not a pile.
      if (m.apps.length < m.appCount) expect(m.rowScrolls, `${at}: hidden apps are scrolled to, not clipped`).toBe(true);

      const dir = process.env.SHELF_SHOTS_DIR;
      if (dir) {
        await page.screenshot({
          path: `${dir}/shelf-${name}-${width}x${height}.png`,
          clip: { x: 0, y: Math.max(0, height - 96), width, height: Math.min(96, height) },
        });
        if ((width === 880 && height === 1000) || (width === 1280 && height === 800)) {
          await page.screenshot({ path: `${dir}/full-${name}-${width}x${height}.png` });
        }
      }
    }
  });
}

test("a row that scrolls still names its apps, and a wheel scrolls it", async ({ page }) => {
  await openDesktop(page, SCENARIOS.many);
  await page.setViewportSize({ width: 880, height: 1000 });
  await settle(page);

  const row = page.getByTestId("shelf-desktop-apps");
  const m = await measure(page);
  expect(m.rowScrolls, "a dozen apps do not fit beside the tray at 880px").toBe(true);

  // The hover name sits above the bar, outside the row that would clip it.
  const first = page.getByTestId("shelf-app-settings");
  await first.hover();
  const tip = page.getByTestId("shelf-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText("Settings");
  const tipBox = (await tip.boundingBox())!;
  const barBox = (await page.locator("[data-mascot-ground]").boundingBox())!;
  expect(tipBox.y + tipBox.height, "the name is drawn above the bar").toBeLessThanOrEqual(barBox.y + 0.5);
  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0);

  // A mouse wheel has no sideways: turned into the row's own scroll, it reaches
  // the apps the row scrolled away.
  const before = await row.evaluate((el) => el.scrollLeft);
  const rowBox = (await row.boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
});
