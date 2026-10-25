import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_EXPIRED_CLOSE_CODE,
  SESSION_EXPIRED_EVENT,
  SESSION_EXPIRED_HEADER,
  SESSION_PROBE_TIMEOUT_MS,
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

/** Let the guard's probe settle. */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("installSessionExpiryGuard", () => {
  it("on the session gate's 401 to any request, asks about the current session and signs out when that is refused too", async () => {
    const { win, replace } = fakeWindow();
    const original = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => gate401());
    win.fetch = original as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);

    const res = await win.fetch("/setup-api/files?dir=%7E");
    expect(res.status).toBe(401);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2F"));
    // The probe went out through the unguarded fetch, once.
    expect(original.mock.calls.map(([input]) => String(input))).toEqual(["/setup-api/files?dir=%7E", SESSION_PROBE_URL]);
  });

  it("leaves the page alone on a late 401 for a session it has already replaced", async () => {
    // A request that left before a sign-in in another tab comes back refused;
    // the cookie the page holds now is good.
    const { win, replace, order } = fakeWindow();
    win.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === SESSION_PROBE_URL ? new Response("{}", { status: 200 }) : gate401(),
    ) as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);

    expect((await win.fetch("/setup-api/kv?key=ui:pending-actions")).status).toBe(401);
    await flush();
    expect(replace).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it("asks once and signs out once for a burst of refusals", async () => {
    const { win, replace, order } = fakeWindow();
    const original = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => gate401());
    win.fetch = original as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);

    await Promise.all(["/setup-api/kv", "/setup-api/files", "/setup-api/chat/tabs"].map((u) => win.fetch(u)));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    await flush();
    expect(original.mock.calls.filter(([input]) => String(input) === SESSION_PROBE_URL)).toHaveLength(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["event", "replace /login?redirect=%2F"]);
  });

  it("does not judge the probe's own refusal a second time", async () => {
    // A chat asks through the page's (guarded) fetch: the guard sees the
    // probe's 401 and must join that probe, not start another.
    const { win, replace } = fakeWindow();
    const original = vi.fn(async () => gate401());
    win.fetch = original as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);
    vi.stubGlobal("fetch", win.fetch);

    await expect(confirmSessionStillValid()).resolves.toBe(false);
    await flush();
    expect(original).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("gives a refusal sent after a probe left a probe of its own, so the page still signs out", async () => {
    // The tab is shown again and asks about its session while it is still good;
    // that answer is slow. The session runs out, and a chat poll sent after the
    // probe comes back refused. Joining the older probe would take its "still
    // signed in" as the verdict on a refusal it never saw, and an idle chat
    // would then stay on the page with nothing left to refuse.
    const { win, replace } = fakeWindow();
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let answerFirstProbe: (res: Response) => void = () => {};
    let probes = 0;
    const original = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== SESSION_PROBE_URL) return gate401();
      probes += 1;
      if (probes === 1) return new Promise<Response>((resolve) => { answerFirstProbe = resolve; });
      return gate401();
    });
    win.fetch = original as unknown as typeof fetch;
    installSessionExpiryGuard(win as unknown as Window);
    try {
      const first = confirmSessionStillValid(original as unknown as typeof fetch);

      now = 2_000;
      expect((await win.fetch("/setup-api/chat/tabs")).status).toBe(401);
      await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2F"));
      expect(probes).toBe(2);

      // The first probe's late "still signed in" changes nothing.
      answerFirstProbe(new Response("{}", { status: 200 }));
      await expect(first).resolves.toBe(true);
      expect(replace).toHaveBeenCalledTimes(1);
    } finally {
      // Never leave a probe in flight for the next test to join.
      answerFirstProbe(new Response("{}", { status: 200 }));
      await flush();
      clock.mockRestore();
    }
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
    expect(probe).toHaveBeenCalledWith(SESSION_PROBE_URL, expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fterminal");
  });

  it("gives up on a probe the network never answers, and counts that as a box it cannot reach", async () => {
    // A phone that left the Wi-Fi: the request is swallowed, never refused. A
    // chat waits on this answer before it offers its error and its Retry.
    const { replace } = fakeWindow();
    vi.useFakeTimers();
    try {
      const swallowed = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      }));
      let settled = false;
      const answer = confirmSessionStillValid(swallowed as unknown as typeof fetch).then((live) => { settled = true; return live; });
      await vi.advanceTimersByTimeAsync(SESSION_PROBE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(answer).resolves.toBe(true);
      expect(replace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
