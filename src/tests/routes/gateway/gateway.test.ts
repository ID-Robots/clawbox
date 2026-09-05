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

// The real edition reader, driven the way a device drives it: no
// /etc/clawbox/edition.env in CI, so the env fallback answers.
const NO_EDITION_FILE = "/nonexistent/clawbox/edition.env";

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

  beforeEach(async () => {
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
      process.env.CLAWBOX_EDITION_FILE = NO_EDITION_FILE;
      mockFetch.mockRejectedValue(new Error("Connection refused"));
      vi.mocked(getGatewayServiceHealth).mockResolvedValue(maskedUnit);
    });

    afterEach(() => {
      delete process.env.CLAWBOX_EDITION_FILE;
      delete process.env.CLAWBOX_EDITION;
    });

    it("does not report an OpenClaw gateway on a Hermes device", async () => {
      // install.sh step_edition_gateway_state removes the unit file and masks
      // the name to /dev/null on this SKU, so port 18789 will never open and
      // `systemctl restart clawbox-gateway` is refused outright. The page used
      // to say "OpenClaw Gateway Offline … not running on port 18789" with a
      // Retry that can only repaint itself.
      process.env.CLAWBOX_EDITION = "hermes";

      const res = await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway")));
      const html = await res.text();

      expect(res.status).toBe(503);
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
      process.env.CLAWBOX_EDITION = "openclaw";

      const res = await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway")));
      const html = await res.text();

      expect(html).not.toContain("Gateway Offline");
      expect(html).not.toContain("not running on port");
      expect(html).toContain("Gateway Unavailable");
      expect(html).toContain("masked");
      expect(html).toContain("Retry");
    });

    it("does not print restart advice systemd would refuse", async () => {
      // Belt and braces: a masked unit cannot reach start-limit-hit, but the
      // breaker paragraph is the one place that names the two commands, so it
      // is pinned off rather than left to that argument.
      process.env.CLAWBOX_EDITION = "hermes";
      vi.mocked(getGatewayServiceHealth).mockResolvedValue({ ...maskedUnit, breakerActive: true });

      const html = await (await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway")))).text();

      expect(html).not.toContain("systemctl reset-failed clawbox-gateway");
      expect(html).not.toContain("Automatic restart breaker activated");
    });

    it("keeps the ordinary offline page when systemctl did not answer", async () => {
      // `unitLoaded: null` is "the question could not be asked", which is not
      // evidence that the gateway is missing.
      process.env.CLAWBOX_EDITION = "openclaw";
      vi.mocked(getGatewayServiceHealth).mockResolvedValue({
        ...maskedUnit,
        loadState: null,
        unitLoaded: null,
      });

      const html = await (await GET(new NextRequest(new URL("http://clawbox.local/setup-api/gateway")))).text();

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
