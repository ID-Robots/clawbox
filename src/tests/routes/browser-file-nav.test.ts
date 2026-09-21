/**
 * POST /setup-api/browser — the one file:// exception to SEC-4.
 *
 * A coding run may open the page it is building, and nothing else. The
 * property pinned here is that what is CHECKED is what is OPENED: the
 * browser is sent to the resolved real path, so a symlink inside the run's
 * folder that pointed inside it when it was checked cannot be swapped to
 * point outside between the check and Chromium's own open. A link that
 * already points outside is refused as before, and with no run active there
 * is no file:// at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const mocks = vi.hoisted(() => ({
  activeRunDirectory: vi.fn<() => string | null>(),
  getRun: vi.fn(),
  ownsLocalPreview: vi.fn(async () => false),
  page: {
    goto: vi.fn(),
    route: vi.fn(),
    url: vi.fn(() => "file:///opened"),
    title: vi.fn(async () => "Page"),
    screenshot: vi.fn(async () => Buffer.from("PNG")),
    bringToFront: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/coding-local-preview", () => ({ ownsLocalPreview: mocks.ownsLocalPreview }));

vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  activeRunDirectory: mocks.activeRunDirectory,
  getRun: mocks.getRun,
}));

// Readiness is not this test's subject: the probe would otherwise call the
// stubbed fetch's empty body "down" and wait six seconds for a service.
vi.mock("@/lib/cdp-probe", () => ({ probeCdp: async () => "ours", describePortOwner: async () => "", findPlaywrightChromium: () => null }));
vi.mock("child_process", () => ({
  execFile: vi.fn((_file: unknown, _args: unknown, _opts: unknown, cb?: (err: null, out: string, errOut: string) => void) => {
    cb?.(null, "", "");
  }),
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: vi.fn(async () => ({
      contexts: () => [{ pages: () => [mocks.page], newPage: async () => mocks.page }],
      isConnected: () => true,
      on: vi.fn(),
    })),
  },
}));

let POST: (req: Request) => Promise<Response>;
let base: string;
let runDir: string;

async function launch() {
  const res = await POST(new Request("http://localhost/setup-api/browser", {
    method: "POST",
    body: JSON.stringify({ action: "launch" }),
  }));
  return (await res.json()).sessionId as string;
}

async function navigate(sessionId: string, url: string) {
  const res = await POST(new Request("http://localhost/setup-api/browser", {
    method: "POST",
    body: JSON.stringify({ action: "navigate", sessionId, url }),
  }));
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  vi.resetModules();
  delete (mocks.page as typeof mocks.page & { __navGuardInstalled?: boolean }).__navGuardInstalled;
  mocks.ownsLocalPreview.mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response));
  mocks.page.goto.mockResolvedValue(undefined);
  mocks.page.route.mockResolvedValue(undefined);
  mocks.page.url.mockReturnValue("file:///opened");
  mocks.page.title.mockResolvedValue("Page");
  mocks.page.screenshot.mockResolvedValue(Buffer.from("PNG"));
  mocks.page.bringToFront.mockResolvedValue(undefined);
  mocks.page.evaluate.mockResolvedValue(false);

  base = fs.mkdtempSync(path.join(os.tmpdir(), "browser-file-nav-"));
  runDir = path.join(base, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(base, "secret.txt"), "not for the browser");
  fs.symlinkSync(path.join(runDir, "index.html"), path.join(runDir, "inside.html"));
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(runDir, "outside.html"));
  mocks.activeRunDirectory.mockReturnValue(runDir);

  POST = (await import("@/app/setup-api/browser/route")).POST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("file:// navigation inside the active run", () => {
  it("opens the RESOLVED path of a link that points inside the folder, query and fragment intact", async () => {
    const id = await launch();
    const asked = `${pathToFileURL(path.join(runDir, "inside.html")).href}?v=1#top`;
    const { status } = await navigate(id, asked);
    expect(status).toBe(200);
    const target = pathToFileURL(fs.realpathSync(path.join(runDir, "index.html")));
    target.search = "?v=1";
    target.hash = "#top";
    expect(mocks.page.goto).toHaveBeenCalledTimes(1);
    expect(mocks.page.goto.mock.calls[0][0]).toBe(target.href);
    expect(mocks.page.goto.mock.calls[0][0]).not.toContain("inside.html");
  });

  it("opens a plain file in the folder at its real path", async () => {
    const id = await launch();
    const { status } = await navigate(id, pathToFileURL(path.join(runDir, "index.html")).href);
    expect(status).toBe(200);
    expect(mocks.page.goto.mock.calls[0][0]).toBe(pathToFileURL(fs.realpathSync(path.join(runDir, "index.html"))).href);
  });

  it("refuses a link that points outside the folder, and never navigates", async () => {
    const id = await launch();
    const { status, body } = await navigate(id, pathToFileURL(path.join(runDir, "outside.html")).href);
    expect(status).toBe(400);
    expect(body.error).toMatch(/outside the active coding run's folder/);
    expect(mocks.page.goto).not.toHaveBeenCalled();
  });

  it("refuses a file that is not there, and a file:// with no run active", async () => {
    const id = await launch();
    const missing = await navigate(id, pathToFileURL(path.join(runDir, "missing.html")).href);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/file not found/);

    mocks.activeRunDirectory.mockReturnValue(null);
    const noRun = await navigate(id, pathToFileURL(path.join(runDir, "index.html")).href);
    expect(noRun.status).toBe(400);
    expect(noRun.body.error).toMatch(/no coding run is active/);
    expect(mocks.page.goto).not.toHaveBeenCalled();
  });
});


it("scopes concurrent run pages to the requested run and rejects another run's session", async () => {
  const otherDir = path.join(base, "other");
  fs.mkdirSync(otherDir);
  fs.writeFileSync(path.join(otherDir, "index.html"), "other run");
  mocks.getRun.mockImplementation((id) => ({ id, status: "running", directory: id === "run-aaaaaaaa" ? runDir : otherDir, pgid: null }));
  const request = (body: unknown) => POST(new Request("http://localhost/setup-api/browser", { method: "POST", body: JSON.stringify(body) }));
  const launched = await request({ action: "launch", codingRunId: "run-bbbbbbbb" });
  const { sessionId } = await launched.json();
  expect(launched.status).toBe(200);
  expect((await request({ action: "navigate", sessionId, codingRunId: "run-bbbbbbbb", url: pathToFileURL(path.join(otherDir, "index.html")).href })).status).toBe(200);
  const outside = await request({ action: "navigate", sessionId, codingRunId: "run-bbbbbbbb", url: pathToFileURL(path.join(runDir, "index.html")).href });
  expect(outside.status).toBe(400);
  expect((await outside.json()).error).toContain("outside the active coding run\'s folder");
  expect((await request({ action: "navigate", sessionId, codingRunId: "run-aaaaaaaa", url: "http://127.0.0.1:80/" })).status).toBe(403);
  mocks.getRun.mockReturnValue({ status: "completed" });
  const inactive = await request({ action: "launch", codingRunId: "run-bbbbbbbb" });
  expect(inactive.status).toBe(400);
  expect((await inactive.json()).error).toContain("Coding run is not active");
});

it("coalesces owned asset validation but rechecks navigation, expiry and run liveness", async () => {
  mocks.getRun.mockReturnValue({ status: "running", directory: runDir, pgid: 123 });
  mocks.ownsLocalPreview.mockResolvedValue(true);
  const launched = await POST(new Request("http://localhost/setup-api/browser", { method: "POST", body: JSON.stringify({ action: "launch", codingRunId: "run-aaaaaaaa" }) }));
  expect(launched.status).toBe(200);
  const guard = mocks.page.route.mock.calls.at(-1)![1];
  let now = 10000;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const request = async (navigation: boolean, url = "http://127.0.0.1:4321/app.js") => {
    const route = { request: () => ({ url: () => url, isNavigationRequest: () => navigation }), abort: vi.fn(), continue: vi.fn() };
    await guard(route);
    return route;
  };
  try {
    mocks.ownsLocalPreview.mockClear();
    const assets = await Promise.all(Array.from({ length: 20 }, () => request(false)));
    expect(assets.every((r) => r.continue.mock.calls.length === 1)).toBe(true);
    expect(mocks.ownsLocalPreview).toHaveBeenCalledTimes(1);
    await request(true);
    expect(mocks.ownsLocalPreview).toHaveBeenCalledTimes(2);
    mocks.ownsLocalPreview.mockResolvedValue(false);
    expect((await request(true)).abort).toHaveBeenCalled();
    expect((await request(false)).abort).toHaveBeenCalled();
    now += 5001;
    mocks.ownsLocalPreview.mockResolvedValue(true);
    expect((await request(false)).continue).toHaveBeenCalled();
    expect(mocks.ownsLocalPreview).toHaveBeenCalledTimes(4);
    mocks.getRun.mockReturnValue({ status: "completed" });
    expect((await request(false)).abort).toHaveBeenCalled();
    expect(mocks.ownsLocalPreview).toHaveBeenCalledTimes(4);
  } finally { clock.mockRestore(); }
});
