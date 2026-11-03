import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@/tests/helpers/test-utils";
import { useSessionExpiryGuard } from "@/hooks/useSessionExpiryGuard";
import { SESSION_EXPIRED_EVENT, SESSION_PROBE_URL, sessionExpiredHeaders } from "@/lib/session-expiry";

/**
 * A page that wakes into a lapsed session (TASK-2131).
 *
 * The guard asked about the session when the tab was shown again. A phone
 * shows it before its Wi-Fi is back, so that question could not reach the box —
 * which counts as "still signed in" — and a chat page whose socket died with
 * the network sat on its error with nothing left to ask. The network's return
 * asks now, and so does a page the browser restores from its back/forward
 * cache, which changes no visibility at all.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const probeCalls = () => fetchMock.mock.calls.filter(([input]) => String(input) === SESSION_PROBE_URL).length;

const realFetch = globalThis.fetch;
let expiredEvents = 0;
const onExpired = () => { expiredEvents += 1; };
let replace: ReturnType<typeof vi.fn>;
let savedLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  savedLocation = Object.getOwnPropertyDescriptor(window, "location");
  const real = window.location;
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: real.href, origin: real.origin, pathname: "/app/clawbox", search: "", hash: "", assign: vi.fn(), reload: vi.fn(), replace },
  });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Authentication required" }), {
    status: 401,
    headers: sessionExpiredHeaders(),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  expiredEvents = 0;
  window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedLocation) Object.defineProperty(window, "location", savedLocation);
  window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  cleanup();
  vi.restoreAllMocks();
});

describe("useSessionExpiryGuard on a page that wakes", () => {
  it("asks about the session when the network comes back, and signs out on the refusal", async () => {
    renderHook(() => useSessionExpiryGuard());
    expect(probeCalls()).toBe(0);
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fclawbox"));
    expect(expiredEvents).toBe(1);
    expect(probeCalls()).toBe(1);
  });

  it("asks when the page is restored from the back/forward cache, but not on its first show", async () => {
    renderHook(() => useSessionExpiryGuard());
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(probeCalls()).toBe(0);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fclawbox"));
  });

  it("stops listening once the page is gone", async () => {
    const { unmount } = renderHook(() => useSessionExpiryGuard());
    unmount();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(probeCalls()).toBe(0);
  });
});
