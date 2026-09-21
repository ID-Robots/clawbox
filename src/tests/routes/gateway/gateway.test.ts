import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/lib/gateway-proxy", () => ({
  getGatewayToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("@/lib/gateway-health", () => ({
  getGatewayServiceHealth: vi.fn().mockResolvedValue({
    active: false,
    breakerActive: false,
    activeState: "failed",
    subState: "failed",
    result: "exit-code",
    restartCount: 2,
    finalStartupError: "Config validation failed",
    loadState: "loaded",
    unitLoaded: true,
  }),
}));

import { getGatewayToken } from "@/lib/gateway-proxy";
import { getGatewayServiceHealth } from "@/lib/gateway-health";

// The hermetic floor vitest.config.ts installs, captured so `afterEach` can put
// it BACK. Deleting it instead leaves the next `vi.resetModules()` re-import
// reading the real /etc/clawbox/edition.env — invisible in CI, and red on the
// Hermes box this fix was validated on, which is where the repo says to run.
const CONFIG_EDITION_FILE = process.env.CLAWBOX_EDITION_FILE;
const CONFIG_EDITION = process.env.CLAWBOX_EDITION;

/** `process.env.X = undefined` stores the STRING "undefined"; absence is a delete. */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** systemd's answer for a unit masked to /dev/null. */
const maskedUnit = {
  active: false,
  breakerActive: false,
  activeState: "inactive",
  subState: "dead",
  result: "success",
  restartCount: 0,
  finalStartupError: null,
  loadState: "masked",
  unitLoaded: false,
};

describe("/setup-api/gateway", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  let editionDir: string;
  let editionLock: string;

  /** Bake the root-owned lock, the authority the route actually reads. */
  const lockEdition = (value: string) =>
    fs.writeFileSync(editionLock, `CLAWBOX_EDITION=${value}\n`);

  beforeEach(async () => {
    // `edition-source` binds the lock PATH at module scope, so it has to be set
    // before the route below is imported; the CONTENT is read per call, so each
    // test bakes the SKU it means. Driving the file rather than the env
    // fallback is the point — the file is what a device has.
    editionDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gateway-edition-"));
    editionLock = path.join(editionDir, "edition.env");
    process.env.CLAWBOX_EDITION_FILE = editionLock;
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(getGatewayToken).mockResolvedValue("test-token");
    vi.mocked(getGatewayServiceHealth).mockResolvedValue({
      active: false,
      breakerActive: false,
      activeState: "failed",
      subState: "failed",
      result: "exit-code",
      restartCount: 2,
      finalStartupError: "Config validation failed",
      loadState: "loaded",
      unitLoaded: true,
    });
    const mod = await import("@/app/setup-api/gateway/route");
    GET = mod.GET;
  });

  afterEach(() => {
    fs.rmSync(editionDir, { recursive: true, force: true });
    restoreEnv("CLAWBOX_EDITION_FILE", CONFIG_EDITION_FILE);
    restoreEnv("CLAWBOX_EDITION", CONFIG_EDITION);
  });

  it("proxies gateway HTML with injected script", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("<html><head></head><body>Gateway</body></html>"),
    });
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("__OPENCLAW_WS_URL__");
    expect(html).toContain("clawbox.local");
  });

  it("carries the EMAIL: directive handling the other door already has", async () => {
    // The sibling call site of TASK-700. `serveGatewayHTML` is not the only
    // route that hands this page to a browser, and a bare `EMAIL:<uid>` here
    // would be the same defect one door along.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("<html><head></head><body>Gateway</body></html>"),
    });
    const res = await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway")));
    const html = await res.text();
    expect(html).toContain("clawbox-email-card");
    expect(html).toContain("/app/clawbox?email=");
  });

  it("returns offline HTML when gateway is down", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("Gateway Offline");
    expect(html).toContain("Config validation failed");
  });

  it("returns offline HTML when gateway responds with error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    const html = await res.text();
    expect(html).toContain("Gateway Offline");
  });

  describe("a unit systemd cannot load", () => {
    beforeEach(() => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));
      vi.mocked(getGatewayServiceHealth).mockResolvedValue(maskedUnit);
    });

    const render = async () => {
      const res = await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway")));
      return { status: res.status, html: await res.text() };
    };

    it("does not report an OpenClaw gateway on a Hermes device", async () => {
      // install.sh step_edition_gateway_state removes the unit file and masks
      // the name to /dev/null on this SKU, so port 18789 will never open and
      // `systemctl restart clawbox-gateway` is refused outright. The page used
      // to say "OpenClaw Gateway Offline … not running on port 18789" with a
      // Retry that can only repaint itself.
      lockEdition("hermes");

      const { status, html } = await render();

      // 404, like every other OpenClaw-only path on this SKU — a 503 invites a
      // monitor to re-poll a condition that cannot change.
      expect(status).toBe(404);
      expect(html).not.toContain("Gateway Offline");
      expect(html).not.toContain("not running on port");
      expect(html).not.toContain("systemctl restart clawbox-gateway");
      expect(html).not.toContain("Retry");
      expect(html).toContain("OpenClaw Is Not Installed");
      expect(html).toContain("Hermes");
    });

    it("calls a masked unit on an OpenClaw device what it is, and keeps Retry", async () => {
      // The same mask is temporary here: an update or factory reset holds it.
      // The owner still must not be told to restart a unit systemd refuses.
      lockEdition("openclaw");

      const { status, html } = await render();

      expect(status).toBe(503);
      expect(html).not.toContain("Gateway Offline");
      expect(html).not.toContain("not running on port");
      expect(html).toContain("Gateway Unavailable");
      expect(html).toContain("masked");
      expect(html).toContain("update or factory reset");
      expect(html).toContain("Retry");
    });

    it("gives a dual box the OpenClaw wording, not the Hermes one", async () => {
      // `dual` has BOTH harnesses, so the OpenClaw gateway does exist there and
      // a mask on it is the temporary kind.
      lockEdition("dual");

      const { status, html } = await render();

      expect(status).toBe(503);
      expect(html).toContain("Gateway Unavailable");
      expect(html).not.toContain("OpenClaw Is Not Installed");
    });

    it("names a missing unit file without inventing a cause for it", async () => {
      // An install run that unmasks but dies before step_systemd_services
      // re-copies the unit leaves LoadState=not-found. Telling that owner an
      // update is in progress sends them to wait for something that is not
      // running.
      lockEdition("openclaw");
      vi.mocked(getGatewayServiceHealth).mockResolvedValue({
        ...maskedUnit,
        loadState: "not-found",
      });

      const { html } = await render();

      expect(html).toContain("not-found");
      expect(html).not.toContain("update or factory reset");
      expect(html).not.toContain("not running on port");
    });

    it("attributes no cause when nothing on the device named an edition", async () => {
      // No lock file and no CLAWBOX_EDITION: `readEditionSource` answers
      // "openclaw, defaulted". A Hermes box in that state (a pre-3.x install, a
      // partial image) must not be handed the OpenClaw sentence — the branch is
      // device-derived, so the page still refuses the restart advice, and the
      // wording simply names the state.
      delete process.env.CLAWBOX_EDITION;

      const { status, html } = await render();

      expect(status).toBe(503);
      expect(html).toContain("masked");
      expect(html).not.toContain("update or factory reset");
      expect(html).not.toContain("OpenClaw Is Not Installed");
      expect(html).not.toContain("not running on port");
    });

    it("does not print restart advice systemd would refuse", async () => {
      // Belt and braces: a masked unit cannot reach start-limit-hit, but the
      // breaker paragraph is the one place that names the two commands, so it
      // is pinned off rather than left to that argument.
      lockEdition("hermes");
      vi.mocked(getGatewayServiceHealth).mockResolvedValue({ ...maskedUnit, breakerActive: true });

      const { html } = await render();

      expect(html).not.toContain("systemctl reset-failed clawbox-gateway");
      expect(html).not.toContain("Automatic restart breaker activated");
    });

    it("keeps the ordinary offline page when systemctl did not answer", async () => {
      // `unitLoaded: null` is "the question could not be asked", which is not
      // evidence that the gateway is missing.
      lockEdition("openclaw");
      vi.mocked(getGatewayServiceHealth).mockResolvedValue({
        ...maskedUnit,
        loadState: null,
        unitLoaded: null,
      });

      const { status, html } = await render();

      expect(status).toBe(503);
      expect(html).toContain("OpenClaw Gateway Offline");
      expect(html).toContain("not running on port 18789");
    });
  });

  it("reports an activated breaker with safe actionable recovery", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));
    vi.mocked(getGatewayServiceHealth).mockResolvedValue({
      active: false,
      breakerActive: true,
      activeState: "failed",
      subState: "failed",
      result: "start-limit-hit",
      restartCount: 3,
      finalStartupError: "bad config <script>alert(1)</script>",
      loadState: "loaded",
      unitLoaded: true,
    });

    const req = new NextRequest(new URL("http://clawbox.local/setup-api/gateway"));
    const res = await GET(req);
    const html = await res.text();

    expect(html).toContain("Automatic restart breaker activated");
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("systemctl reset-failed clawbox-gateway");
    expect(html).toContain("bad config &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
