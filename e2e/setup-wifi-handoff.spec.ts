import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, wizardStepAfterWifi } from "./helpers/clawbox";

/**
 * Covers the WiFi-handoff path (#167): joining a home network on the
 * single-radio box tears down the setup hotspot, so WifiStep raises the
 * full-screen WifiHandoffOverlay, which probes the box's home-network address
 * (an <img> load — fetch is CORS-blocked cross-origin) and redirects there
 * once the box answers. The wizard there shows the "Connected" dialog (TASK-2702).
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

test("wifi connect hands off through the overlay and resumes the wizard", async ({ page, baseURL }) => {
  // The default 50ms timer cap also crushes imgProbe's own 4s timeout — on
  // slow hardware the route-interception round trip doesn't fit in 50ms, so
  // every probe attempt "times out" and the overlay never finds the box.
  // 500ms keeps the grace/probe/redirect loop fast but gives the intercepted
  // probe response room to land.
  await installClawboxMocks(page, { timeoutCapMs: 500 });

  // No ethernet: routes are checked newest-first, so this overrides the
  // helper's cable-connected default and drives the WiFi-first path.
  await page.route("**/setup-api/wifi/ethernet", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connected: false, cable: false }),
    }),
  );

  // The switch takes the box out of this page's reach (the hotspot goes) until
  // the browser follows it to its new address; there it reports the join.
  let hotspotGone = false;
  let landed = false;
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/setup-api/wifi/connect") hotspotGone = true;
  });
  await page.route("**/setup-api/wifi/connect-status", (route) =>
    hotspotGone && !landed
      ? route.abort("internetdisconnected")
      : route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ phase: "connected", ssid: "Clawbox Lab", reason: null, message: "", ip: "192.0.2.23" }),
      }),
  );

  // The box's "new address" on the home network.
  await page.route("http://clawbox.local/clawbox-icon.png*", (route) =>
    route.fulfill({ contentType: "image/png", body: PROBE_PNG }),
  );
  await page.route("http://clawbox.local/setup*", (route) => {
    landed = true;
    return route.fulfill({ status: 302, headers: { location: `${baseURL}/setup?wifi=connected` } });
  });

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
  // (the connect mock set wifi_configured), and says where the box is now.
  await expect(wizardStepAfterWifi(page)).toBeVisible({ timeout: 15_000 });
  const connected = page.getByTestId("wifi-connected-dialog");
  await expect(connected).toBeVisible({ timeout: 10_000 });
  await expect(connected).toContainText("Clawbox Lab");
  await expect(connected).toContainText("192.0.2.23");
  await expect(connected).toContainText("clawbox.local");
  await connected.getByRole("button", { name: "OK" }).click();
  await expect(connected).toBeHidden();
  await expect(page).not.toHaveURL(/wifi=connected/);
});
