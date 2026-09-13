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

/** Every address in this suite is public; the private-host rail has its own suite. */
const hostIsPublic = vi.hoisted(() => vi.fn(async () => true));
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
  it("reads YES and NO off the first word and ignores the rest", () => {
    expect(lib.readVerdict("YES — the invoice table is there.")).toBe("yes");
    expect(lib.readVerdict("No. The page is blank.")).toBe("no");
    expect(lib.readVerdict("It is hard to say.")).toBe("unknown");
    expect(lib.readVerdict(null)).toBe("unknown");
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
