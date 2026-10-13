import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/desktop/chrome — the desktop's Google Chrome icon. The lib is
 * mocked; what this pins is the HTTP boundary: the GET is a plain 200 either
 * way, and the POST re-checks the owner's cookie AND our own origin before the
 * lib is ever called (nobody else may start a browser on the owner's screen).
 */

const h = vi.hoisted(() => ({ ownerSession: true, sameOrigin: true, available: true, calls: [] as unknown[] }));

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => h.ownerSession) }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn(() => h.sameOrigin) }));
vi.mock("@/lib/desktop-chrome", () => ({
  desktopChromeStatus: vi.fn(() => ({ available: h.available })),
  launchDesktopChrome: vi.fn(async (url: unknown) => {
    h.calls.push(url);
    if (!h.available) return { ok: false, available: false };
    if (url === "https://example.com/fail") {
      return { ok: false, available: true, error: "Google Chrome could not be started: ENOENT", code: "launch_failed" };
    }
    if (url !== undefined && (typeof url !== "string" || !/^https?:/.test(url))) {
      return { ok: false, available: true, error: "Only http(s) pages can be opened", code: "invalid_url" };
    }
    return { ok: true, available: true, survivesRestart: true };
  }),
}));

import { GET, POST } from "@/app/setup-api/desktop/chrome/route";

function post(body?: string): Request {
  return new Request("http://localhost/setup-api/desktop/chrome", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

beforeEach(() => {
  h.ownerSession = true;
  h.sameOrigin = true;
  h.available = true;
  h.calls.length = 0;
});

describe("GET /setup-api/desktop/chrome", () => {
  it("answers availability with a 200 either way", async () => {
    expect(await (await GET()).json()).toEqual({ available: true });
    h.available = false;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });
});

describe("POST /setup-api/desktop/chrome", () => {
  it("opens Chrome for the owner's own page, with or without a body", async () => {
    expect((await POST(post())).status).toBe(200);
    expect((await POST(post(JSON.stringify({ url: "https://example.com/" })))).status).toBe(200);
    expect(h.calls).toEqual([undefined, "https://example.com/"]);
  });

  it("refuses anyone but the owner, and a cross-site page, before the lib is called", async () => {
    h.ownerSession = false;
    expect((await POST(post())).status).toBe(403);
    h.ownerSession = true;
    h.sameOrigin = false;
    expect((await POST(post())).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it("is a 503 where there is no session, and a 400 for a bad body or page", async () => {
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post(JSON.stringify({ url: "file:///etc/passwd" })))).status).toBe(400);
    h.available = false;
    const res = await POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ available: false, ok: false });
  });

  it("is a 500, never a 200, when Chrome could not be started", async () => {
    const r = await POST(post(JSON.stringify({ url: "https://example.com/fail" })));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ ok: false, available: true, code: "launch_failed" });
  });
});
