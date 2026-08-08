import { chromium, type FullConfig } from "@playwright/test";

/**
 * Warm the Turbopack dev server before the timed suite runs.
 *
 * CI serves e2e through `bun run dev` with `workers: 1`, so the FIRST request to
 * a route pays its full on-demand Turbopack compile (route RSC + client bundle).
 * Under GitHub Actions load the initial compile of `/` — the desktop shell, the
 * single heaviest route — can exceed the 15s expect timeout, so whichever spec
 * hits `/` first flakes on `getByTestId('desktop-root')` even though the app is
 * fine (it passes on the Jetson and on every later spec once `/` is compiled).
 * The same cold-compile cost also shows up as slow first interactions in the
 * heavier specs. See #114.
 *
 * Loading the heavy routes once here, before any test starts its clock, moves
 * that one-time compile out of the timed path. The dev server serves e2e with
 * SESSION_SECRET unset, so middleware lets `/` through and the desktop renders
 * without auth — no mocks needed just to trigger the compile.
 */
async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    // Generous budget: this call IS the cold compile we are paying up front.
    await page.goto("/", { waitUntil: "networkidle", timeout: 120_000 }).catch(() => {});
    // Best-effort — the compile has happened regardless of what finally renders.
    await page
      .getByTestId("desktop-root")
      .waitFor({ state: "visible", timeout: 120_000 })
      .catch(() => {});
    // The setup wizard is the other heavy route tree the suite hammers.
    await page.goto("/setup", { waitUntil: "networkidle", timeout: 120_000 }).catch(() => {});
  } finally {
    await browser.close();
  }
}

export default globalSetup;
