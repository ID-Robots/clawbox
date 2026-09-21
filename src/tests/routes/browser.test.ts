import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const execFileMock = vi.hoisted(() => vi.fn((file: string, args?: unknown, options?: unknown, callback?: unknown) => {
  const cb = [args, options, callback].find((value) => typeof value === "function") as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
  cb?.(null, "", "");
  return undefined;
}));

const mockPage = vi.hoisted(() => ({
  goto: vi.fn().mockResolvedValue(undefined),
  // Redirect/rebind SSRF guard installs a request interceptor via page.route.
  route: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue("https://www.google.com"),
  title: vi.fn().mockResolvedValue("Google"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG")),
  bringToFront: vi.fn().mockResolvedValue(undefined),
  mouse: {
    click: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
  },
  keyboard: {
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
  },
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(false),
  goBack: vi.fn().mockResolvedValue(undefined),
  goForward: vi.fn().mockResolvedValue(undefined),
  reload: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));

const mockContext = vi.hoisted(() => ({
  pages: vi.fn(() => [mockPage]),
  newPage: vi.fn().mockResolvedValue(mockPage),
}));

const mockBrowser = vi.hoisted(() => ({
  contexts: vi.fn(() => [mockContext]),
  close: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn(() => true),
  on: vi.fn(),
}));

const connectOverCDP = vi.hoisted(() => vi.fn().mockResolvedValue(mockBrowser));

// The Chromium the route launches for ITSELF when the desktop port is held
// by somebody else's browser. A separate handle from mockBrowser so the test
// can tell "closed ours" from "closed the desktop's".
const mockOwnedBrowser = vi.hoisted(() => ({
  contexts: vi.fn(() => [mockContext]),
  close: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn(() => true),
  on: vi.fn(),
}));
const launchChromium = vi.hoisted(() => vi.fn().mockResolvedValue(mockOwnedBrowser));
// Where Playwright's Chromium lives, or null for a box that never installed it.
const chromiumPath = vi.hoisted(() => ({ value: "/home/clawbox/.cache/ms-playwright/chromium/chrome" as string | null }));
// A probe verdict a test forces, ahead of what the fetch stub would imply.
const probeVerdict = vi.hoisted(() => ({ value: null as "ours" | "foreign" | "down" | null }));
// The owner's "verify on my screen" switch, as the route reads it per session.
const realBrowser = vi.hoisted(() => ({ value: true }));
const getRealBrowser = vi.hoisted(() => vi.fn(async () => realBrowser.value));
const writeBrowserLaunchEnv = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP,
    launch: launchChromium,
  },
}));

// The route's readiness probe (src/lib/cdp-probe.ts) is a real WebSocket
// upgrade against the address /json/version names, which the fetch stub
// below cannot answer. Reduce it to that fetch, so setDesktopBrowserReady
// keeps its "n failures, then ready" meaning; the probe itself is unit-tested
// against a fake Chromium in src/tests/unit/cdp-probe.test.ts.
vi.mock("@/lib/cdp-probe", () => ({
  probeCdp: async (endpoint: string) => {
    if (probeVerdict.value) return probeVerdict.value;
    try {
      const res = await fetch(`${endpoint}/json/version`);
      return res.ok ? "ours" : "down";
    } catch {
      return "down";
    }
  },
  describePortOwner: async () => "",
  // A path by default: the route now REFUSES to launch without one (there is
  // no Chromium to launch), and every headless case here is about a box that
  // has the runtime. The one case that is about a box without it sets this to
  // null itself.
  findPlaywrightChromium: () => chromiumPath.value,
}));

// The switch the route reads for every session. Mocked rather than written
// into a config store so a test can move it BETWEEN two launches, which is the
// property that matters: it is read per session, not once per process.
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  getRealBrowser,
}));

// The desktop launch writes the owner's start page where scripts/launch-browser.sh
// reads it — ~/.cache/clawbox/browser.env, which on this box is the REAL file the
// running Chromium was started from. Never from a test.
vi.mock("@/lib/browser-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/browser-setup")>()),
  writeBrowserLaunchEnv,
}));

function cdpVersionResponse() {
  return {
    ok: true,
    json: async () => ({ Browser: "Chromium 146" }),
  } as Response;
}

describe("/setup-api/browser", () => {
  let POST: (req: Request) => Promise<Response>;

  const setDesktopBrowserReady = (failuresBeforeReady = 0) => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/json/version")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      attempts += 1;
      if (attempts <= failuresBeforeReady) {
        throw new Error("CDP offline");
      }
      return cdpVersionResponse();
    }));
  };

  const importRoute = async () => {
    const mod = await import("@/app/setup-api/browser/route");
    POST = mod.POST;
  };

  const launchSession = async (extra: Record<string, unknown> = {}) => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "launch", ...extra }),
    });
    const res = await POST(req);
    return { res, body: await res.json() };
  };

  const sendAction = async (action: string, sessionId: string, extra: Record<string, unknown> = {}) => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action, sessionId, ...extra }),
    });
    const res = await POST(req);
    return { res, body: await res.json() };
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockPage.goto.mockResolvedValue(undefined);
    mockPage.url.mockReturnValue("https://www.google.com");
    mockPage.title.mockResolvedValue("Google");
    mockPage.screenshot.mockResolvedValue(Buffer.from("PNG"));
    mockPage.bringToFront.mockResolvedValue(undefined);
    mockPage.mouse.click.mockResolvedValue(undefined);
    mockPage.mouse.dblclick.mockResolvedValue(undefined);
    mockPage.mouse.move.mockResolvedValue(undefined);
    mockPage.mouse.wheel.mockResolvedValue(undefined);
    mockPage.keyboard.type.mockResolvedValue(undefined);
    mockPage.keyboard.press.mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockResolvedValue(undefined);
    mockPage.evaluate.mockResolvedValue(false);
    mockPage.goBack.mockResolvedValue(undefined);
    mockPage.goForward.mockResolvedValue(undefined);
    mockPage.reload.mockResolvedValue(undefined);
    mockPage.close.mockResolvedValue(undefined);

    mockContext.pages.mockReturnValue([mockPage]);
    mockContext.newPage.mockResolvedValue(mockPage);
    mockBrowser.contexts.mockReturnValue([mockContext]);
    mockBrowser.close.mockResolvedValue(undefined);
    mockBrowser.isConnected.mockReturnValue(true);
    connectOverCDP.mockResolvedValue(mockBrowser);
    mockOwnedBrowser.contexts.mockReturnValue([mockContext]);
    mockOwnedBrowser.close.mockResolvedValue(undefined);
    mockOwnedBrowser.isConnected.mockReturnValue(true);
    launchChromium.mockResolvedValue(mockOwnedBrowser);
    probeVerdict.value = null;
    // The install writes this into the web server's env on a test box; the
    // sandbox cases below drive it, so every other case starts from "off".
    delete process.env.CLAWBOX_TEST_MODE;
    chromiumPath.value = "/home/clawbox/.cache/ms-playwright/chromium/chrome";
    realBrowser.value = true;
    getRealBrowser.mockImplementation(async () => realBrowser.value);
    writeBrowserLaunchEnv.mockResolvedValue(undefined);
    execFileMock.mockImplementation((file: string, args?: unknown, options?: unknown, callback?: unknown) => {
      const cb = [args, options, callback].find((value) => typeof value === "function") as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      cb?.(null, "", "");
      return undefined;
    });

    setDesktopBrowserReady();
    await importRoute();
  });

  it("launches a browser session by attaching to desktop Chromium over CDP", async () => {
    const { body } = await launchSession();

    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:18800", {
      timeout: 30_000,
      headers: { Origin: "http://127.0.0.1:18800" },
    });
    expect(mockPage.bringToFront).toHaveBeenCalled();
    expect(body.sessionId).toBeDefined();
    expect(body.url).toBe("https://www.google.com");
  });

  it("starts the desktop browser service when CDP is not ready yet", async () => {
    setDesktopBrowserReady(2);

    const { body } = await launchSession();

    expect(body.sessionId).toBeDefined();
    expect(execFileMock).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "start", "clawbox-browser.service"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("navigates the real desktop browser when launch receives a url", async () => {
    const { body } = await launchSession({ url: "https://example.com" });

    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", expect.any(Object));
    expect(body.sessionId).toBeDefined();
  });

  it("returns error for action without session", async () => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns error for unknown action with session", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("unknown-action", launchBody.sessionId);
    expect(res.status).toBe(400);
  });

  it("handles navigate action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("navigate", launchBody.sessionId, { url: "https://example.com" });
    expect(body.url).toBeDefined();
  });

  it("closes the session's page on close (keeps shared CDP connection alive)", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("close", launchBody.sessionId);
    expect(body.ok).toBe(true);
    expect(mockPage.close).toHaveBeenCalled();
    expect(mockBrowser.close).not.toHaveBeenCalled();
  });

  it("closes a headless Chromium of its own once its last session is gone — never the desktop's", async () => {
    // The desktop port is somebody else's browser: the route launches its own.
    probeVerdict.value = "foreign";
    const { body } = await launchSession();
    expect(launchChromium).toHaveBeenCalledTimes(1);
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(body.sessionId).toBeDefined();

    await sendAction("close", body.sessionId);
    expect(mockPage.close).toHaveBeenCalled();
    expect(mockOwnedBrowser.close).toHaveBeenCalledTimes(1);
    expect(mockBrowser.close).not.toHaveBeenCalled();

    // Nothing stale is reused: the next launch starts a fresh one.
    await launchSession();
    expect(launchChromium).toHaveBeenCalledTimes(2);
  });

  it("keeps its own Chromium while another session still uses it", async () => {
    probeVerdict.value = "foreign";
    const first = (await launchSession()).body.sessionId as string;
    const second = (await launchSession()).body.sessionId as string;
    expect(launchChromium).toHaveBeenCalledTimes(1);

    await sendAction("close", first);
    expect(mockOwnedBrowser.close).not.toHaveBeenCalled();
    await sendAction("close", second);
    expect(mockOwnedBrowser.close).toHaveBeenCalledTimes(1);
  });

  it("reuses the shared CDP connection across launches", async () => {
    await launchSession();
    await launchSession();
    // Both launches resolve through the same cached Browser — connectOverCDP
    // must fire exactly once. Regressing to per-launch attach re-introduces
    // the stale-client pile-up that caused the original CDP timeout.
    expect(connectOverCDP).toHaveBeenCalledTimes(1);
  });

  it("handles click action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("click", launchBody.sessionId, { x: 100, y: 200 });
    expect(body.url).toBeDefined();
  });

  it("handles type action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("type", launchBody.sessionId, { text: "hello" });
    expect(res.status).toBe(200);
  });

  it("handles screenshot action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("screenshot", launchBody.sessionId);
    expect(body.screenshot).toBeDefined();
  });

  it("handles hover action", async () => {
    const { body: launchBody } = await launchSession();

    const { body } = await sendAction("hover", launchBody.sessionId, { x: 10, y: 20 });
    expect(body.ok).toBe(true);
  });

  it("handles dblclick action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("dblclick", launchBody.sessionId, { x: 100, y: 200 });
    expect(res.status).toBe(200);
  });

  it("handles scroll action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("scroll", launchBody.sessionId, { x: 100, y: 200, deltaY: 300 });
    expect(res.status).toBe(200);
  });

  it("handles keydown action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("keydown", launchBody.sessionId, { key: "Enter" });
    expect(res.status).toBe(200);
  });

  it("handles keydown with printable character", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("keydown", launchBody.sessionId, { key: "a" });
    expect(res.status).toBe(200);
  });

  it("handles back action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("back", launchBody.sessionId);
    expect(res.status).toBe(200);
  });

  it("handles forward action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("forward", launchBody.sessionId);
    expect(res.status).toBe(200);
  });

  it("handles refresh action", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("refresh", launchBody.sessionId);
    expect(res.status).toBe(200);
  });

  it("rejects navigate without url", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("navigate", launchBody.sessionId);
    expect(res.status).toBe(400);
  });

  it("rejects type without text", async () => {
    const { body: launchBody } = await launchSession();

    const { res } = await sendAction("type", launchBody.sessionId);
    expect(res.status).toBe(400);
  });

  it("handles launch when screenshots fail", async () => {
    mockPage.screenshot.mockRejectedValue(new Error("screenshot failed"));
    mockPage.title.mockRejectedValue(new Error("no title"));

    const { body } = await launchSession();

    expect(body.sessionId).toBeDefined();
    expect(body.screenshot).toBeNull();
  });

  it("falls back to a headless Chromium when the desktop one never comes up, and says so", async () => {
    // It used to answer 500 here. A window that will not start is a reason to
    // verify somewhere else, not a reason to lose the run's verification —
    // and `browser: "headless"` is how the run learns nobody is watching.
    setDesktopBrowserReady(Number.POSITIVE_INFINITY);

    const { res, body } = await launchSession();
    expect(res.status).toBe(200);
    expect(body.browser).toBe("headless");
    expect(launchChromium).toHaveBeenCalledTimes(1);
    expect(connectOverCDP).not.toHaveBeenCalled();
  }, 15000);

  it("handles invalid JSON", async () => {
    const req = new Request("http://localhost/setup-api/browser", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  /**
   * The Coding Agent's "verify your work on my screen" switch, as this route
   * obeys it: which Chromium a session is opened on, and the answer that says
   * which one it turned out to be.
   */
  describe("the owner's real-browser switch", () => {
    it("drives the desktop Chromium when it is on, and names it in every answer", async () => {
      const { body } = await launchSession();
      expect(connectOverCDP).toHaveBeenCalledTimes(1);
      expect(launchChromium).not.toHaveBeenCalled();
      expect(body.browser).toBe("desktop");

      // Not only the launch reply: an action on the session says it too.
      const { body: shot } = await sendAction("screenshot", body.sessionId);
      expect(shot.browser).toBe("desktop");
      const { body: closed } = await sendAction("close", body.sessionId);
      expect(closed.browser).toBe("desktop");
    });

    it("goes straight to the headless Chromium when it is off, without touching the owner's screen", async () => {
      realBrowser.value = false;

      const { body } = await launchSession();

      expect(body.browser).toBe("headless");
      expect(launchChromium).toHaveBeenCalledTimes(1);
      // Not attached to, not probed, and above all not STARTED: "off" means
      // the desktop is left exactly as the owner left it.
      expect(connectOverCDP).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(writeBrowserLaunchEnv).not.toHaveBeenCalled();
    });

    it("starts the desktop browser when it is on and nothing is up yet", async () => {
      setDesktopBrowserReady(2);

      const { body } = await launchSession();

      expect(body.browser).toBe("desktop");
      expect(execFileMock).toHaveBeenCalledWith(
        "/usr/bin/sudo",
        ["/usr/bin/systemctl", "start", "clawbox-browser.service"],
        expect.any(Object),
        expect.any(Function),
      );
      // systemd starts Chromium, not this server, so the start page has to be
      // on disk first — the same write the manage route's "open" makes.
      expect(writeBrowserLaunchEnv).toHaveBeenCalledTimes(1);
    });

    it("tells a run that asked for the screen that it got the headless browser", async () => {
      // Somebody else's Chromium on the CDP port. The session still works —
      // and the only sign of where it is happening is this field.
      probeVerdict.value = "foreign";

      const { body } = await launchSession();
      expect(body.browser).toBe("headless");
      const { body: navigated } = await sendAction("navigate", body.sessionId, { url: "https://example.com" });
      expect(navigated.browser).toBe("headless");
    });

    it("is read for every session, so a flip does not wait for a restart", async () => {
      const desktop = (await launchSession()).body;
      expect(desktop.browser).toBe("desktop");

      realBrowser.value = false;
      const headless = (await launchSession()).body;
      expect(headless.browser).toBe("headless");

      // Both browsers are live at once, and each session keeps answering for
      // the one it is actually in: closing the headless page must not claim
      // the desktop, and the desktop page must not claim the screen is off.
      expect((await sendAction("screenshot", desktop.sessionId)).body.browser).toBe("desktop");
      expect((await sendAction("screenshot", headless.sessionId)).body.browser).toBe("headless");
    });

    it("closes its own Chromium on ITS count, while a desktop session is still open", async () => {
      // The count that decides is the headless one's own. Counting every
      // session would leave ours resident for as long as any desktop tab is,
      // and closing at any zero would kill it under a live headless page.
      realBrowser.value = false;
      const headless = (await launchSession()).body;
      realBrowser.value = true;
      const desktop = (await launchSession()).body;

      await sendAction("close", headless.sessionId);
      expect(mockOwnedBrowser.close).toHaveBeenCalledTimes(1);
      expect(mockBrowser.close).not.toHaveBeenCalled();
      await sendAction("close", desktop.sessionId);
    });
  });
  it("refuses with chromium_not_installed rather than throwing a launch error", async () => {
    // The standalone server cannot resolve Playwright's runtime through its own
    // lookup, so an absent executable used to surface as a 500 with whatever
    // Playwright said. `chromium_not_installed` is the code browser/manage
    // already answers and the wizard and all ten locales already word.
    realBrowser.value = false;
    chromiumPath.value = null;
    const { res, body } = await launchSession();
    expect(res.status).toBe(400);
    expect(body.code).toBe("chromium_not_installed");
    expect(launchChromium).not.toHaveBeenCalled();
  });

  describe("Chromium's sandbox on the browser we launch ourselves", () => {
    // The same test scripts/launch-browser.sh makes for the window on the
    // screen: this browser opens pages a run or the assistant chose, and a
    // blanket --no-sandbox gave a renderer exploit the clawbox user's
    // privileges. Both inputs are driven here rather than read off whatever
    // host the suite happens to run on — a CI runner with the AppArmor knob
    // set would otherwise fail the case that proves the sandbox stays on.
    const KNOB = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
    /** Answer the kernel knob with `value`, or ENOENT when it is null. */
    function withKernelKnob(value: string | null) {
      const real = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((target: Parameters<typeof fs.readFileSync>[0], options?: unknown) => {
        if (String(target) === KNOB) {
          if (value === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return value;
        }
        return (real as (t: unknown, o?: unknown) => unknown)(target, options);
      }) as typeof fs.readFileSync);
    }
    const launchArgs = () => (launchChromium.mock.calls[0][0] as { args: string[]; executablePath: string });

    afterEach(() => { vi.restoreAllMocks(); });

    it("stays ON where the kernel allows it — a Jetson has no such knob", async () => {
      process.env.CLAWBOX_TEST_MODE = "0";
      withKernelKnob(null);
      realBrowser.value = false;
      await launchSession();
      expect(launchChromium).toHaveBeenCalledTimes(1);
      expect(launchArgs().args).not.toContain("--no-sandbox");
      expect(launchArgs().executablePath).toBe("/home/clawbox/.cache/ms-playwright/chromium/chrome");
    });

    it("comes OFF where the kernel restricts unprivileged user namespaces", async () => {
      // Ubuntu 23.10+ through AppArmor, and the e2e container. Chromium cannot
      // start its namespace sandbox there, so a browser with it on is no
      // browser at all.
      process.env.CLAWBOX_TEST_MODE = "0";
      withKernelKnob("1\n");
      realBrowser.value = false;
      await launchSession();
      expect(launchArgs().args).toContain("--no-sandbox");
      expect(launchArgs().args).toContain("--disable-setuid-sandbox");
    });

    it("comes OFF under the install's own test flag", async () => {
      process.env.CLAWBOX_TEST_MODE = "1";
      withKernelKnob("0\n");
      realBrowser.value = false;
      await launchSession();
      expect(launchArgs().args).toContain("--no-sandbox");
    });
  });

});
