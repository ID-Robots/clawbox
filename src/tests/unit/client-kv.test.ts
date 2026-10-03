// @vitest-environment jsdom
//
// The browser half of the KV store (src/lib/client-kv.ts): writes are cached at
// once and reach the device in one POST at most half a second later — and,
// since the desktop performance pass, also when the page goes away. The 500 ms
// timer never fires after a reload has begun, so the last half-second of
// writes (the mascot's resting place among them) used to be lost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ClientKv = typeof import("@/lib/client-kv");

const fetchMock = vi.fn();

interface Sent {
  body: Record<string, unknown>;
  keepalive: boolean;
}

function sent(): Sent[] {
  return fetchMock.mock.calls.map(([, init]) => ({
    body: JSON.parse(String((init as RequestInit).body)),
    keepalive: (init as RequestInit).keepalive === true,
  }));
}

/** A fresh module: its queue, its timer and its page listeners are its own. */
async function load(): Promise<ClientKv> {
  vi.resetModules();
  return import("@/lib/client-kv");
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}")));
  vi.stubGlobal("fetch", fetchMock);
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility("visible");
});

describe("client-kv writes", () => {
  it("sends a key once, half a second after it was first set, with its latest value", async () => {
    const kv = await load();
    kv.set("a", "1");
    vi.advanceTimersByTime(100);
    kv.set("a", "2");
    kv.set("b", "x");
    expect(kv.get("a")).toBe("2");

    vi.advanceTimersByTime(399);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sent()).toEqual([{ body: { entries: { a: "2", b: "x" } }, keepalive: false }]);

    // Nothing waiting, nothing sent.
    vi.advanceTimersByTime(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends what is waiting at once when the page goes away, as requests that outlive it", async () => {
    const kv = await load();
    kv.set("clawbox-crab-pos", '{"x":42}');
    kv.remove("gone");
    window.dispatchEvent(new Event("pagehide"));

    expect(sent()).toEqual([
      { body: { entries: { "clawbox-crab-pos": '{"x":42}' } }, keepalive: true },
      { body: { delete: "gone" }, keepalive: true },
    ]);
    // The timer went with it: nothing is sent twice.
    vi.advanceTimersByTime(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends what is waiting when the page turns hidden, and nothing when it turns visible", async () => {
    const kv = await load();
    kv.set("a", "1");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchMock).not.toHaveBeenCalled();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sent()).toEqual([{ body: { entries: { a: "1" } }, keepalive: true }]);
  });

  it("sends nothing on the way out when nothing is waiting", async () => {
    const kv = await load();
    kv.set("a", "1");
    vi.advanceTimersByTime(500);
    fetchMock.mockClear();

    window.dispatchEvent(new Event("pagehide"));
    kv.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a refused keepalive request again as an ordinary one", async () => {
    // The browser's keepalive budget is shared with the desktop's own state
    // save; past it the request is refused before it leaves. The page that only
    // turned hidden is still alive — the write must not be lost to the budget.
    const kv = await load();
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    kv.set("a", "1");
    kv.flush();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent()).toEqual([
      { body: { entries: { a: "1" } }, keepalive: true },
      { body: { entries: { a: "1" } }, keepalive: false },
    ]);
  });

  it("sends a body past the keepalive budget as an ordinary request", async () => {
    const kv = await load();
    kv.set("big", "x".repeat(70_000));
    kv.flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].keepalive).toBe(false);
  });
});
