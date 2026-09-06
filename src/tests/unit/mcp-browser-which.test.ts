/**
 * WHICH browser answered, relayed to the agent (mcp/tools/browser.ts).
 *
 * The browser route drives the desktop's own Chromium while the Coding Agent's
 * real-browser setting is on and that window can be brought up, and an
 * invisible one of its own otherwise. The two are indistinguishable from a
 * screenshot, so the route names the one it used in every reply and these
 * tools pass that on: a run that verified a page nobody could see must not
 * report that the owner watched it, and the assistant must not send the owner
 * to look at a window that was never opened.
 *
 * Pinned here: the fact is said, it is said ONCE per session (a line repeated
 * on every click is the per-call spend briefResult exists to avoid), it is said
 * again when a fresh session lands on the other browser, and a server that
 * predates the field makes no claim at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "../helpers/env";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock("../../../mcp/lib/api", () => ({
  apiPost,
  apiGet: vi.fn(),
  apiTry: async () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

type Which = "desktop" | "headless" | undefined;

/** What the route answers with, one browser at a time. */
let answering: Which = "desktop";

/** A fresh module each time: the stated browser is module state, as it is per session. */
async function browserTools(): Promise<CaptureHarness> {
  vi.resetModules();
  const { registerBrowserTools } = await import("../../../mcp/tools/browser");
  const h = captureRegistrar("openclaw");
  registerBrowserTools(h.reg);
  return h;
}

let restore: () => void;

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR");
  delete process.env.CLAWBOX_RUN_DIR;
  delete process.env.CLAWBOX_RUN_ARTIFACTS_DIR;
  answering = "desktop";
  apiPost.mockImplementation(async (_route: string, body: { action: string }) => {
    const which = answering ? { browser: answering } : {};
    if (body.action === "launch") return { sessionId: "browser-1", ...which };
    if (body.action === "close") return { ok: true };
    return { url: "https://example.test/", title: "Example", description: "A page.", ...which };
  });
});

afterEach(() => {
  restore();
  vi.clearAllMocks();
});

describe("the browser the tools actually drove", () => {
  it("names the desktop window the user can watch", async () => {
    const h = await browserTools();
    const out = await h.call("browser_open", { url: "https://example.test/" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("the device's own window on the desktop");
    expect(out.text).toContain("the user can watch");
  });

  it("says an invisible browser is invisible, and where the owner's switch is", async () => {
    answering = "headless";
    const h = await browserTools();
    const out = await h.call("browser_open", { url: "https://example.test/" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("nothing of this reaches the screen");
    // The owner's setting by name: an agent asked "why can't I see it?" has
    // to be able to answer with the switch rather than with a guess.
    expect(out.text).toMatch(/Coding Agent's real-browser setting/);
    // …and it must not send the user to a screen with nothing on it.
    expect(out.text).toMatch(/Describe the page to the user/);
  });

  it("says it once per session, not on every call", async () => {
    const h = await browserTools();
    const first = await h.call("browser_open", { url: "https://example.test/" });
    const second = await h.call("browser_screenshot");
    const third = await h.call("browser_navigate", { url: "https://example.test/next" });
    expect(first.isError || second.isError || third.isError).toBe(false);
    if (first.isError || second.isError || third.isError) return;
    expect(first.text).toContain("Browser: the device's own window");
    expect(second.text).not.toContain("Browser: ");
    expect(third.text).not.toContain("Browser: ");
  });

  it("says it again when a fresh session lands on the other browser", async () => {
    const h = await browserTools();
    const desktop = await h.call("browser_open", { url: "https://example.test/" });
    expect(desktop.isError).toBe(false);
    // The desktop window went away between the two sessions — the next launch
    // is the box's own headless Chromium, and the agent has to be told.
    answering = "headless";
    await h.call("browser_close");
    const invisible = await h.call("browser_open", { url: "https://example.test/" });
    expect(invisible.isError).toBe(false);
    if (invisible.isError) return;
    expect(invisible.text).toContain("nothing of this reaches the screen");
  });

  it("claims nothing when the device does not say", async () => {
    // A box still running a server from before the field: silence is the only
    // honest answer, since either browser could have taken the page.
    answering = undefined;
    const h = await browserTools();
    const out = await h.call("browser_open", { url: "https://example.test/" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain("Browser: ");
    expect(out.text).toContain("URL: https://example.test/");
  });

  it("inside a run, tells the run to put it in the report", async () => {
    process.env.CLAWBOX_RUN_DIR = "/tmp/clawbox-run-which/work";
    process.env.CLAWBOX_RUN_ARTIFACTS_DIR = "/tmp/clawbox-run-which/evidence";
    const h = await browserTools();
    const out = await h.call("browser_view_local", { path: "index.html" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("the owner can watch this page");
    expect(out.text).toContain("Say so when you report what you verified");
  });
});
