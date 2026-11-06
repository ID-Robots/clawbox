/**
 * POST /setup-api/browser — a run's captures come from the tab the run opened.
 *
 * Seen on a live run: the run's preview check fell back to the desktop
 * browser, and the screenshot it archived showed an unrelated tab that was in
 * front — reported to the owner as the run's own work. The desktop browser is
 * the owner's too, so its `pages()` holds tabs nobody here opened.
 *
 * The route test next door hands back ONE page from both `pages()` and
 * `newPage()`, where the run's tab and a foreign one look identical. Here they
 * are two: `foreignPage` is the owner's foremost tab, `runPage` is the one
 * `newPage()` makes, and every navigation and capture must land on runPage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const RUN = "run-aaaaaaaa";
const OTHER_RUN = "run-bbbbbbbb";

const mocks = vi.hoisted(() => {
  /** A page that keeps its own address and an event log of what was done to it. */
  const makePage = (name: string, events: string[]) => {
    let current = "about:blank";
    return {
      goto: vi.fn(async (url: string) => {
        events.push(`${name}:goto`);
        current = url;
      }),
      route: vi.fn(async () => undefined),
      url: vi.fn(() => current),
      title: vi.fn(async () => `${name} title`),
      screenshot: vi.fn(async (opts?: { type?: string }) => {
        events.push(`${name}:shot:${opts?.type ?? "png"}`);
        return Buffer.from(`${name}-${opts?.type ?? "png"}`);
      }),
      bringToFront: vi.fn(async () => {
        events.push(`${name}:front`);
      }),
      isClosed: vi.fn(() => false),
      evaluate: vi.fn(async () => false),
      close: vi.fn(async () => undefined),
      _reset() {
        current = "about:blank";
      },
    };
  };
  const events: string[] = [];
  const foreignPage = makePage("foreign", events);
  const runPage = makePage("run", events);
  const context = {
    // The owner's tab is the only one there, and in front.
    pages: vi.fn(() => [foreignPage]),
    newPage: vi.fn(async () => runPage),
  };
  return {
    events,
    foreignPage,
    runPage,
    context,
    getRun: vi.fn(),
    activeRunId: vi.fn<() => string | null>(() => null),
    activeRunDirectory: vi.fn<() => string | null>(() => null),
    ownsLocalPreview: vi.fn(async () => true),
    describeImage: vi.fn(async () => ({ text: "The run's own page.", error: null })),
  };
});

vi.mock("@/lib/coding-local-preview", () => ({ ownsLocalPreview: mocks.ownsLocalPreview }));

vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  getRun: mocks.getRun,
  activeRunId: mocks.activeRunId,
  activeRunDirectory: mocks.activeRunDirectory,
  // The owner's "verify on my screen" switch: on, so this is the DESKTOP browser.
  getRealBrowser: async () => true,
}));

vi.mock("@/lib/vision-describe", () => ({ describeImage: mocks.describeImage }));

// Readiness is not this test's subject: the desktop browser is up and ours.
vi.mock("@/lib/cdp-probe", () => ({
  probeCdp: async () => "ours",
  describePortOwner: async () => "",
  portOwnerPid: async () => null,
  findPlaywrightChromium: () => null,
}));

vi.mock("child_process", () => ({
  execFile: vi.fn((_file: unknown, _args: unknown, _opts: unknown, cb?: (err: null, out: string, errOut: string) => void) => {
    cb?.(null, "", "");
  }),
}));

vi.mock("playwright", () => ({
  chromium: {
    connectOverCDP: vi.fn(async () => ({
      contexts: () => [mocks.context],
      isConnected: () => true,
      on: vi.fn(),
    })),
  },
}));

let POST: (req: Request) => Promise<Response>;
let base: string;
let runDir: string;

async function call(body: Record<string, unknown>) {
  const res = await POST(new Request("http://localhost/setup-api/browser", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

const pages = () => [mocks.foreignPage, mocks.runPage];

/** The foreign tab was never steered, raised or captured. */
function expectForeignUntouched() {
  expect(mocks.foreignPage.goto).not.toHaveBeenCalled();
  expect(mocks.foreignPage.screenshot).not.toHaveBeenCalled();
  expect(mocks.foreignPage.bringToFront).not.toHaveBeenCalled();
}

/** Every capture of the run's tab came straight after that tab was raised. */
function expectRaisedBeforeEveryShot() {
  const shots = mocks.events.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith("run:shot"));
  expect(shots.length).toBeGreaterThan(0);
  for (const [, i] of shots) expect(mocks.events[i - 1]).toBe("run:front");
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.events.length = 0;
  for (const page of pages()) {
    page._reset();
    page.isClosed.mockReturnValue(false);
    delete (page as typeof page & { __navGuardInstalled?: boolean }).__navGuardInstalled;
  }
  mocks.context.pages.mockReturnValue([mocks.foreignPage]);
  mocks.context.newPage.mockResolvedValue(mocks.runPage);
  mocks.ownsLocalPreview.mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response));

  base = fs.mkdtempSync(path.join(os.tmpdir(), "browser-run-tab-"));
  runDir = path.join(base, "run");
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, "index.html"), "<h1>the run's page</h1>");
  mocks.getRun.mockImplementation((id: string) =>
    id === RUN || id === OTHER_RUN ? { id, status: "running", directory: runDir, pgid: 4242, unit: null } : null,
  );
  mocks.activeRunId.mockReturnValue(RUN);
  mocks.activeRunDirectory.mockReturnValue(runDir);

  POST = (await import("@/app/setup-api/browser/route")).POST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("a run's view of its own page", () => {
  it("opens a file:// view in the run's new tab and captures only that tab", async () => {
    const fileUrl = pathToFileURL(fs.realpathSync(path.join(runDir, "index.html"))).href;
    const launched = await call({ action: "launch", codingRunId: RUN });
    expect(launched.status).toBe(200);
    expect(mocks.context.newPage).toHaveBeenCalledTimes(1);

    const viewed = await call({ action: "navigate", sessionId: launched.body.sessionId, codingRunId: RUN, url: fileUrl, describe: true });
    expect(viewed.status).toBe(200);
    expect(mocks.runPage.goto).toHaveBeenCalledWith(fileUrl, expect.any(Object));
    expect(viewed.body.url).toBe(fileUrl);
    expect(viewed.body.screenshot).toBe(Buffer.from("run-png").toString("base64"));
    // The description is of the run's tab too: its JPEG, not the foreign one's.
    expect(mocks.runPage.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: "jpeg" }));
    expect(mocks.describeImage).toHaveBeenCalledWith(Buffer.from("run-jpeg").toString("base64"), undefined, "image/jpeg");
    expect(viewed.body.description).toBe("The run's own page.");

    expectRaisedBeforeEveryShot();
    expectForeignUntouched();
  });

  it("opens the file straight into a new run tab when the launch names it", async () => {
    // browser_view_local with no live session: no blank launch first.
    const fileUrl = pathToFileURL(fs.realpathSync(path.join(runDir, "index.html"))).href;
    const launched = await call({ action: "launch", codingRunId: RUN, url: fileUrl });
    expect(launched.status).toBe(200);
    expect(launched.body.url).toBe(fileUrl);
    expect(launched.body.screenshot).toBe(Buffer.from("run-png").toString("base64"));
    expect(mocks.runPage.goto).toHaveBeenCalledTimes(1);

    const shot = await call({ action: "screenshot", sessionId: launched.body.sessionId, codingRunId: RUN, describe: true });
    expect(shot.status).toBe(200);
    expect(shot.body.url).toBe(fileUrl);

    expectRaisedBeforeEveryShot();
    expectForeignUntouched();
  });

  it("opens a loopback preview the run serves in the run's tab and captures only that tab", async () => {
    const launched = await call({ action: "launch", codingRunId: RUN, url: "http://127.0.0.1:3000/" });
    expect(launched.status).toBe(200);
    expect(mocks.ownsLocalPreview).toHaveBeenCalled();
    expect(mocks.runPage.goto).toHaveBeenCalledWith("http://127.0.0.1:3000/", expect.any(Object));
    expect(launched.body.url).toBe("http://127.0.0.1:3000/");
    expect(launched.body.screenshot).toBe(Buffer.from("run-png").toString("base64"));

    const shot = await call({ action: "screenshot", sessionId: launched.body.sessionId, codingRunId: RUN, describe: true });
    expect(shot.status).toBe(200);
    expect(shot.body.url).toBe("http://127.0.0.1:3000/");
    expect(shot.body.description).toBe("The run's own page.");

    expectRaisedBeforeEveryShot();
    expectForeignUntouched();
  });
});

describe("a run tab that is gone", () => {
  it("answers 410 and drops the session instead of capturing what is in front", async () => {
    const launched = await call({ action: "launch", codingRunId: RUN, url: "http://127.0.0.1:3000/" });
    expect(launched.status).toBe(200);
    mocks.runPage.screenshot.mockClear();

    // The owner closed the run's tab; their own is the one in front now.
    mocks.runPage.isClosed.mockReturnValue(true);
    const gone = await call({ action: "screenshot", sessionId: launched.body.sessionId, codingRunId: RUN, describe: true });
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("Browser tab was closed");
    expect(mocks.runPage.screenshot).not.toHaveBeenCalled();
    expect(mocks.describeImage).not.toHaveBeenCalled();

    // Dropped: the id names nothing any more.
    const again = await call({ action: "screenshot", sessionId: launched.body.sessionId, codingRunId: RUN });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("No active browser session");
    expectForeignUntouched();
  });

  it("answers 410 for a tab that closed while the launch was loading it", async () => {
    // A page that calls window.close() on load.
    mocks.runPage.goto.mockImplementationOnce(async () => {
      mocks.runPage.isClosed.mockReturnValue(true);
    });
    const launched = await call({ action: "launch", codingRunId: RUN, url: "http://127.0.0.1:3000/" });
    expect(launched.status).toBe(410);
    expect(launched.body.error).toBe("Browser tab was closed");
    expect(mocks.runPage.screenshot).not.toHaveBeenCalled();
    expectForeignUntouched();
  });
});

describe("who may drive a session", () => {
  it("refuses a run's request on a session launched without its id, even one tagged with that run", async () => {
    // The assistant's launch while RUN is live: tagged with RUN (so it closes
    // when the run settles), but not opened by the run's own tools.
    const tagged = await call({ action: "launch" });
    expect(tagged.status).toBe(200);
    const refused = await call({ action: "screenshot", sessionId: tagged.body.sessionId, codingRunId: RUN });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Browser session belongs to another run");
  });

  it("refuses one run the session another run launched, and lets the launching run in", async () => {
    const mine = await call({ action: "launch", codingRunId: RUN });
    expect((await call({ action: "screenshot", sessionId: mine.body.sessionId, codingRunId: OTHER_RUN })).status).toBe(403);
    expect((await call({ action: "screenshot", sessionId: mine.body.sessionId, codingRunId: RUN })).status).toBe(200);
  });
});
