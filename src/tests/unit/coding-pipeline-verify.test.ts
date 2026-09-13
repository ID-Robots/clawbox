/**
 * The looking: what the pipeline does instead of believing "the API said ready".
 *
 * The rule the whole feature turns on is that a pipeline is `complete` only
 * when THIS box fetched the deployed page and found what was asked for on it.
 * So these cases are about the ways that can go wrong and must not read as a
 * pass: a page that 500s, a page that is up and is the old version, and — the
 * one a careless implementation gets wrong — a check this box could not make
 * at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const describeImage = vi.hoisted(() => vi.fn(async () => ({ text: null as string | null, error: "no model" as string | null })));
vi.mock("@/lib/vision-describe", () => ({ describeImage }));

/** No Chromium by default: most of these cases are about the fetch. */
const findPlaywrightChromium = vi.hoisted(() => vi.fn<() => string | null>(() => null));
vi.mock("@/lib/cdp-probe", () => ({ findPlaywrightChromium }));

/**
 * A Chromium stand-in that keeps the handler `page.route` was given, so the
 * guard around what the RENDERER may reach can be driven directly. Launching a
 * real browser in a unit suite is neither available on CI nor the subject.
 */
const routeHandler = vi.hoisted(() => ({ current: null as ((route: unknown) => Promise<void>) | null }));
const gotoCalls = vi.hoisted(() => ({ urls: [] as string[], states: [] as string[], waitUntil: "" }));
const pageOptions = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      newPage: async (options: Record<string, unknown>) => ({
        __options: (pageOptions.last = options),
        route: async (_glob: string, handler: (route: unknown) => Promise<void>) => { routeHandler.current = handler; },
        goto: async (url: string, options: Record<string, unknown>) => {
          gotoCalls.urls.push(url);
          gotoCalls.waitUntil = options?.waitUntil as string;
        },
        waitForLoadState: async (state: string) => { gotoCalls.states.push(state); },
        screenshot: async () => Buffer.from("not-really-a-png"),
      }),
      close: async () => {},
    }),
  },
}));

/** Every address in this suite is public; the private-host rail has its own suite. */
const hostIsPublic = vi.hoisted(() => vi.fn<(host: string) => Promise<boolean>>(async () => true));
vi.mock("@/lib/private-address", () => ({ hostIsPublic, isPrivateIp: () => false, lookupWithTimeout: async () => [] }));

type Lib = typeof import("@/lib/coding-pipeline-verify");
let lib: Lib;
let base: string;
let restore: () => void;

function answer(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-verify-"));
  process.env.HOME = path.join(base, "home");
  process.env.CLAWBOX_ROOT = path.join(base, "home", "clawbox");
  fs.mkdirSync(path.join(base, "home", "clawbox", "data"), { recursive: true });
  describeImage.mockReset();
  describeImage.mockResolvedValue({ text: null, error: "no model" });
  findPlaywrightChromium.mockReset();
  findPlaywrightChromium.mockReturnValue(null);
  routeHandler.current = null;
  gotoCalls.urls = [];
  gotoCalls.states = [];
  gotoCalls.waitUntil = "";
  pageOptions.last = null;
  hostIsPublic.mockReset();
  hostIsPublic.mockResolvedValue(true);
  vi.resetModules();
  lib = await import("@/lib/coding-pipeline-verify");
});

afterEach(() => {
  vi.unstubAllGlobals();
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the address it checks", () => {
  it("puts the path on the deployment's ORIGIN, never relative to it", () => {
    expect(lib.verificationUrl("https://x-abc.vercel.app/some/where", "/invoices"))
      .toEqual({ ok: true, url: "https://x-abc.vercel.app/invoices" });
  });

  it("refuses an address with credentials in it", () => {
    const out = lib.verificationUrl("https://user:pw@x.vercel.app", "/");
    expect(out.ok).toBe(false);
  });

  it("refuses a path that is an address of its own", () => {
    // `//other.example/` starts with a slash and IS a whole origin once
    // resolved, so a verification would have judged the owner's deployment on
    // somebody else's site.
    const out = lib.verificationUrl("https://x.vercel.app", "//other.example/");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("address of its own");
  });

  it("refuses a scheme that is not the web", () => {
    expect(lib.verificationUrl("file:///etc/shadow", "/").ok).toBe(false);
    expect(lib.verificationUrl("not a url", "/").ok).toBe(false);
  });

  it("will not fetch an address that is not public, whatever Vercel answered", async () => {
    hostIsPublic.mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://internal.example/", path: "/", expect: [], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("not a public one");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("redirects", () => {
  function redirect(to: string, status = 302): Response {
    return new Response(null, { status, headers: { location: to } });
  }

  it("follows one to a public address and checks the page it lands on", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect("https://x.vercel.app/invoices/"))
      .mockResolvedValueOnce(answer("<h1>Invoice</h1>"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/invoices", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://x.vercel.app/invoices/");
  });

  it("STOPS at one pointing inside this network, and never fetches it", async () => {
    // The whole reason redirects are walked by hand: `redirect: "follow"` would
    // have had this box fetch a metadata service, photograph it, and send the
    // picture to a vision model.
    hostIsPublic.mockImplementation(async (host: string) => host.endsWith(".vercel.app"));
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect("http://169.254.169.254/latest/meta-data/"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("inside this network");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(findPlaywrightChromium).not.toHaveBeenCalled();
  });

  it("refuses a redirect off the web entirely", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(redirect("file:///etc/shadow")));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("file:");
  });

  it("refuses a redirect that names nowhere", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 302 })));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("without saying where to go");
  });

  it("gives up on a chain rather than walking it for ever", async () => {
    const fetchMock = vi.fn(async () => redirect("https://x.vercel.app/next"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("redirected more than");
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(lib.VERIFY_MAX_REDIRECTS + 1);
  });
});

describe("a deployment nobody may look at", () => {
  function redirect(to: string, status = 307): Response {
    return new Response(null, { status, headers: { location: to } });
  }

  it("reads Vercel's own login wall as BLOCKED rather than as work that is wrong", async () => {
    // Deployment Protection is on by default for team accounts: every
    // deployment URL redirects to vercel.com/login and answers 200 with a
    // complete HTML page. Judged as "the page does not show what was asked
    // for", that spends the owner's improvement rounds asking a coding harness
    // to change a setting in their Vercel account.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect("https://vercel.com/login?next=%2Fsso"))
      .mockResolvedValueOnce(answer("<h1>Log in to Vercel</h1>"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x-abc.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.blocked).toBe(true);
    expect(out.reason).toContain("Deployment Protection");
    // And the expectations are never even consulted: the page was not shown.
    expect(out.expectations).toEqual([]);
  });

  it("leaves a redirect to the project's OWN other origin alone", async () => {
    // A deployment that sends its visitors to its custom domain is an ordinary
    // deployment, not a wall, and must still be checked on its merits.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect("https://shop.example.com/"))
      .mockResolvedValueOnce(answer("<h1>Invoice</h1>"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x-abc.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(true);
    expect(out.blocked).toBeFalsy();
  });

  it("names the wall only for the sign-in gate, on an address that LEFT the deployment", () => {
    // `blocked` ends a pipeline, so it is the one verdict that must not be
    // reached by resemblance: both halves have to hold.
    expect(lib.protectionWall("https://x.vercel.app/", "https://vercel.com/login?next=%2Fsso")).toContain("Deployment Protection");
    expect(lib.protectionWall("https://x.vercel.app/", "https://vercel.com/sso-api?url=x")).toContain("Deployment Protection");
    expect(lib.protectionWall("https://x.vercel.app/", "https://www.vercel.com/login/sso")).toContain("Deployment Protection");
    // The deployment's own origin is not a redirect away from it.
    expect(lib.protectionWall("https://x.vercel.app/", "https://x.vercel.app/login")).toBeNull();
    // Somewhere else on vercel.com that is not the gate: fetched and judged on
    // its merits like any other destination.
    expect(lib.protectionWall("https://x.vercel.app/", "https://api.vercel.com/x")).toBeNull();
    expect(lib.protectionWall("https://x.vercel.app/", "https://vercel.com/docs")).toBeNull();
    expect(lib.protectionWall("https://x.vercel.app/", "https://vercel.com/logins-are-fun")).toBeNull();
    // Not a Vercel host merely because the string is in it.
    expect(lib.protectionWall("https://x.vercel.app/", "https://vercel.com.evil.example/login")).toBeNull();
    expect(lib.protectionWall("nonsense", "https://vercel.com/login")).toBeNull();
  });

  it("still checks a page that merely redirected somewhere on vercel.com", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(redirect("https://vercel.com/docs"))
      .mockResolvedValueOnce(answer("<h1>Invoice</h1>"));
    vi.stubGlobal("fetch", fetchMock);
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x-abc.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.blocked).toBeFalsy();
    expect(out.ok).toBe(true);
  });
});

describe("the hard gates", () => {
  it("a non-2xx is a failure naming the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("nope", 500)));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(500);
    expect(out.reason).toContain("answered 500");
  });

  it("an empty body is a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("   ")));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("empty body");
  });

  it("a transport failure is a failure, not a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: [], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("ECONNREFUSED");
  });
});

describe("what the caller said the page must contain", () => {
  it("passes when every string is there, and says it judged by them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("<h1>Invoice</h1><p>Total: 12</p>")));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice", "Total"], task: "t",
    });
    expect(out.ok).toBe(true);
    expect(out.judgedBy).toBe("expectations");
    expect(out.expectations).toEqual([{ text: "Invoice", found: true }, { text: "Total", found: true }]);
    // Never asked: the literal strings are the strong answer and a model's
    // opinion beside them would only muddle the claim.
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("is case-insensitive, because markup is not the owner's spelling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("<h1>INVOICE</h1>")));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(true);
  });

  it("a page that is UP and missing one of them fails, naming it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("<h1>Hello</h1>")));
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(200);
    expect(out.reason).toContain("\"Invoice\"");
    expect(out.expectations).toEqual([{ text: "Invoice", found: false }]);
  });
});

describe("when nothing literal was named", () => {
  it("a check this box could not make is NEVER a pass", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer("<h1>Something</h1>")));
    // No Chromium, so no screenshot, so nothing to judge.
    const out = await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: [], task: "make an invoice page",
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(200);
    expect(out.reason).toContain("could not check");
    expect(out.reason).toContain("Name what to look for");
    expect(out.judgedBy).toBe("none");
  });
});

describe("the vision verdict", () => {
  it("reads YES and NO off the FIRST line, which is what the prompt asked for", () => {
    expect(lib.readVerdict("YES — the invoice table is there.")).toBe("yes");
    expect(lib.readVerdict("No. The page is blank.")).toBe("no");
    expect(lib.readVerdict("\n\n**YES**\nthe table renders")).toBe("yes");
    expect(lib.readVerdict("- no, it is the old version")).toBe("no");
    expect(lib.readVerdict("It is hard to say.")).toBe("unknown");
    expect(lib.readVerdict(null)).toBe("unknown");
  });

  it("does not take a refusal to answer as a YES", () => {
    // Searching the whole answer found "YES" in the first sentence and passed a
    // deployment the model had just said it could not judge.
    expect(lib.readVerdict("I cannot choose YES or NO.\nNO")).toBe("unknown");
    expect(lib.readVerdict("The question is whether it is YES.\nNO — it is blank.")).toBe("unknown");
  });

  it("asks about the TASK, and tells the model to answer NO only when it plainly is not it", () => {
    const prompt = lib.judgementPrompt("Build an invoice generator with a totals column");
    expect(prompt).toContain("invoice generator");
    expect(prompt).toContain("YES or NO on the first line");
    expect(prompt).toContain("Answer NO only if");
  });
});

describe("the summary a stage records", () => {
  it("says which of the two claims was actually established", () => {
    expect(lib.verificationSummary({
      ok: true, url: "https://x/", status: 200, reason: null, judgedBy: "expectations",
      expectations: [{ text: "a", found: true }], vision: null, screenshot: null, checkedAt: 0,
    })).toContain("contains 1 of 1");
    expect(lib.verificationSummary({
      ok: true, url: "https://x/", status: 200, reason: null, judgedBy: "vision",
      expectations: [], vision: { verdict: "yes", description: "d", error: null }, screenshot: "s.png", checkedAt: 0,
    })).toContain("screenshot shows");
    expect(lib.verificationSummary({
      ok: false, url: "https://x/", status: 500, reason: "it answered 500", judgedBy: "none",
      expectations: [], vision: null, screenshot: null, checkedAt: 0,
    })).toBe("it answered 500");
  });
});


describe("what the RENDERER may reach", () => {
  /** One request as Playwright hands it to a route handler. */
  function requestFor(url: string, navigation: boolean) {
    const verdict = { continued: false, aborted: false };
    const route = {
      request: () => ({ url: () => url, isNavigationRequest: () => navigation }),
      continue: async () => { verdict.continued = true; },
      abort: async () => { verdict.aborted = true; },
    };
    return { route, verdict };
  }

  async function guard(): Promise<(url: string, navigation: boolean) => Promise<{ continued: boolean; aborted: boolean }>> {
    findPlaywrightChromium.mockReturnValue("/opt/chromium");
    hostIsPublic.mockImplementation(async (host: string) => host.endsWith(".vercel.app"));
    vi.stubGlobal("fetch", vi.fn(async () => answer("<h1>Invoice</h1>")));
    await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    const handler = routeHandler.current;
    expect(handler).toBeTruthy();
    return async (url, navigation) => {
      const { route, verdict } = requestFor(url, navigation);
      await handler!(route);
      return verdict;
    };
  }

  it("checks EVERY request, not only navigations", async () => {
    const ask = await guard();
    // The page being rendered is somebody else's: an image, a stylesheet or a
    // `fetch()` in its own script reaches an internal service exactly as a
    // redirect would, and lands in the screenshot sent to a vision model.
    expect(await ask("http://169.254.169.254/latest/meta-data/", false)).toMatchObject({ aborted: true });
    expect(await ask("http://127.0.0.1:18789/", false)).toMatchObject({ aborted: true });
    expect(await ask("https://other.internal/style.css", false)).toMatchObject({ aborted: true });
    expect(await ask("https://x.vercel.app/style.css", false)).toMatchObject({ continued: true });
  });

  it("stops a navigation to an address inside this network", async () => {
    const ask = await guard();
    expect(await ask("http://10.0.0.5/", true)).toMatchObject({ aborted: true });
    expect(await ask("https://x.vercel.app/next", true)).toMatchObject({ continued: true });
  });

  it("refuses a scheme or an address a renderer has no business reaching", async () => {
    const ask = await guard();
    expect(await ask("file:///etc/shadow", false)).toMatchObject({ aborted: true });
    expect(await ask("data:text/html,<script>", false)).toMatchObject({ aborted: true });
    expect(await ask("https://user:pw@x.vercel.app/", false)).toMatchObject({ aborted: true });
    expect(await ask("not a url", false)).toMatchObject({ aborted: true });
  });

  it("asks once per ORIGIN for assets, so a page of sixty is not sixty lookups", async () => {
    const ask = await guard();
    const before = hostIsPublic.mock.calls.length;
    for (let i = 0; i < 10; i += 1) await ask(`https://x.vercel.app/asset-${i}.css`, false);
    expect(hostIsPublic.mock.calls.length - before).toBe(1);
    // …and never from that cache for a NAVIGATION, whose destination is the
    // whole point of the question.
    await ask("https://x.vercel.app/elsewhere", true);
    expect(hostIsPublic.mock.calls.length - before).toBe(2);
  });

  it("blocks Service Workers, which `page.route` cannot see inside", async () => {
    // A deployment that registered one could fetch a private address from
    // inside it and never touch the handler above.
    await guard();
    expect(pageOptions.last).toMatchObject({ serviceWorkers: "block" });
  });

  it("waits for a single-page app to draw itself before photographing it", async () => {
    // A picture taken at DOMContentLoaded is a blank page for anything that
    // renders from its own script — which the vision model would honestly judge
    // as "not what was asked for", spending the owner's improvement rounds on
    // working code.
    await guard();
    expect(gotoCalls.waitUntil).toBe("load");
    expect(gotoCalls.states).toContain("networkidle");
  });

  it("photographs the address the fetch SETTLED on, not the one it started from", async () => {
    findPlaywrightChromium.mockReturnValue("/opt/chromium");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://x.vercel.app/final/" } }))
      .mockResolvedValueOnce(answer("<h1>Invoice</h1>")));
    await lib.verifyDeployment({
      runId: "run-abcd1234", deploymentUrl: "https://x.vercel.app", path: "/", expect: ["Invoice"], task: "t",
    });
    expect(gotoCalls.urls).toEqual(["https://x.vercel.app/final/"]);
  });
});
