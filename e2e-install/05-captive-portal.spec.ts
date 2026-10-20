/**
 * Captive-portal detection — when a phone/laptop joins the ClawBox-Setup
 * AP, the OS issues a probe request to a vendor-specific URL. ClawBox's
 * middleware (src/middleware.ts) intercepts those probes: Android, Windows
 * and Firefox get a 302 to the portal, Apple gets a 200 page that is NOT
 * "Success" and refreshes to the setup wizard, so the iOS captive sheet opens
 * on the wizard. During first setup start-ap.sh resolves only the probe hosts
 * to the AP (scripts/start-ap.sh, captive-probes.conf).
 *
 * Runs at NN=05 so it executes before the real wizard mutates state.
 */
import { test, expect } from "@playwright/test";
import { BASE_URL } from "./helpers/container";

const PROBES = [
  // Android — looks for HTTP 204 with a 0-byte body. Anything else == captive.
  { ua: "Dalvik/2.1.0 (Linux; U; Android 14)", path: "/generate_204" },
  { ua: "Dalvik/2.1.0 (Linux; U; Android 14)", path: "/gen_204" },
  // Apple — expects "Success". Anything else == captive; ours opens the wizard.
  { ua: "CaptiveNetworkSupport-410.0.1 wispr", path: "/hotspot-detect.html" },
  { ua: "CaptiveNetworkSupport-410.0.1 wispr", path: "/library/test/success.html" },
  // Windows — expects "Microsoft NCSI" body.
  { ua: "Microsoft NCSI", path: "/connecttest.txt" },
  { ua: "Microsoft NCSI", path: "/ncsi.txt" },
  // Firefox / generic captive detect.
  { ua: "Mozilla/5.0 captiveportal", path: "/canonical.html" },
];

test.describe("captive portal middleware", () => {
  for (const probe of PROBES) {
    test(`responds to ${probe.path}`, async ({ request }) => {
      // We don't strictly assert the body contents — that varies by probe —
      // but every probe must return ≤ 4xx and either redirect us or hand
      // back content so the captive-portal banner pops.
      const res = await request.get(`${BASE_URL}${probe.path}`, {
        headers: { "user-agent": probe.ua },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      // 200 / 204 / 30x are all acceptable: each tells the OS something
      // sensible. 5xx = our middleware crashed and needs fixing.
      expect(res.status(), `${probe.path} returned 5xx`).toBeLessThan(500);
      if (probe.ua.startsWith("CaptiveNetworkSupport")) {
        // Before the wizard runs the Apple probe must open the wizard, never
        // claim the network is open.
        expect(res.status()).toBe(200);
        const body = await res.text();
        expect(body).not.toMatch(/<BODY>Success<\/BODY>/);
        expect(body).toMatch(/http-equiv="refresh" content="0;url=[^"]*\/setup"/);
      } else {
        expect(res.status()).toBe(302);
      }
    });
  }

  test("redirects unauthenticated traffic from / to /setup or /login", async ({
    request,
  }) => {
    const res = await request.get(BASE_URL, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    // Right after install (before the wizard runs), middleware sends us
    // either to /setup (incomplete) or /login (complete but no session).
    // Either is a valid happy-path destination at this point.
    if (res.status() >= 300 && res.status() < 400) {
      const location = res.headers()["location"] ?? "";
      expect(location).toMatch(/\/setup|\/login/);
    } else {
      // If it returns 200, the desktop is already shown — that means a
      // prior spec finished setup. Still a healthy state.
      expect(res.status()).toBe(200);
    }
  });
});
