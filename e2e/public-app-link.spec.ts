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
  // With or without a password is the owner's choice: nothing is preselected.
  await expect(dialog.getByTestId("public-link-submit")).toBeDisabled();
  await expect(dialog.getByTestId("public-link-protection-password")).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByTestId("public-link-protection-none")).toHaveAttribute("aria-checked", "false");
  await dialog.getByTestId("public-link-protection-none").click();
  await expect(dialog.getByTestId("public-link-password-input")).toHaveCount(0);
  await dialog.getByTestId("public-link-submit").click();

  await expect.poll(() => posted).toEqual([{ appId: "notes", mode: "temporary", ttlMinutes: 60 }]);
  await expect(dialog.getByTestId("public-link-url")).toHaveValue(URL, { timeout: 15_000 });
  await dialog.getByTestId("public-link-close").click();
  await expect(page.getByTestId("public-link-badge-notes")).toBeVisible();

  await icon.click({ button: "right" });
  const menu = page.getByTestId("desktop-context-menu");
  await expect(menu.getByTestId("ctx-public-link-status")).toContainText("Public · until");
  await expect(menu.getByTestId("ctx-public-link-password-status")).toHaveText(/No password/);
  await expect(menu.getByTestId("ctx-public-link-copy")).toBeVisible();
  await expect(menu.getByTestId("ctx-public-link-open")).toBeVisible();
  await menu.getByTestId("ctx-public-link-disable").click();

  await expect(page.getByTestId("public-link-badge-notes")).toHaveCount(0);
  await icon.click({ button: "right" });
  await expect(page.getByTestId("ctx-public-link-create")).toBeVisible();
});

/**
 * TASK-1515: the owner decides, while creating the link, whether it needs a
 * password, and sets a NEW one right there. Later the same dialog changes or
 * removes it, and the link itself stays what it was.
 */
test("a link is created with a password of its own, which is then changed and removed", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: COMPLETE_SETUP,
    preferences: {
      installed_apps: ["notes"],
      installed_meta: { notes: { name: "Notes", color: "#f97316", iconUrl: "", webappUrl: "/setup-api/webapps?app=notes" } },
    },
  });

  let link: Record<string, unknown> | null = null;
  const posted: Record<string, unknown>[] = [];
  const patched: Record<string, unknown>[] = [];
  await page.route("**/setup-api/apps/public-link", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      posted.push(body);
      if (body.password === "the-box-password") {
        await route.fulfill({ status: 400, json: { error: "That is your ClawBox password.", code: "password_is_system" } });
        return;
      }
      link = { appId: "notes", mode: body.mode, createdAt: Date.now(), expiresAt: null, apiAllow: [], passwordProtected: typeof body.password === "string", state: "live", url: URL };
      await route.fulfill({ status: 201, json: { link } });
      return;
    }
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      patched.push(body);
      link = { ...link, passwordProtected: body.password !== null };
      await route.fulfill({ json: { ok: true, passwordProtected: body.password !== null } });
      return;
    }
    await route.fulfill({ json: { links: link ? [link] : [] } });
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  const icon = page.locator('[data-desktop-icon-id="notes"] button');
  await icon.click({ button: "right" });
  await page.getByTestId("ctx-public-link-create").click();
  const dialog = page.getByTestId("public-link-dialog");
  await dialog.getByTestId("public-link-mode-permanent").click();

  // Requiring a password asks for a new one — and says it must not be the ClawBox one.
  await dialog.getByTestId("public-link-protection-password").click();
  const input = dialog.getByTestId("public-link-password-input");
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toHaveAttribute("autocomplete", "new-password");
  await expect(input).toHaveValue("");
  await expect(dialog.getByTestId("public-link-password-rule")).toContainText("different from your ClawBox password");
  await expect(dialog.getByTestId("public-link-submit")).toBeDisabled();
  await input.fill("short");
  await expect(dialog.getByTestId("public-link-submit")).toBeDisabled();

  // The server's refusal of the box password is shown in the owner's language.
  await input.fill("the-box-password");
  await dialog.getByTestId("public-link-submit").click();
  await expect(dialog.getByTestId("public-link-error")).toHaveText("That is your ClawBox password. Choose a different one for this link.");

  // A generated password is shown so it can be copied.
  await dialog.getByTestId("public-link-password-generate").click();
  await expect(input).toHaveAttribute("type", "text");
  const generated = await input.inputValue();
  // The refusal was about the password that is no longer in the field.
  await expect(dialog.getByTestId("public-link-error")).toHaveCount(0);
  expect(generated).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
  await dialog.getByTestId("public-link-submit").click();

  await expect.poll(() => posted.at(-1)).toEqual({ appId: "notes", mode: "permanent", password: generated });
  await expect(dialog.getByTestId("public-link-url")).toHaveValue(URL);
  await expect(dialog.getByTestId("public-link-password-status")).toHaveText(/Password protected/);
  // The one moment the password can still be copied.
  await expect(dialog.getByTestId("public-link-password-value")).toHaveValue(generated);
  await expect(dialog.getByTestId("public-link-password-value")).toHaveAccessibleName("Password");
  await expect(dialog.getByTestId("public-link-password-save-now")).toBeVisible();
  await dialog.getByTestId("public-link-close").click();

  // The menu shows the protection and leads back to the dialog; the password is not shown again.
  await icon.click({ button: "right" });
  const menu = page.getByTestId("desktop-context-menu");
  await expect(menu.getByTestId("ctx-public-link-password-status")).toHaveText(/Password protected/);
  await menu.getByTestId("ctx-public-link-password").click();
  await expect(dialog.getByTestId("public-link-password-status")).toHaveText(/Password protected/);
  await expect(dialog.getByTestId("public-link-password-value")).toHaveCount(0);
  await expect(dialog.getByTestId("public-link-url")).toHaveValue(URL);

  // Change it: the link does not change.
  await dialog.getByTestId("public-link-password-edit").click();
  await expect(dialog.getByTestId("public-link-password-save")).toBeDisabled();
  await dialog.getByTestId("public-link-password-input").fill("a-new-link-password");
  await dialog.getByTestId("public-link-password-save").click();
  await expect.poll(() => patched.at(-1)).toEqual({ appId: "notes", password: "a-new-link-password" });
  await expect(dialog.getByTestId("public-link-password-changed")).toBeVisible();
  await expect(dialog.getByTestId("public-link-password-value")).toHaveValue("a-new-link-password");
  await expect(dialog.getByTestId("public-link-url")).toHaveValue(URL);

  // Remove it.
  await dialog.getByTestId("public-link-password-remove").click();
  await expect.poll(() => patched.at(-1)).toEqual({ appId: "notes", password: null });
  await expect(dialog.getByTestId("public-link-password-status")).toHaveText(/No password/);
  await expect(dialog.getByTestId("public-link-password-remove")).toHaveCount(0);
  await expect(dialog.getByTestId("public-link-url")).toHaveValue(URL);

  // And add one again to a link that has none.
  await dialog.getByTestId("public-link-password-edit").click();
  await dialog.getByTestId("public-link-password-input").fill("added-afterwards");
  await dialog.getByTestId("public-link-password-save").click();
  await expect.poll(() => patched.at(-1)).toEqual({ appId: "notes", password: "added-afterwards" });
  await expect(dialog.getByTestId("public-link-password-status")).toHaveText(/Password protected/);
  await expect(dialog.getByTestId("public-link-password-changed")).toHaveCount(0);
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
