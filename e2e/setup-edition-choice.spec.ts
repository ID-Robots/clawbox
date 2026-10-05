import type { Page, Route } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, wizardStepAfterWifi } from "./helpers/clawbox";

/**
 * "Choose your assistant" on a unified-image box (TASK-1149), against the
 * real wizard with the device mocked: the step appears after WiFi only when
 * the box has no agent chosen, sends the choice, and — once the box reports
 * the choice made from a restarted server — reloads into the Update step.
 * A box with a fixed edition never sees it.
 */

interface EditionDevice {
  needed: boolean;
  hint: "openclaw" | "hermes" | null;
  serverStartedAt: number;
  posted: unknown[];
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Layered over installClawboxMocks: Playwright runs the LAST matching route
 * first, so these two paths answer here and everything else falls through to
 * the shared mock device.
 */
async function installEditionDevice(page: Page, hint: EditionDevice["hint"] = null): Promise<EditionDevice> {
  const device: EditionDevice = { needed: true, hint, serverStartedAt: 1_000, posted: [] };
  await installClawboxMocks(page, { initialSetup: { wifi_configured: true } });

  await page.route("**/setup-api/setup/status", async (route) => {
    await fulfillJson(route, {
      setup_complete: false,
      password_configured: false,
      update_completed: false,
      wifi_configured: true,
      setup_progress_step: 2,
      edition_choice_needed: device.needed,
    });
  });

  await page.route("**/setup-api/setup/edition", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      device.posted.push(JSON.parse(request.postData() ?? "{}"));
      // The root step locks the box and restarts the web server.
      device.needed = false;
      device.serverStartedAt += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: [
          { phase: "request" },
          { phase: "check" },
          { phase: "lock" },
          { phase: "provision" },
          { phase: "cleanup" },
          { phase: "done" },
          { success: true, edition: "hermes", restarting: true },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n",
      });
      return;
    }
    await fulfillJson(route, {
      needed: device.needed,
      unselected: device.needed,
      pending: null,
      edition: device.needed ? null : "hermes",
      hint: device.needed ? device.hint : null,
      inProgress: false,
      inProgressTarget: null,
      serverStartedAt: device.serverStartedAt,
    });
  });
  return device;
}

test("an undecided box asks for its assistant after WiFi, then continues to Update", async ({ page }) => {
  const device = await installEditionDevice(page);
  await page.goto("/setup");

  const step = page.getByTestId("setup-step-edition");
  await expect(step).toBeVisible();
  await expect(step.getByRole("heading", { name: "Choose your assistant" })).toBeVisible();
  await expect(page.getByTestId("edition-card-openclaw")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("edition-card-openclaw")).toContainText("Recommended");
  await expect(step).toContainText("Not sure? Choose OpenClaw.");
  await expect(page.getByTestId("setup-step-update")).toHaveCount(0);

  await page.getByTestId("edition-card-hermes").click();
  await expect(page.getByTestId("edition-continue")).toHaveText("Continue with Hermes");
  await page.getByTestId("edition-continue").click();

  await expect(wizardStepAfterWifi(page)).toBeVisible();
  await expect(page.getByTestId("setup-step-edition")).toHaveCount(0);
  expect(device.posted).toEqual([{ edition: "hermes" }]);
});

test("a box prepared for a Hermes order arrives with Hermes preselected", async ({ page }) => {
  await installEditionDevice(page, "hermes");
  await page.goto("/setup");

  await expect(page.getByTestId("edition-hint")).toContainText("Your order was for Hermes");
  await expect(page.getByTestId("edition-card-hermes")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("edition-continue")).toHaveText("Continue with Hermes");
});

test("a box with a fixed edition never sees the step", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: { wifi_configured: true } });
  await page.goto("/setup");

  await expect(wizardStepAfterWifi(page)).toBeVisible();
  await expect(page.getByTestId("setup-step-edition")).toHaveCount(0);
});

test("the choice fits a phone screen: cards stacked, one full-width button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installEditionDevice(page);
  await page.goto("/setup");

  const openclaw = await page.getByTestId("edition-card-openclaw").boundingBox();
  const hermes = await page.getByTestId("edition-card-hermes").boundingBox();
  const button = await page.getByTestId("edition-continue").boundingBox();
  expect(openclaw && hermes && button).toBeTruthy();
  // Stacked, not side by side.
  expect(hermes!.y).toBeGreaterThanOrEqual(openclaw!.y + openclaw!.height - 1);
  // Nothing wider than the screen, and the primary button spans the card.
  expect(openclaw!.x + openclaw!.width).toBeLessThanOrEqual(390);
  expect(button!.width).toBeGreaterThan(openclaw!.width - 2);
});
