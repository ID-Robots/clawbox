import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_EXPIRED_CLOSE_CODE,
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_HEADER,
  SESSION_PROBE_URL,
  confirmSessionStillValid,
  installSessionExpiryGuard,
  isSessionExpiredClose,
  isSessionExpiredResponse,
  sessionExpiredHeaders,
  signOutExpiredSession,
  signedOutLoginPage,
} from "@/lib/session-expiry";
import { loginRedirectTarget } from "@/lib/session-switch";

// The browser's half of a lapsed session: which 401 means "signed out", where
// the page goes, and the page-wide fetch guard that sends it there.

const gate401 = () => new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: sessionExpiredHeaders() });
const wrongPassword401 = () => new Response(JSON.stringify({ error: "Incorrect password" }), { status: 401 });

/** A window with an event bus and a location that records where it was sent. */
function fakeWindow(pathname = "/") {
  const bus = new EventTarget();
  const order: string[] = [];
  const replace = vi.fn((url: string) => order.push(`replace ${url}`));
  bus.addEventListener(SESSION_EXPIRED_EVENT, () => order.push("event"));
  const win = Object.assign(bus, {
    location: { pathname, replace },
    fetch: undefined as unknown as typeof fetch,
  });
  vi.stubGlobal("window", win);
  return { win, replace, order };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSessionExpiredResponse", () => {
  it("is the session gate's marked 401", () => {
    expect(isSessionExpiredResponse(gate401())).toBe(true);
  });

  it("is never a route's own 401 — a wrong password, a refused key", () => {
    expect(isSessionExpiredResponse(wrongPassword401())).toBe(false);
  });

  it("is never another status, even carrying the mark", () => {
    expect(isSessionExpiredResponse(new Response("", { status: 403, headers: sessionExpiredHeaders() }))).toBe(false);
    expect(isSessionExpiredResponse(new Response("", { status: 200, headers: sessionExpiredHeaders() }))).toBe(false);
  });

  it("tolerates the half-shaped responses test doubles and old callers pass", () => {
    expect(isSessionExpiredResponse(null)).toBe(false);
    expect(isSessionExpiredResponse(undefined)).toBe(false);
    expect(isSessionExpiredResponse({ status: 401 })).toBe(false);
    expect(isSessionExpiredResponse({ status: 401, headers: null })).toBe(false);
  });

  it("marks the 401 uncacheable", () => {
    expect(sessionExpiredHeaders()).toMatchObject({ [SESSION_EXPIRED_HEADER]: "expired", "cache-control": "no-store" });
  });
});

describe("isSessionExpiredClose", () => {
  it("is the box's session-expired close code and nothing else", () => {
    expect(isSessionExpiredClose({ code: SESSION_EXPIRED_CLOSE_CODE })).toBe(true);
    for (const code of [1000, 1006, 1008, 1011, 4000]) expect(isSessionExpiredClose({ code })).toBe(false);
    expect(isSessionExpiredClose(undefined)).toBe(false);
  });
});

describe("signedOutLoginPage", () => {
  it("carries the path the page was on, and the login page sends the person back to it", () => {
    for (const path of ["/", "/app/openclaw", "/app/terminal"]) {
      const login = new URL(signedOutLoginPage(path), "http://clawbox.local");
      expect(login.pathname).toBe("/login");
      expect(loginRedirectTarget(login.search, "http://clawbox.local")).toBe(path);
    }
  });

  it("an empty path is the desktop", () => {
    expect(signedOutLoginPage("")).toBe("/login?redirect=%2F");
  });
});

describe("signOutExpiredSession", () => {
  it("tells the page's live connections first, then leaves for /login carrying where it was", () => {
    const { replace, order } = fakeWindow("/app/openclaw");
    signOutExpiredSession();
    expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fopenclaw");
    expect(order).toEqual(["event", "replace /login?redirect=%2Fapp%2Fopenclaw"]);
  });

  it("still leaves when telling the page fails", () => {
    const { win, replace } = fakeWindow();
    win.dispatchEvent = () => {
      throw new Error("an event bus that could not deliver");
    };
    expect(() => signOutExpiredSession()).not.toThrow();
    expect(replace).toHaveBeenCalledWith("/login?redirect=%2F");
  });
});

describe("installSessionExpiryGuard", () => {
  it("takes the page to /login on the session gate's 401 to any request, and still hands the answer back", async () => {
    const { win, replace } = fakeWindow();
    const original = vi.fn(async () => gate401());
    win.fetch = original as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);

    const res = await win.fetch("/setup-api/files?dir=%7E");
    expect(res.status).toBe(401);
    expect(original).toHaveBeenCalledWith("/setup-api/files?dir=%7E", undefined);
    expect(replace).toHaveBeenCalledWith("/login?redirect=%2F");
  });

  it("leaves the page alone on a route's own 401 and on every other answer", async () => {
    const { win, replace } = fakeWindow();
    const answers = [wrongPassword401(), new Response("{}", { status: 200 }), new Response("", { status: 403 })];
    win.fetch = vi.fn(async () => answers.shift()!) as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);
    for (let i = 0; i < 3; i++) await win.fetch("/setup-api/system/credentials");
    expect(replace).not.toHaveBeenCalled();
  });

  it("passes a failed request's error through untouched", async () => {
    const { win, replace } = fakeWindow();
    win.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);
    await expect(win.fetch("/setup-api/kv")).rejects.toThrow("Failed to fetch");
    expect(replace).not.toHaveBeenCalled();
  });

  it("puts the original fetch back, and never undoes a wrapper installed after it", () => {
    const { win } = fakeWindow();
    const original = vi.fn() as unknown as typeof fetch;
    win.fetch = original;
    const restore = installSessionExpiryGuard(win as unknown as Window);
    expect(win.fetch).not.toBe(original);
    restore();
    expect(win.fetch).toBe(original);

    const restoreAgain = installSessionExpiryGuard(win as unknown as Window);
    const later = vi.fn() as unknown as typeof fetch;
    win.fetch = later;
    restoreAgain();
    expect(win.fetch).toBe(later);
  });
});

describe("confirmSessionStillValid", () => {
  it("asks the probe route and signs out on the session gate's 401", async () => {
    const { replace } = fakeWindow("/app/terminal");
    const probe = vi.fn(async () => gate401());
    vi.stubGlobal("fetch", probe);
    await expect(confirmSessionStillValid()).resolves.toBe(false);
    expect(probe).toHaveBeenCalledWith(SESSION_PROBE_URL, { cache: "no-store" });
    expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fterminal");
  });

  it("a live session, or a box that cannot be reached, is not a sign-out", async () => {
    const { replace } = fakeWindow();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(confirmSessionStillValid()).resolves.toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(confirmSessionStillValid()).resolves.toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });
});
