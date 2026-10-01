// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  KIOSK_POLL_MS,
  KIOSK_RECHECK_MS,
  KIOSK_TABS_CHANGED_EVENT,
  KIOSK_TABS_URL,
  fetchKioskTabs,
  inKiosk,
  openInKiosk,
  useKioskTabs,
} from "@/lib/kiosk-tabs-client";
import { KIOSK_BAR_VAR } from "@/lib/kiosk-bar-inset";

/**
 * The desktop's half of the kiosk tab feature: the tab-list poll, and
 * `openInKiosk`, which every "open an external page" click goes through.
 * Whether a page IS the kiosk is the page's own fact — the kiosk extension's
 * bar on it (`KIOSK_BAR_VAR` on <html>) — never the server's. The contract
 * that matters most is the one for every page WITHOUT that bar — every
 * Jetson, a phone, a browser over the LAN — where the behaviour has to be
 * exactly the `window.open` it replaced, in the same tick as the click.
 */

const onKiosk = (yes: boolean) => {
  if (yes) document.documentElement.style.setProperty(KIOSK_BAR_VAR, "40px");
  else document.documentElement.style.removeProperty(KIOSK_BAR_VAR);
};

type Req = { url: string; method: string; body: unknown };
const reqs: Req[] = [];
let listAnswer: () => Response | Promise<Response>;
let postStatus = 200;

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const TABS = [
  { id: "D", title: "ClawBox", url: "http://localhost:3005/", favicon: "", isDesktop: true },
  { id: "S", title: "Sign in", url: "https://claude.ai/", favicon: "https://claude.ai/f.ico", isDesktop: false },
];

beforeEach(() => {
  reqs.length = 0;
  onKiosk(false);
  listAnswer = () => ok({ available: true, tabs: TABS });
  postStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    reqs.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (method === "POST") return ok({ ok: postStatus === 200, available: postStatus !== 503 }, postStatus);
    return listAnswer();
  }));
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("fetchKioskTabs", () => {
  it("reads the list", async () => {
    const r = await fetchKioskTabs();
    expect(reqs[0]).toMatchObject({ url: KIOSK_TABS_URL, method: "GET" });
    expect(r.available).toBe(true);
    expect(r.tabs).toEqual(TABS);
  });

  it("is 'no kiosk' on available:false, a non-2xx, a bad body and a network failure — never a throw", async () => {
    listAnswer = () => ok({ available: false, tabs: [] });
    expect(await fetchKioskTabs()).toEqual({ available: false, tabs: [] });
    listAnswer = () => new Response("nope", { status: 500 });
    expect(await fetchKioskTabs()).toEqual({ available: false, tabs: [] });
    listAnswer = () => ok({ available: true, tabs: "not a list" });
    expect(await fetchKioskTabs()).toEqual({ available: false, tabs: [] });
    listAnswer = () => { throw new TypeError("fetch failed"); };
    expect(await fetchKioskTabs()).toEqual({ available: false, tabs: [] });
  });

  it("drops a tab record it cannot read and defaults the optional fields", async () => {
    listAnswer = () => ok({ available: true, tabs: [{ id: "X", url: "https://x/" }, { id: 5, url: "https://y/" }, null] });
    const r = await fetchKioskTabs();
    expect(r.tabs).toEqual([{ id: "X", url: "https://x/", title: "", favicon: "", isDesktop: false }]);
  });
});

describe("openInKiosk", () => {
  it("is window.open, synchronously and with the caller's features, on a page without the kiosk bar", () => {
    expect(inKiosk()).toBe(false);
    openInKiosk("https://claude.ai/oauth");
    openInKiosk("/app/vnc", "");
    expect(window.open).toHaveBeenNthCalledWith(1, "https://claude.ai/oauth", "_blank", "noopener,noreferrer");
    expect(window.open).toHaveBeenNthCalledWith(2, "/app/vnc", "_blank", "");
    expect(reqs).toHaveLength(0);
  });

  it("asks the server nothing there even when the server HAS a kiosk (a phone or LAN browser on the kiosk box)", async () => {
    await fetchKioskTabs(); // the server answers available:true
    reqs.length = 0;
    openInKiosk("https://claude.ai/oauth");
    await flush();
    expect(window.open).toHaveBeenCalled();
    expect(reqs).toHaveLength(0);
  });

  it("POSTs open to the kiosk API on the kiosk, resolving a relative URL against this page, and tells the taskbar", async () => {
    onKiosk(true);
    const changed = vi.fn();
    window.addEventListener(KIOSK_TABS_CHANGED_EVENT, changed);
    openInKiosk("/app/vnc", "");
    openInKiosk("https://claude.ai/oauth");
    await flush();
    const posts = reqs.filter((r) => r.method === "POST");
    expect(posts.map((p) => p.body)).toEqual([
      { action: "open", url: `${window.location.origin}/app/vnc` },
      { action: "open", url: "https://claude.ai/oauth" },
    ]);
    expect(window.open).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(2);
    window.removeEventListener(KIOSK_TABS_CHANGED_EVENT, changed);
  });

  it("falls back to window.open when the kiosk could not do it: its port dark, or Chrome refusing", async () => {
    onKiosk(true);
    for (const status of [503, 502]) {
      postStatus = status;
      openInKiosk("https://claude.ai/oauth");
      await flush();
      expect(window.open, String(status)).toHaveBeenLastCalledWith("https://claude.ai/oauth", "_blank", "noopener,noreferrer");
    }
    expect(window.open).toHaveBeenCalledTimes(2);
  });

  it("falls back when the request never got an answer", async () => {
    onKiosk(true);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    openInKiosk("https://claude.ai/oauth");
    await flush();
    expect(window.open).toHaveBeenCalledWith("https://claude.ai/oauth", "_blank", "noopener,noreferrer");
  });

  it("opens nothing when the box refused the request itself — going round it would do what it refused", async () => {
    onKiosk(true);
    const changed = vi.fn();
    window.addEventListener(KIOSK_TABS_CHANGED_EVENT, changed);
    for (const status of [400, 403]) {
      postStatus = status;
      openInKiosk("https://claude.ai/oauth");
      await flush();
    }
    expect(reqs.filter((r) => r.method === "POST")).toHaveLength(2);
    expect(window.open).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener(KIOSK_TABS_CHANGED_EVENT, changed);
  });
});

describe("useKioskTabs", () => {
  it("asks nothing while disabled (another user's desktop)", async () => {
    renderHook(() => useKioskTabs(false));
    await flush();
    expect(reqs).toHaveLength(0);
  });

  it("polls every two seconds while a kiosk answers, and hands the list out", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useKioskTabs(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.available).toBe(true);
    expect(result.current.tabs).toEqual(TABS);
    expect(reqs).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(KIOSK_POLL_MS); });
    expect(reqs).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(KIOSK_POLL_MS); });
    expect(reqs).toHaveLength(3);
  });

  it("backs off to the slow re-check on a box with no kiosk, and renders nothing", async () => {
    vi.useFakeTimers();
    listAnswer = () => ok({ available: false, tabs: [] });
    const { result } = renderHook(() => useKioskTabs(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toMatchObject({ available: false, tabs: [] });
    expect(reqs).toHaveLength(1);

    // Not at the fast rate…
    await act(async () => { await vi.advanceTimersByTimeAsync(KIOSK_RECHECK_MS - 1); });
    expect(reqs).toHaveLength(1);
    // …but it IS asked again: the kiosk Chrome is restarted by its launcher
    // after a crash and the port is dark for those seconds.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(reqs).toHaveLength(2);
  });

  it("activate and close POST the command and re-read the list at once", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useKioskTabs(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await act(async () => { result.current.activate("S"); await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { result.current.close("S"); await vi.advanceTimersByTimeAsync(200); });

    const posts = reqs.filter((r) => r.method === "POST").map((r) => r.body);
    expect(posts).toEqual([{ action: "activate", id: "S" }, { action: "close", id: "S" }]);
    // One list read at mount, one after each command — none of them waited for the 2 s tick.
    expect(reqs.filter((r) => r.method === "GET")).toHaveLength(3);
  });

  it("re-reads at once when a page was opened through the kiosk", async () => {
    vi.useFakeTimers();
    renderHook(() => useKioskTabs(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { window.dispatchEvent(new Event(KIOSK_TABS_CHANGED_EVENT)); await vi.advanceTimersByTimeAsync(200); });
    expect(reqs.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  it("does not re-render for a title or favicon change — the desktop draws neither", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useKioskTabs(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const first = result.current.tabs;
    listAnswer = () => ok({ available: true, tabs: TABS.map((t) => ({ ...t, title: `(3) ${t.title}`, favicon: "https://x/f.ico" })) });
    await act(async () => { await vi.advanceTimersByTimeAsync(KIOSK_POLL_MS); });
    expect(reqs).toHaveLength(2);
    expect(result.current.tabs).toBe(first);
  });

  it("stops polling on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useKioskTabs(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(KIOSK_POLL_MS * 3); });
    expect(reqs).toHaveLength(1);
  });
});
