import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * TASK-1478: right-click a desktop app → "Create public link" → the link, its
 * expiry and its off switch in the same menu, and a globe on the icon while
 * it is public. The serving side is covered against real sockets in
 * src/tests/unit/public-app-links-server.test.ts; here the route is mocked
 * with the shape src/app/setup-api/apps/public-link answers.
 */

const COMPLETE_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

const URL = "https://calm-river-test.trycloudflare.com/?k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("an app is published from its icon's menu, shown as public, and disabled from the same menu", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: COMPLETE_SETUP,
    preferences: {
      installed_apps: ["notes"],
      installed_meta: { notes: { name: "Notes", color: "#f97316", iconUrl: "", webappUrl: "/setup-api/webapps?app=notes" } },
    },
  });

  let link: Record<string, unknown> | null = null;
  const posted: unknown[] = [];
  let polls = 0;
  await page.route("**/setup-api/apps/public-link", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      posted.push(request.postDataJSON());
      const body = request.postDataJSON() as { mode: string; ttlMinutes?: number };
      link = { appId: "notes", mode: body.mode, createdAt: Date.now(), expiresAt: body.mode === "temporary" ? Date.now() + (body.ttlMinutes ?? 0) * 60_000 : null, apiAllow: [], state: "starting", url: null };
      await route.fulfill({ status: 201, json: { link } });
      return;
    }
    if (request.method() === "DELETE") {
      link = null;
      await route.fulfill({ json: { ok: true, removed: true } });
      return;
    }
    // The tunnel comes up after a poll or two.
    if (link && link.state === "starting" && ++polls >= 2) link = { ...link, state: "live", url: URL };
    await route.fulfill({ json: { links: link ? [link] : [] } });
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  const icon = page.locator('[data-desktop-icon-id="notes"] button');
  await expect(icon).toBeVisible();
  await expect(page.getByTestId("public-link-badge-notes")).toHaveCount(0);

  await icon.click({ button: "right" });
  await page.getByTestId("ctx-public-link-create").click();
  const dialog = page.getByTestId("public-link-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("public-link-mode-temporary")).toHaveAttribute("aria-checked", "true");
  await dialog.getByTestId("public-link-duration").selectOption(String(60));
  await dialog.getByTestId("public-link-submit").click();

  await expect.poll(() => posted).toEqual([{ appId: "notes", mode: "temporary", ttlMinutes: 60 }]);
  await expect(dialog.getByTestId("public-link-url")).toHaveValue(URL, { timeout: 15_000 });
  await dialog.getByTestId("public-link-close").click();
  await expect(page.getByTestId("public-link-badge-notes")).toBeVisible();

  await icon.click({ button: "right" });
  const menu = page.getByTestId("desktop-context-menu");
  await expect(menu.getByTestId("ctx-public-link-status")).toContainText("Public · until");
  await expect(menu.getByTestId("ctx-public-link-copy")).toBeVisible();
  await expect(menu.getByTestId("ctx-public-link-open")).toBeVisible();
  await menu.getByTestId("ctx-public-link-disable").click();

  await expect(page.getByTestId("public-link-badge-notes")).toHaveCount(0);
  await icon.click({ button: "right" });
  await expect(page.getByTestId("ctx-public-link-create")).toBeVisible();
});

test("built-in apps offer no public link", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: COMPLETE_SETUP });
  await page.route("**/setup-api/apps/public-link", (route) => route.fulfill({ json: { links: [] } }));
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  const builtin = page.locator('[data-desktop-icon-id^="desktop-"] button').first();
  await expect(builtin).toBeVisible();
  await builtin.click({ button: "right" });
  await expect(page.getByTestId("desktop-context-menu")).toBeVisible();
  await expect(page.getByTestId("ctx-public-link-create")).toHaveCount(0);
});
