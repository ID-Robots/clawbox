import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KIOSK_CDP_PORT,
  DEFAULT_KIOSK_URL,
  activateKioskTab,
  closeKioskTab,
  isDesktopUrl,
  kioskCdpPort,
  kioskConfigured,
  listKioskTabs,
  openKioskTab,
  parseKioskEnv,
  readKioskUrl,
} from "@/lib/kiosk-tabs";

/**
 * The CDP HTTP client behind the kiosk tab API, against a MOCKED Chrome.
 *
 * The real port (18801) is only live on the x64 laptop after its kiosk session
 * restarts with the flags install-kiosk-tabs.sh adds; nothing in CI or on a
 * Jetson has it, and the module's whole contract for that case is
 * `available: false` — so the fetch stub is the seam, and "nothing on the
 * port" is a rejected fetch, exactly what undici throws for ECONNREFUSED. A
 * box with no kiosk.env never reaches the fetch at all (`kioskConfigured`).
 */

const KIOSK = "http://localhost:3005/";

type Call = { url: string; method: string };
const calls: Call[] = [];
let respond: (url: string, method: string) => Response | Promise<Response>;

const DESKTOP = { id: "AAAA1111", type: "page", title: "ClawBox", url: "http://localhost:3005/", faviconUrl: "" };
const ANTHROPIC = {
  id: "BBBB2222",
  type: "page",
  title: "Sign in — Anthropic",
  url: "https://claude.ai/oauth/authorize?x=1",
  faviconUrl: "https://claude.ai/favicon.ico",
};
const APP_VNC = { id: "CCCC3333", type: "page", title: "VNC", url: "http://localhost:3005/app/vnc", faviconUrl: "" };
const WORKER = { id: "DDDD4444", type: "service_worker", title: "ext", url: "chrome-extension://abc/background.js" };

beforeEach(() => {
  calls.length = 0;
  respond = () => new Response("[]", { status: 200 });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return respond(url, method);
  }));
  process.env.CLAWBOX_KIOSK_URL = KIOSK;
  delete process.env.CLAWBOX_KIOSK_CDP_PORT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLAWBOX_KIOSK_URL;
  delete process.env.CLAWBOX_KIOSK_CDP_PORT;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refused = () => { throw new TypeError("fetch failed"); };

describe("kioskCdpPort", () => {
  it("defaults to 18801 and takes CLAWBOX_KIOSK_CDP_PORT", () => {
    expect(kioskCdpPort({})).toBe(DEFAULT_KIOSK_CDP_PORT);
    expect(kioskCdpPort({ CLAWBOX_KIOSK_CDP_PORT: "19999" })).toBe(19999);
  });

  it("falls back on garbage", () => {
    expect(kioskCdpPort({ CLAWBOX_KIOSK_CDP_PORT: "nope" })).toBe(DEFAULT_KIOSK_CDP_PORT);
    expect(kioskCdpPort({ CLAWBOX_KIOSK_CDP_PORT: "70000" })).toBe(DEFAULT_KIOSK_CDP_PORT);
    expect(kioskCdpPort({ CLAWBOX_KIOSK_CDP_PORT: "0" })).toBe(DEFAULT_KIOSK_CDP_PORT);
  });
});

describe("parseKioskEnv / readKioskUrl", () => {
  it("reads CLAWBOX_KIOSK_URL in the systemd EnvironmentFile shapes", () => {
    expect(parseKioskEnv("CLAWBOX_KIOSK_URL=http://localhost:3005/")).toBe("http://localhost:3005/");
    expect(parseKioskEnv('export CLAWBOX_KIOSK_URL="http://localhost:3005/"')).toBe("http://localhost:3005/");
    expect(parseKioskEnv("# comment\nOTHER=1\nCLAWBOX_KIOSK_URL='http://box.local/'\n")).toBe("http://box.local/");
    expect(parseKioskEnv("OTHER=1\n")).toBeNull();
    expect(parseKioskEnv("CLAWBOX_KIOSK_URL=\n")).toBeNull();
  });

  it("prefers the environment, then the default when neither source names an http(s) URL", () => {
    expect(readKioskUrl({ CLAWBOX_KIOSK_URL: "http://192.168.1.5:3005/" })).toBe("http://192.168.1.5:3005/"); // public-hygiene: allow synthetic test fixture, not a real host/account/credential
    // Whatever /etc/clawbox/kiosk.env says on the machine running the suite
    // is not the test's business: the env candidate is judged first, and a
    // non-URL one is skipped rather than returned.
    expect(readKioskUrl({ CLAWBOX_KIOSK_URL: "file:///etc/passwd" })).not.toBe("file:///etc/passwd");
    expect(readKioskUrl({ CLAWBOX_KIOSK_URL: "not a url" })).toMatch(/^https?:\/\//);
    expect(DEFAULT_KIOSK_URL).toBe("http://localhost:3005/");
  });
});

describe("isDesktopUrl", () => {
  it("is the kiosk origin's shell pages, not the pages the desktop opens top-level", () => {
    expect(isDesktopUrl("http://localhost:3005/", KIOSK)).toBe(true);
    expect(isDesktopUrl("http://localhost:3005/?chat=1", KIOSK)).toBe(true);
    expect(isDesktopUrl("http://localhost:3005/login", KIOSK)).toBe(true);
    expect(isDesktopUrl("http://localhost:3005/setup/settings", KIOSK)).toBe(true);
    expect(isDesktopUrl("http://localhost:3005/updating?x=1", KIOSK)).toBe(true);
    expect(isDesktopUrl("http://localhost:3005/portal/subscribe", KIOSK)).toBe(true);
    expect(isDesktopUrl("http://localhost:3005/app/vnc", KIOSK)).toBe(false);
    expect(isDesktopUrl("http://localhost:3005/app/settings#a", KIOSK)).toBe(false);
    expect(isDesktopUrl("http://localhost:3005/apps/starcraft/", KIOSK)).toBe(false);
    expect(isDesktopUrl("http://localhost:3005/setup-api/webapps?app=weather", KIOSK)).toBe(false);
    expect(isDesktopUrl("http://localhost:3005/loginx", KIOSK)).toBe(false);
  });

  it("is never another origin, and never an unparsable string", () => {
    expect(isDesktopUrl("http://localhost:3000/", KIOSK)).toBe(false);
    expect(isDesktopUrl("https://claude.ai/", KIOSK)).toBe(false);
    expect(isDesktopUrl("http://127.0.0.1:3005/", KIOSK)).toBe(false);
    expect(isDesktopUrl("about:blank", KIOSK)).toBe(false);
    expect(isDesktopUrl("garbage", KIOSK)).toBe(false);
  });
});

describe("a box with no kiosk", () => {
  // Every Jetson: no kiosk.env (the suite points the file at nowhere,
  // vitest.config.ts) and no CLAWBOX_KIOSK_URL.
  beforeEach(() => { delete process.env.CLAWBOX_KIOSK_URL; });

  it("is configured only by kiosk.env or CLAWBOX_KIOSK_URL", () => {
    expect(kioskConfigured()).toBe(false);
    expect(kioskConfigured({ CLAWBOX_KIOSK_URL: KIOSK })).toBe(true);
    expect(kioskConfigured({ CLAWBOX_KIOSK_ENV_FILE: __filename })).toBe(true);
  });

  it("never dials the CDP port — OpenClaw's own browsers may hold it — and answers available:false", async () => {
    // Something DOES answer on the port: it must still not be taken for a kiosk.
    respond = () => json([ANTHROPIC]);
    expect(await listKioskTabs()).toEqual({ available: false, tabs: [] });
    expect(await openKioskTab("https://example.com/")).toEqual({ ok: false, available: false });
    expect(await activateKioskTab("BBBB2222")).toEqual({ ok: false, available: false });
    expect(await closeKioskTab("BBBB2222")).toEqual({ ok: false, available: false });
    expect(calls).toHaveLength(0);
  });
});

describe("listKioskTabs", () => {
  it("answers available:false, not an error, when nothing is on the port", async () => {
    respond = refused;
    await expect(listKioskTabs()).resolves.toEqual({ available: false, tabs: [] });
    expect(calls[0]).toEqual({ url: `http://127.0.0.1:${DEFAULT_KIOSK_CDP_PORT}/json/list`, method: "GET" });
  });

  it("uses CLAWBOX_KIOSK_CDP_PORT", async () => {
    process.env.CLAWBOX_KIOSK_CDP_PORT = "19001";
    respond = refused;
    await listKioskTabs();
    expect(calls[0].url).toBe("http://127.0.0.1:19001/json/list");
  });

  it("answers available:false on a non-JSON or non-array body", async () => {
    respond = () => new Response("<html>nope</html>", { status: 200 });
    await expect(listKioskTabs()).resolves.toEqual({ available: false, tabs: [] });
    respond = () => json({ not: "a list" });
    await expect(listKioskTabs()).resolves.toEqual({ available: false, tabs: [] });
    respond = () => json([], 500);
    await expect(listKioskTabs()).resolves.toEqual({ available: false, tabs: [] });
  });

  it("lists page targets only, marks the desktop, and keeps http(s) favicons", async () => {
    respond = () => json([DESKTOP, ANTHROPIC, APP_VNC, WORKER, { id: "EEEE", type: "page", url: "chrome://settings/" }]);
    const list = await listKioskTabs();
    expect(list.available).toBe(true);
    expect(list.tabs.map((t) => t.id)).toEqual(["AAAA1111", "BBBB2222", "CCCC3333"]);
    expect(list.tabs[0]).toMatchObject({ isDesktop: true, favicon: "", title: "ClawBox" });
    expect(list.tabs[1]).toMatchObject({ isDesktop: false, favicon: "https://claude.ai/favicon.ico" });
    expect(list.tabs[2]).toMatchObject({ isDesktop: false, url: "http://localhost:3005/app/vnc" });
  });

  it("lists the kiosk extension's start page, and no other extension page", async () => {
    // kiosk/extension/newtab.html is where the bar's "+" lands; the shelf
    // must show that tab or a fresh tab is invisible until it navigates.
    const START = { id: "FFFF5555", type: "page", title: "New tab", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/newtab.html" };
    const OTHER = { id: "FFFF6666", type: "page", title: "x", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/other.html" };
    respond = () => json([DESKTOP, START, OTHER, WORKER]);
    const list = await listKioskTabs();
    expect(list.tabs.map((t) => t.id)).toEqual(["AAAA1111", "FFFF5555"]);
    expect(list.tabs[1]).toMatchObject({ isDesktop: false, title: "New tab", favicon: "" });
  });

  it("drops a target whose id could not go into a URL path", async () => {
    respond = () => json([{ ...ANTHROPIC, id: "../json/close/AAAA1111" }, { ...DESKTOP, title: 7 }]);
    const list = await listKioskTabs();
    expect(list.tabs).toHaveLength(1);
    expect(list.tabs[0]).toMatchObject({ id: "AAAA1111", title: "" });
  });
});

describe("openKioskTab", () => {
  it("PUTs /json/new with the encoded URL", async () => {
    respond = () => json({ ...ANTHROPIC, id: "NEW1" });
    const r = await openKioskTab("https://claude.ai/oauth/authorize?x=1&y=2");
    expect(calls[0]).toEqual({
      url: `http://127.0.0.1:18801/json/new?${encodeURIComponent("https://claude.ai/oauth/authorize?x=1&y=2")}`,
      method: "PUT",
    });
    expect(r).toEqual({ ok: true, available: true });
  });

  it("refuses anything but http(s) before touching Chrome", async () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "not a url", ""]) {
      const r = await openKioskTab(bad);
      expect(r).toMatchObject({ ok: false, available: true, code: "invalid_url" });
    }
    expect(calls).toHaveLength(0);
  });

  it("is available:false when nothing answers, and a cdp_error on a refusal", async () => {
    respond = refused;
    expect(await openKioskTab("https://example.com/")).toEqual({ ok: false, available: false });
    respond = () => new Response("nope", { status: 500 });
    expect(await openKioskTab("https://example.com/")).toMatchObject({ ok: false, available: true, code: "cdp_error" });
  });

});

describe("activateKioskTab / closeKioskTab", () => {
  it("GET /json/activate/<id> and /json/close/<id>", async () => {
    respond = () => new Response("Target activated", { status: 200 });
    expect(await activateKioskTab("BBBB2222")).toEqual({ ok: true, available: true });
    expect(await closeKioskTab("BBBB2222")).toEqual({ ok: true, available: true });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:18801/json/activate/BBBB2222",
      "http://127.0.0.1:18801/json/close/BBBB2222",
    ]);
  });

  it("refuses an id that is not a target id, before any request", async () => {
    expect(await activateKioskTab("../version")).toMatchObject({ ok: false, code: "invalid_id" });
    expect(await closeKioskTab("")).toMatchObject({ ok: false, code: "invalid_id" });
    expect(await closeKioskTab("a b")).toMatchObject({ ok: false, code: "invalid_id" });
    expect(calls).toHaveLength(0);
  });

  it("maps Chrome's 404 to not_found and a dead port to available:false", async () => {
    respond = () => new Response("No such target id", { status: 404 });
    expect(await activateKioskTab("ZZZZ")).toMatchObject({ ok: false, available: true, code: "not_found" });
    respond = refused;
    expect(await closeKioskTab("ZZZZ")).toEqual({ ok: false, available: false });
  });
});
