import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

/**
 * Covers the WiFi-handoff path (#167): joining a home network on the
 * single-radio box tears down the setup hotspot, so WifiStep raises the
 * full-screen WifiHandoffOverlay, which probes the box's home-network address
 * (an <img> load — fetch is CORS-blocked cross-origin) and redirects there
 * once the box answers.
 *
 * There's no second box in e2e, so the home-network origin
 * (http://clawbox.local — useDeviceAddress's fallback, since the mocks answer
 * /setup-api/system/hostname with `{}`) is mocked at the network layer:
 * the icon probe is fulfilled with a PNG so the overlay "finds" the box, and
 * the cross-origin /setup navigation is bounced straight back to the test
 * origin. That exercises the overlay's real probe/redirect logic end to end —
 * no test-only hooks in the components.
 */

// 1x1 transparent PNG — all the <img> probe needs for onload to fire.
const PROBE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("wifi connect hands off through the overlay and resumes the wizard", async ({ page }, testInfo) => {
  await installClawboxMocks(page);

  // No ethernet: routes are checked newest-first, so this overrides the
  // helper's cable-connected default and drives the WiFi-first path.
  await page.route("**/setup-api/wifi/ethernet", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: false, cable: false }),
    }),
  );

  // The box's "new address" on the home network.
  const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
  await page.route("http://clawbox.local/clawbox-icon.png*", (route) =>
    route.fulfill({ contentType: "image/png", body: PROBE_PNG }),
  );
  await page.route("http://clawbox.local/setup", (route) =>
    route.fulfill({ status: 302, headers: { location: `${baseURL}/setup` } }),
  );

  await page.goto("/setup");
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();

  // Pick a network and connect.
  await page.getByRole("button", { name: "Use Wi-Fi instead" }).click();
  await page.getByRole("button", { name: "Clawbox Lab" }).click();
  await page.locator("#wifi-password").fill("wifi-pass-123");
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // The handoff overlay comes up. Timers are capped by installClawboxMocks,
  // so it may already be past "joining" and into the back-online phase —
  // accept either to avoid racing the capped grace/probe loop.
  const joining = page.getByText("Joining your WiFi");
  const backOnline = page.getByText("Device is back online");
  await expect(joining.or(backOnline).first()).toBeVisible({ timeout: 10_000 });

  // Probe answers → overlay redirects to the box's new address → bounced back
  // to the test origin → the wizard reloads and resumes PAST the WiFi step
  // (the connect mock set wifi_configured). Update may auto-advance to
  // credentials, so accept either resume target.
  const updateStep = page.getByTestId("setup-step-update");
  const credentialsStep = page.getByTestId("setup-step-credentials");
  await expect(updateStep.or(credentialsStep).first()).toBeVisible({ timeout: 15_000 });
});
