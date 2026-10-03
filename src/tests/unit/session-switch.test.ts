// @vitest-environment jsdom
/**
 * One browser, one session (TASK-1247) — src/lib/session-switch.ts.
 *
 * Picking a 12-hour session on /login (or another user, or signing out) sets
 * or clears the cookie for EVERY tab of the browser, but the tabs that did not
 * do it kept the previous session's desktop and Terminal on screen until they
 * were reloaded by hand. The tab that changes the session announces it on two
 * carriers; every signed-in page follows it, live or when it is next shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  SESSION_SWITCH_CHANNEL,
  SESSION_SWITCH_EVENT,
  SESSION_SWITCH_STORAGE_KEY,
  announceSessionSwitch,
  loginRedirectTarget,
  parseSessionSwitch,
  readSessionSwitch,
  sessionSurfaceUrl,
  subscribeSessionSwitch,
  useFollowSessionSwitch,
  type SessionSwitch,
  type SessionSwitchDestination,
} from "@/lib/session-switch";
import {
  FakeBroadcastChannel,
  announceFromAnotherTab,
  channelTick,
  firePageShow,
  fireVisibility,
  installFakeBroadcastChannel,
  stubLocation,
  type StubbedLocation,
} from "@/tests/helpers/session-switch";

let location: StubbedLocation;

beforeEach(() => {
  window.localStorage.clear();
  installFakeBroadcastChannel();
  location = stubLocation("/app/terminal");
  fireVisibility("visible");
});

afterEach(() => {
  location.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("parseSessionSwitch", () => {
  it("reads the record either carrier brings", () => {
    const change = { id: "abc", kind: "login", at: 5 };
    expect(parseSessionSwitch(change)).toEqual(change);
    expect(parseSessionSwitch(JSON.stringify(change))).toEqual(change);
    expect(parseSessionSwitch({ id: "abc", kind: "logout" })).toEqual({ id: "abc", kind: "logout", at: 0 });
  });

  it("refuses anything that is not a switch", () => {
    for (const raw of [null, undefined, "", "{", "[]", 7, { kind: "login" }, { id: "", kind: "login" }, { id: "x", kind: "reboot" }]) {
      expect(parseSessionSwitch(raw)).toBeNull();
    }
  });
});

describe("sessionSurfaceUrl — where a page reopens on the new session", () => {
  it("is the page's own path and query", () => {
    expect(sessionSurfaceUrl({ pathname: "/", search: "" })).toBe("/");
    expect(sessionSurfaceUrl({ pathname: "/app/terminal", search: "" })).toBe("/app/terminal");
    expect(sessionSurfaceUrl({ pathname: "/app/settings", search: "?section=users" })).toBe("/app/settings?section=users");
  });

  it("drops the previous session's one-time notice", () => {
    expect(sessionSurfaceUrl({ pathname: "/", search: "?notice=owner-only" })).toBe("/");
    expect(sessionSurfaceUrl({ pathname: "/app/settings", search: "?section=users&notice=owner-only" })).toBe("/app/settings?section=users");
  });

  it("never leaves the origin", () => {
    expect(sessionSurfaceUrl({ pathname: "//evil.example/x", search: "" })).toBe("/");
    expect(sessionSurfaceUrl({ pathname: "", search: "" })).toBe("/");
  });
});

describe("loginRedirectTarget — where /login sends a signed-in browser", () => {
  const origin = "http://clawbox.local";

  it("is the page the middleware sent it from, or the desktop", () => {
    expect(loginRedirectTarget("", origin)).toBe("/");
    expect(loginRedirectTarget("?redirect=%2Fapp%2Fterminal", origin)).toBe("/app/terminal");
    expect(loginRedirectTarget("?redirect=%2Fapp%2Fsettings%3Fsection%3Dusers%23top", origin)).toBe("/app/settings?section=users#top");
  });

  it("refuses anywhere off this origin", () => {
    for (const hostile of ["//evil.example/x", "https://evil.example/", "javascript:alert(1)", "http://clawbox.local.evil.example/"]) {
      expect(loginRedirectTarget(`?redirect=${encodeURIComponent(hostile)}`, origin)).toBe("/");
    }
  });
});

describe("announceSessionSwitch — the tab that changed the session", () => {
  it("records the switch, posts it once, and tells its own page it is leaving", () => {
    const leaving: SessionSwitch[] = [];
    const onLeave = (e: Event) => leaving.push((e as CustomEvent<SessionSwitch>).detail);
    window.addEventListener(SESSION_SWITCH_EVENT, onLeave);
    try {
      const change = announceSessionSwitch("login");
      expect(change.kind).toBe("login");
      expect(readSessionSwitch()).toEqual(change);
      expect(FakeBroadcastChannel.posted).toEqual([{ name: SESSION_SWITCH_CHANNEL, data: change }]);
      // Its channel is closed straight away — nothing left open on a page that navigates next.
      expect(FakeBroadcastChannel.open).toHaveLength(0);
      expect(leaving).toEqual([change]);
    } finally {
      window.removeEventListener(SESSION_SWITCH_EVENT, onLeave);
    }
  });

  it("gives every switch its own id", () => {
    const a = announceSessionSwitch("logout");
    const b = announceSessionSwitch("login");
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("still reaches other tabs when storage is refused", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const change = announceSessionSwitch("login");
    expect(FakeBroadcastChannel.posted.map((p) => p.data)).toEqual([change]);
  });

  it("still reaches other tabs in a browser without BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const change = announceSessionSwitch("logout");
    expect(window.localStorage.getItem(SESSION_SWITCH_STORAGE_KEY)).toBe(JSON.stringify(change));
  });
});

describe("subscribeSessionSwitch — the tabs that did not", () => {
  it("hears a switch once, whichever carrier brings it first", async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeSessionSwitch(heard);
    const change = announceFromAnotherTab("login", "both");
    await channelTick();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith(change);
    unsubscribe();
  });

  it("hears it on either carrier alone", async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeSessionSwitch(heard);
    const byChannel = announceFromAnotherTab("login", "channel");
    await channelTick();
    const byStorage = announceFromAnotherTab("logout", "storage");
    expect(heard.mock.calls.map(([c]) => c)).toEqual([byChannel, byStorage]);
    unsubscribe();
  });

  it("ignores every other storage key and anything that is not a switch", async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeSessionSwitch(heard);
    window.dispatchEvent(new StorageEvent("storage", { key: "clawbox-custom-wallpapers", newValue: "[]" }));
    window.dispatchEvent(new StorageEvent("storage", { key: SESSION_SWITCH_STORAGE_KEY, newValue: null }));
    window.dispatchEvent(new StorageEvent("storage", { key: SESSION_SWITCH_STORAGE_KEY, newValue: "{not json" }));
    window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    const tab = new FakeBroadcastChannel(SESSION_SWITCH_CHANNEL);
    tab.postMessage({ hello: "world" });
    tab.close();
    await channelTick();
    expect(heard).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not hear its own document's announcement echoed back", async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeSessionSwitch(heard);
    announceSessionSwitch("login");
    await channelTick();
    expect(heard).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("lets go of the channel and the storage listener when unsubscribed", async () => {
    const heard = vi.fn();
    const unsubscribe = subscribeSessionSwitch(heard);
    expect(FakeBroadcastChannel.listening()).toBe(1);
    unsubscribe();
    expect(FakeBroadcastChannel.listening()).toBe(0);
    announceFromAnotherTab("login", "both");
    await channelTick();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("multi-tab propagation — two tabs, each with its own copy of the module", () => {
  it("one tab's sign-in reaches the other, and not itself", async () => {
    vi.resetModules();
    const tabA = await import("@/lib/session-switch");
    vi.resetModules();
    const tabB = await import("@/lib/session-switch");
    expect(tabA).not.toBe(tabB);

    const heardByA = vi.fn();
    const heardByB = vi.fn();
    const stopA = tabA.subscribeSessionSwitch(heardByA);
    const stopB = tabB.subscribeSessionSwitch(heardByB);

    const change = tabA.announceSessionSwitch("login");
    await channelTick();

    expect(heardByB).toHaveBeenCalledTimes(1);
    expect(heardByB).toHaveBeenCalledWith(change);
    expect(heardByA).not.toHaveBeenCalled();
    // The epoch a tab that missed it compares against, in the shared storage.
    expect(tabB.readSessionSwitch()).toEqual(change);
    stopA();
    stopB();
  });

  it("a page hook in one tab follows a switch announced by another tab's module", async () => {
    vi.resetModules();
    const otherTab = await import("@/lib/session-switch");
    renderHook(() => useFollowSessionSwitch());
    otherTab.announceSessionSwitch("login");
    await channelTick();
    expect(location.replace).toHaveBeenCalledTimes(1);
    expect(location.replace).toHaveBeenCalledWith("/app/terminal");
  });
});

describe("useFollowSessionSwitch — a signed-in page", () => {
  it("reopens at its own address when another tab signs in", async () => {
    renderHook(() => useFollowSessionSwitch());
    announceFromAnotherTab("login", "channel");
    await channelTick();
    expect(location.replace).toHaveBeenCalledWith("/app/terminal");
    // `replace`, never `assign`: the previous session's page leaves history.
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it("follows a sign-out too — the server answers the same address with /login", () => {
    renderHook(() => useFollowSessionSwitch());
    announceFromAnotherTab("logout", "storage");
    expect(location.replace).toHaveBeenCalledWith("/app/terminal");
  });

  it("follows once when both carriers deliver the same switch", async () => {
    renderHook(() => useFollowSessionSwitch());
    announceFromAnotherTab("login", "both");
    await channelTick();
    fireVisibility("visible");
    expect(location.replace).toHaveBeenCalledTimes(1);
  });

  it("tells its own page it is leaving before it navigates", async () => {
    const order: string[] = [];
    const onLeave = () => order.push("event");
    location.replace.mockImplementation(() => order.push("replace"));
    window.addEventListener(SESSION_SWITCH_EVENT, onLeave);
    try {
      renderHook(() => useFollowSessionSwitch());
      announceFromAnotherTab("login", "storage");
      expect(order).toEqual(["event", "replace"]);
    } finally {
      window.removeEventListener(SESSION_SWITCH_EVENT, onLeave);
    }
  });

  it("goes where its destination says, and stays when it says null", () => {
    const destination: SessionSwitchDestination = (change) => (change.kind === "login" ? "/somewhere" : null);
    renderHook(() => useFollowSessionSwitch(destination));
    announceFromAnotherTab("logout", "storage");
    expect(location.replace).not.toHaveBeenCalled();
    // Seen, so being shown again does not reconsider it.
    fireVisibility("hidden");
    fireVisibility("visible");
    expect(location.replace).not.toHaveBeenCalled();
    announceFromAnotherTab("login", "storage");
    expect(location.replace).toHaveBeenCalledWith("/somewhere");
  });

  it("takes the switch it mounted after as its baseline", () => {
    announceFromAnotherTab("login", "none");
    renderHook(() => useFollowSessionSwitch());
    fireVisibility("visible");
    firePageShow(true);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("catches up with a switch it missed while frozen in the background, when shown", () => {
    renderHook(() => useFollowSessionSwitch());
    fireVisibility("hidden");
    announceFromAnotherTab("login", "none");
    expect(location.replace).not.toHaveBeenCalled();
    fireVisibility("visible");
    expect(location.replace).toHaveBeenCalledWith("/app/terminal");
  });

  it("does not chase its own announcement while it is navigating for it", () => {
    renderHook(() => useFollowSessionSwitch());
    announceSessionSwitch("logout");
    fireVisibility("visible");
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("is not moved by an ordinary pageshow", () => {
    renderHook(() => useFollowSessionSwitch());
    announceFromAnotherTab("login", "none");
    firePageShow(false);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("stops listening when the page goes", async () => {
    const { unmount } = renderHook(() => useFollowSessionSwitch());
    unmount();
    expect(FakeBroadcastChannel.listening()).toBe(0);
    announceFromAnotherTab("login", "both");
    await channelTick();
    fireVisibility("visible");
    firePageShow(true);
    expect(location.replace).not.toHaveBeenCalled();
  });
});

describe("useFollowSessionSwitch — Back and Forward (the back-forward cache)", () => {
  it("a page restored after another tab switched the session reopens on the new one", () => {
    renderHook(() => useFollowSessionSwitch());
    announceFromAnotherTab("login", "none");
    firePageShow(true);
    expect(location.replace).toHaveBeenCalledWith("/app/terminal");
  });

  it("a page restored after it switched the session ITSELF reopens too", () => {
    renderHook(() => useFollowSessionSwitch());
    // Switch user from this desktop, then Back from /login to this document.
    announceSessionSwitch("logout");
    firePageShow(true);
    expect(location.replace).toHaveBeenCalledWith("/app/terminal");
  });

  it("a page restored with no switch since is left exactly as it was", () => {
    announceFromAnotherTab("login", "none");
    renderHook(() => useFollowSessionSwitch());
    firePageShow(true);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("a page that followed a switch, then came back, can follow the next one", async () => {
    renderHook(() => useFollowSessionSwitch());
    announceFromAnotherTab("login", "storage");
    expect(location.replace).toHaveBeenCalledTimes(1);
    announceFromAnotherTab("logout", "none");
    firePageShow(true);
    expect(location.replace).toHaveBeenCalledTimes(2);
  });
});
