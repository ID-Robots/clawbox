/**
 * A run's captures are of its own tab (mcp/tools/browser.ts).
 *
 * Seen on a live run: browser_view_local drove the desktop browser and the
 * shot it archived showed an unrelated tab, which the run then reported as its
 * own work. Pinned here: with no live session the file opens straight into a
 * new tab of the run's (never a blank launch first); a live session navigates
 * its own tab; a reply for any page but the requested file archives NOTHING
 * and says so; and browser_screenshot with nothing open tells the run to open
 * a page rather than launching a blank one to describe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { saveEnv } from "../helpers/env";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";
import { registerBrowserTools } from "../../../mcp/tools/browser";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock("../../../mcp/lib/api", () => ({
  apiPost,
  apiGet: vi.fn(),
  apiTry: async () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

/** PNG signature and an IHDR header: what the browser route hands back, base64. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

let base: string;
let work: string;
let evidence: string;
let restore: () => void;
/** The address the session's tab is on, as the route would report it. */
let at: string;
/** When set, the page every capture reports instead — the foreign tab. */
let shownInstead: string | null;

/**
 * ONE module instance throughout, as in mcp-browser-describe.test.ts: a module
 * reset would give the tool a ToolError class the harness does not know, and
 * every refusal would come back as INTERNAL. The session id is the tool's
 * module state, and browser_close clears it before each case.
 */
function browserTools(): CaptureHarness {
  const h = captureRegistrar("openclaw");
  registerBrowserTools(h.reg);
  return h;
}

const calls = (action: string) =>
  apiPost.mock.calls.map(([, body]) => body as Record<string, unknown>).filter((body) => body.action === action);
const shotsOnDisk = () => (fs.existsSync(evidence) ? fs.readdirSync(evidence).filter((f) => /^shot-\d+\.png$/.test(f)) : []);

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR");
  // Real path: the route answers with the file's real address.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-run-tab-")));
  work = path.join(base, "work");
  evidence = path.join(base, "evidence", "run-abc12345");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "index.html"), "<h1>the run's page</h1>");
  process.env.CLAWBOX_RUN_DIR = work;
  process.env.CLAWBOX_RUN_ARTIFACTS_DIR = evidence;
  at = "about:blank";
  shownInstead = null;
  apiPost.mockReset();
  apiPost.mockImplementation(async (_route: string, body: { action: string; url?: string; sessionId?: string }) => {
    if (body.url) at = body.url;
    if (body.action === "launch") return { sessionId: "browser-7", url: at, browser: "desktop" };
    if (body.action === "close") return { ok: true };
    return { url: shownInstead ?? at, title: "Page", screenshot: PNG, description: "A page.", browser: "desktop" };
  });
  // Clear whatever session the previous case left in the module.
  await browserTools().call("browser_close");
  apiPost.mockClear();
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("browser_view_local", () => {
  it("opens the file straight into a new run tab when there is no live session", async () => {
    const h = browserTools();
    const out = await h.call("browser_view_local", { path: "index.html" });
    expect(out.isError).toBe(false);
    if (out.isError) return;

    const fileUrl = pathToFileURL(path.join(work, "index.html")).href;
    const launches = calls("launch");
    expect(launches).toHaveLength(1);
    expect(launches[0].url).toBe(fileUrl);
    // No blank launch to navigate afterwards: the tab opens on the file.
    expect(calls("navigate")).toHaveLength(0);
    expect(calls("screenshot").filter((b) => b.describe === true)).toHaveLength(1);
    expect(out.text).toContain("archived to this run's evidence folder");
    expect(shotsOnDisk()).toHaveLength(1);
  });

  it("navigates the run's own tab when its session is live", async () => {
    const h = browserTools();
    expect((await h.call("browser_view_local", { path: "index.html" })).isError).toBe(false);
    apiPost.mockClear();

    const again = await h.call("browser_view_local", { path: path.join(work, "index.html") });
    expect(again.isError).toBe(false);
    expect(calls("launch")).toHaveLength(0);
    const navigations = calls("navigate");
    expect(navigations).toHaveLength(1);
    expect(navigations[0].sessionId).toBe("browser-7");
  });

  it("keeps the shot of a page whose own script changed its query or fragment", async () => {
    const h = browserTools();
    shownInstead = `${pathToFileURL(path.join(work, "index.html")).href}?tab=2#done`;
    const out = await h.call("browser_view_local", { path: "index.html" });
    expect(out.isError).toBe(false);
    expect(shotsOnDisk()).toHaveLength(1);
  });

  it("saves no shot when the reply is for a different page, and says a different page was shown", async () => {
    const h = browserTools();
    // The desktop's foremost tab, answered in place of the run's file.
    shownInstead = "https://unrelated.example/inbox";
    const out = await h.call("browser_view_local", { path: "index.html" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toContain("different page");
    expect(out.error.message).toContain("https://unrelated.example/inbox");
    expect(shotsOnDisk()).toHaveLength(0);
    expect(fs.existsSync(path.join(evidence, ".shot-notes.json"))).toBe(false);
  });

  it("saves no shot when a live session's navigate answers for a different page", async () => {
    const h = browserTools();
    expect((await h.call("browser_view_local", { path: "index.html" })).isError).toBe(false);
    const before = shotsOnDisk().length;
    shownInstead = "https://unrelated.example/inbox";
    const out = await h.call("browser_view_local", { path: "index.html" });
    expect(out.isError).toBe(true);
    expect(shotsOnDisk()).toHaveLength(before);
  });
});

describe("browser_screenshot inside a run", () => {
  it("tells the run to open a page first when it has none, and launches nothing", async () => {
    const h = browserTools();
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.next).toMatch(/Open a page first/);
    expect(out.error.next).toContain("browser_view_local");
    expect(calls("launch")).toHaveLength(0);
    expect(calls("screenshot")).toHaveLength(0);
  });

  it("says the same once the run's tab is gone, instead of opening a blank one", async () => {
    const h = browserTools();
    expect((await h.call("browser_view_local", { path: "index.html" })).isError).toBe(false);
    // The route answers 410 for the closed tab: apiPost throws on non-2xx.
    apiPost.mockImplementation(async () => {
      throw new Error("API 410");
    });
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.next).toMatch(/Open a page first/);
  });

  it("captures the run's open tab", async () => {
    const h = browserTools();
    expect((await h.call("browser_view_local", { path: "index.html" })).isError).toBe(false);
    apiPost.mockClear();
    const out = await h.call("browser_screenshot");
    expect(out.isError).toBe(false);
    expect(calls("launch")).toHaveLength(0);
    expect(calls("screenshot").filter((b) => b.describe === true && b.sessionId === "browser-7")).toHaveLength(1);
  });
});
