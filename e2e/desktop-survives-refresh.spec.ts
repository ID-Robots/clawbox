import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { createDesktopStateMock, installClawboxMocks, openLauncher, type DesktopStateMock } from "./helpers/clawbox";
import { routeTerminalToBackend, startTerminalBackend, type TerminalBackend, type TerminalWire } from "./helpers/terminal-backend";

/**
 * TASK-1306: open windows and running terminals survive a refresh of the
 * desktop — F5, and a tab closed and opened again — with the same positions,
 * sizes, stacking and focus, and every terminal still running what it ran,
 * its output carried on through the refresh.
 *
 * The terminals are REAL: scripts/terminal-server.mjs (or, on a machine
 * without node-pty, the same session protocol over bash on pipes) behind a
 * bridge in the test process — see helpers/terminal-backend.ts. The saved
 * windows are the mocked device store, shared between pages and browser
 * contexts the way the box's copy is shared between browsers.
 */

const SETUP_DONE = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

const VIEWPORT = { width: 1600, height: 1000 };

let backend: TerminalBackend;

test.beforeAll(async () => {
  backend = await startTerminalBackend();
});

test.afterAll(async () => {
  await backend?.stop();
});

interface Box { x: number; y: number; width: number; height: number }

/** One desktop page wired to the shared device store and the real terminal backend. */
async function openDesktop(page: Page, desktopState: DesktopStateMock): Promise<TerminalWire> {
  // xterm's DOM renderer, so the terminal's text can be read off the page:
  // with WebGL2 missing the terminal never loads its WebGL addon.
  await page.addInitScript(() => {
    Object.defineProperty(window, "WebGL2RenderingContext", { value: undefined, configurable: true });
  });
  await installClawboxMocks(page, { initialSetup: SETUP_DONE, desktopState });
  const wire = await routeTerminalToBackend(page, backend);
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  return wire;
}

const windowById = (page: Page, id: string) => page.locator(`[data-window-id="${id}"]`);

async function boxOf(win: Locator): Promise<Box> {
  const box = await win.boundingBox();
  if (!box) throw new Error("window has no box");
  return box;
}

/**
 * The window's box once it has stopped changing: a window that has just
 * opened (or come back) is still in its scale-in animation, and a grab aimed
 * at that box lands on whatever is under the real one.
 */
async function settledBox(win: Locator): Promise<Box> {
  let last = await boxOf(win);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 75));
    const next = await boxOf(win);
    if (next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height) return next;
    last = next;
  }
  return last;
}

/** Drag from a point by an offset, in steps, the way a hand does. */
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

/** Move a window by its title bar (left end, clear of every control) so its top-left lands on `to`. */
async function placeWindow(page: Page, win: Locator, to: { x: number; y: number }) {
  const box = await settledBox(win);
  await drag(page, { x: box.x + 60, y: box.y + 16 }, to.x - box.x, to.y - box.y);
}

/**
 * Resize a window by its bottom-right corner to `width` × `height` — grabbed
 * 6px in: the frame's 8px rounded corner clips hit-testing, and a point
 * closer to the corner than that falls through to the window underneath.
 */
async function sizeWindow(page: Page, win: Locator, width: number, height: number) {
  const box = await settledBox(win);
  await drag(page, { x: box.x + box.width - 6, y: box.y + box.height - 6 }, width - box.width, height - box.height);
}

/** The ticks the long-running command printed that are on the terminal's screen now. */
async function ticksOnScreen(win: Locator): Promise<number[]> {
  const text = await win.locator(".xterm-rows").innerText();
  return [...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]));
}

async function highestTick(win: Locator): Promise<number> {
  const ticks = await ticksOnScreen(win);
  return ticks.length ? Math.max(...ticks) : 0;
}

/** The windows in stacking order, bottom to top. */
async function stackingOrder(page: Page): Promise<string[]> {
  return page.locator("[data-window-id]").evaluateAll((els) =>
    els
      .map((el) => ({ id: el.getAttribute("data-window-id") ?? "", z: Number((el as HTMLElement).style.zIndex) }))
      .sort((a, b) => a.z - b.z)
      .map((w) => w.id));
}

function savedSession(desktopState: DesktopStateMock, windowId: string): string | undefined {
  const state = desktopState.state as { windows?: Array<{ id: string; terminal?: { tabs: Array<{ session?: string }> } }> } | null;
  return state?.windows?.find((w) => w.id === windowId)?.terminal?.tabs[0]?.session;
}

function expectSameBox(actual: Box, expected: Box, label: string) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key]), `${label} ${key}: ${actual[key]} vs ${expected[key]}`).toBeLessThanOrEqual(1);
  }
}

test("windows and running terminals come back where they were after a refresh", async ({ page, browser }) => {
  test.setTimeout(240_000);
  test.info().annotations.push({ type: "terminal-backend", description: backend.kind });
  await page.setViewportSize(VIEWPORT);
  const desktopState = createDesktopStateMock();
  const wire = await openDesktop(page, desktopState);

  // ── Two terminals and one other app ────────────────────────────────────
  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByTestId("chrome-window-terminal")).toHaveCount(1);
  await page.getByTestId("shelf-app-terminal").click({ button: "right" });
  await page.getByRole("button", { name: "New Window" }).click();
  await expect(page.getByTestId("chrome-window-terminal")).toHaveCount(2);
  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "Files" }).click();
  await expect(page.getByTestId("chrome-window-files")).toBeVisible();

  const [termAId, termBId] = await page.getByTestId("chrome-window-terminal").evaluateAll((els) => els.map((el) => el.getAttribute("data-window-id") ?? ""));
  const filesId = (await page.getByTestId("chrome-window-files").getAttribute("data-window-id"))!;
  const termA = windowById(page, termAId);
  const termB = windowById(page, termBId);
  const files = windowById(page, filesId);

  // Both shells are sessions on the box.
  await expect.poll(() => wire.frames.filter((f) => f.msg.type === "started" && typeof f.msg.session === "string").length).toBe(2);

  // ── Move and resize ────────────────────────────────────────────────────
  // All three opened centred on one another: laid out from the top down, so
  // every grab lands on the window that is meant.
  await sizeWindow(page, files, 500, 350);
  await placeWindow(page, files, { x: 560, y: 560 });
  await sizeWindow(page, termB, 700, 420);
  await placeWindow(page, termB, { x: 820, y: 40 });
  await sizeWindow(page, termA, 700, 420);
  await placeWindow(page, termA, { x: 40, y: 40 });

  // ── A long-running command in the first terminal ───────────────────────
  await termA.locator(".xterm").click();
  await page.keyboard.type("for i in $(seq 1 100000); do echo tick-$i; sleep 0.25; done");
  await page.keyboard.press("Enter");
  await expect.poll(() => highestTick(termA), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

  // Files takes the focus, on top of both terminals — once the click into the
  // terminal has raised it, so the two raises cannot land in one render.
  await expect(termA).toHaveAttribute("data-active", "true");
  await placeWindow(page, files, { x: 570, y: 570 });
  await expect(files).toHaveAttribute("data-active", "true");

  const before = {
    [termAId]: await settledBox(termA),
    [termBId]: await settledBox(termB),
    [filesId]: await settledBox(files),
  };
  const orderBefore = await stackingOrder(page);
  expect(orderBefore.at(-1)).toBe(filesId);
  // The device has the layout (positions are the windows' left/top).
  await expect.poll(() => {
    const saved = desktopState.state as { windows?: Array<{ id: string; x?: number; y?: number; width?: number }> } | null;
    return (saved?.windows ?? []).every((w) => Math.abs((w.x ?? -1) - before[w.id].x) <= 1 && Math.abs((w.y ?? -1) - before[w.id].y) <= 1 && Math.abs((w.width ?? -1) - before[w.id].width) <= 1)
      && saved?.windows?.length === 3;
  }).toBe(true);
  const sessionA = savedSession(desktopState, termAId)!;
  const sessionB = savedSession(desktopState, termBId)!;
  expect(sessionA).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(sessionB).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

  /**
   * Every window back where it was, in the same order, the same one focused,
   * each terminal reattached to its own session. `frames` is what the
   * backend has sent this page since it (re)loaded.
   */
  const expectRestored = async (p: Page, frames: () => TerminalWire["frames"], label: string) => {
    for (const id of [termAId, termBId, filesId]) await expect(windowById(p, id), `${label}: ${id}`).toBeVisible();
    for (const id of [termAId, termBId, filesId]) expectSameBox(await settledBox(windowById(p, id)), before[id], `${label}: ${id}`);
    expect(await stackingOrder(p)).toEqual(orderBefore);
    await expect(windowById(p, filesId)).toHaveAttribute("data-active", "true");
    // Reattached to the SAME sessions — nothing new was started.
    await expect.poll(() => frames().filter((f) => f.msg.type === "attached").map((f) => f.msg.session).sort()).toEqual([sessionA, sessionB].sort());
    expect(frames().filter((f) => f.msg.type === "started")).toEqual([]);
    const pTermA = windowById(p, termAId);
    // The status bar is gone once the terminal is attached.
    await expect(pTermA.getByText("Session no longer exists", { exact: true })).toHaveCount(0);
  };

  // ── F5 ─────────────────────────────────────────────────────────────────
  const tickBeforeReload = await highestTick(termA);
  const framesBefore = wire.frames.length;
  await page.reload();
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  // The bridge outlives the reload and keeps recording on the same wire.
  const sinceReload = () => wire.frames.slice(framesBefore);
  await expectRestored(page, sinceReload, "after F5");
  // The replay carried what was printed before the refresh…
  const replay = sinceReload().find((f) => f.msg.replay === true && String(f.msg.data).includes(`tick-${tickBeforeReload}`));
  expect(replay, `the replay holds tick-${tickBeforeReload}`).toBeTruthy();
  // …and the command is still running: its output carries on past it.
  await expect.poll(() => highestTick(windowById(page, termAId)), { timeout: 20_000 }).toBeGreaterThan(tickBeforeReload + 2);

  // ── The tab closed and opened again ────────────────────────────────────
  const context = page.context();
  const tickBeforeClose = await highestTick(windowById(page, termAId));
  await page.close();
  const reopened = await context.newPage();
  await reopened.setViewportSize(VIEWPORT);
  const reopenedWire = await openDesktop(reopened, desktopState);
  await expectRestored(reopened, () => reopenedWire.frames, "after reopening the tab");
  await expect.poll(() => highestTick(windowById(reopened, termAId)), { timeout: 20_000 }).toBeGreaterThan(tickBeforeClose + 2);

  // ── Another browser, on a smaller screen ───────────────────────────────
  // The windows follow the user (the device's copy — this browser has no
  // local one), and are kept inside a screen smaller than the one they were
  // saved on — without that visit rewriting the layout the device holds.
  const small = { width: 1000, height: 700 };
  const savesBeforeVisit = desktopState.saves.length;
  const other = await browser.newContext({ viewport: small, locale: "en-US" });
  try {
    const phonePage = await other.newPage();
    await openDesktop(phonePage, desktopState);
    for (const id of [termAId, termBId, filesId]) {
      const box = await settledBox(windowById(phonePage, id));
      expect(box.x, `${id} x`).toBeGreaterThanOrEqual(0);
      expect(box.y, `${id} y`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${id} right edge`).toBeLessThanOrEqual(small.width + 1);
      expect(box.y + 36, `${id} title bar`).toBeLessThanOrEqual(small.height - 56 + 1);
    }
    await expect.poll(() => highestTick(windowById(phonePage, termAId)), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(desktopState.saves.length).toBe(savesBeforeVisit);
    await phonePage.close();
  } finally {
    await other.close();
  }

  // ── Closing a terminal window by hand ends its session ─────────────────
  await expect(windowById(reopened, termBId)).toBeVisible();
  await windowById(reopened, termBId).getByRole("button", { name: "Close", exact: true }).click();
  await expect(windowById(reopened, termBId)).toHaveCount(0);
  await expect.poll(() => backend.probe(sessionB)).toBe("gone");
  expect(await backend.probe(sessionA)).toBe("attached");
  await expect.poll(() => {
    const saved = desktopState.state as { windows?: Array<{ id: string }> } | null;
    return saved?.windows?.map((w) => w.id).includes(termBId);
  }).toBe(false);

  // ── A reboot ends the sessions but keeps the layout ────────────────────
  const layoutBeforeReboot = { [termAId]: await settledBox(windowById(reopened, termAId)), [filesId]: await settledBox(windowById(reopened, filesId)) };
  await backend.restart();
  await reopened.reload();
  await expect(reopened.getByTestId("desktop-root")).toBeVisible();
  for (const id of [termAId, filesId]) expectSameBox(await settledBox(windowById(reopened, id)), layoutBeforeReboot[id], `after the reboot: ${id}`);
  // The window says its session is gone rather than opening a fresh shell.
  await expect(windowById(reopened, termAId).getByText("Session no longer exists", { exact: true })).toBeVisible();
  await expect(windowById(reopened, termAId).locator(".xterm-rows")).toContainText("no longer exists");
});
