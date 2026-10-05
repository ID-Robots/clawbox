// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  pollClawkeepStatus,
  refreshClawkeepStatus,
  useClawkeepShieldStatus,
} from "@/hooks/useClawkeepShieldStatus";
import { deferred } from "@/tests/helpers/deferred";

/**
 * The shelf shield's clock.
 *
 * The verdict itself is `deriveProtection`, tested in clawkeep-protection.
 * What is tested here is *when* it is asked — because a verdict that only
 * moves when a response arrives stops ageing the moment the box stops
 * answering, and the answer it freezes on is the last good one: green.
 */

const HOUR = 60 * 60 * 1000;

/** Only what the hook reads off a Response. */
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FakeFetch = () => Promise<FakeResponse>;

const DAILY = { enabled: true, frequency: "daily" as const };

/** A box on a nightly schedule whose last good backup is `ageMs` old, with the
 *  daemon's last word still "ok" — the EXIT_AUTH_REVOKED shape. */
function boxWithBackupAged(ageMs: number) {
  return {
    paired: true,
    lastBackupAtMs: Date.now() - ageMs,
    lastHeartbeatAtMs: Date.now() - ageMs,
    lastHeartbeatStatus: "ok",
    schedule: DAILY,
    scheduleArmedAtMs: 0,
    encryptionConfigured: true,
    restoring: false,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
});

describe("useClawkeepShieldStatus", () => {
  it("keeps ageing the verdict after the status route stops answering", async () => {
    // 30 h old against a 36 h window: green, and correctly so.
    const body = boxWithBackupAged(30 * HOUR);
    const fetchMock = vi.fn<FakeFetch>(async () => ({ ok: true, status: 200, json: async () => body }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.protection).toEqual({ state: "protected", reason: "ok" });

    // The route starts failing — a corrupt state.json, a daemon mid-restart.
    // Every poll from here on returns nothing the hook can use.
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    // Eight hours later the backup is 38 h old and the box is genuinely
    // lapsed. Nothing new has arrived, and nothing will.
    await act(async () => { await vi.advanceTimersByTimeAsync(8 * HOUR); });
    expect(result.current.protection).toEqual({ state: "lapsed", reason: "stale" });
  });

  it("never publishes a verdict before an answer has arrived", async () => {
    vi.stubGlobal("fetch", vi.fn<FakeFetch>(async () => { throw new Error("offline"); }));

    const { result } = renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * HOUR); });

    // No facts, no judgement — the shield must not invent one to age.
    expect(result.current.protection).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it("holds the last verdict through a blip rather than flickering", async () => {
    const body = boxWithBackupAged(1 * HOUR);
    const fetchMock = vi.fn<FakeFetch>(async () => ({ ok: true, status: 200, json: async () => body }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const first = result.current.protection;
    expect(first).toEqual({ state: "protected", reason: "ok" });

    fetchMock.mockImplementation(async () => { throw new Error("network blip"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });

    // Same verdict, and the same object: an unchanged answer must not
    // re-render the whole desktop every minute.
    expect(result.current.protection).toBe(first);
  });
});

/**
 * A desktop nobody can see — a phone's tab in the background, a laptop left on
 * another tab, the kiosk's desktop tab while the owner is on another — does
 * not ask the box every 5 s for a shelf it cannot show. A tick that falls due
 * then is asked the moment the page is visible again.
 */
describe("useClawkeepShieldStatus — a hidden page", () => {
  let visibility: DocumentVisibilityState = "visible";
  function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    // jsdom's own getter is on Document.prototype; the instance override goes.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it("asks nothing while hidden, and asks at once on the visible edge", async () => {
    const fetchMock = vi.fn<FakeFetch>(async () => ({ ok: true, status: 200, json: async () => boxWithBackupAged(HOUR) }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a trip away no tick fell due in asks nothing extra", async () => {
    const fetchMock = vi.fn<FakeFetch>(async () => ({ ok: true, status: 200, json: async () => boxWithBackupAged(HOUR) }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { setVisibility("visible"); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The ClawKeep window asks the same route (every 10 s, 3 s while a backup
 * runs). The requests are the page's, shared: an answer the window asked for
 * reaches the shield too, which then asks nothing of its own until 5 s pass
 * without one, and a look that falls due while a request is out joins it.
 */
describe("useClawkeepShieldStatus — the requests it shares with the ClawKeep window", () => {
  const ok = (body: unknown): FakeResponse => ({ ok: true, status: 200, json: async () => body });

  it("alone it asks every 5 s; while the window asks every 3 s it asks for nothing of its own", async () => {
    const fetchMock = vi.fn<FakeFetch>(async () => ok(boxWithBackupAged(HOUR)));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // The window opens on a running backup: a look every 3 s, for 30 s.
    const windowLooks = window.setInterval(() => { void pollClawkeepStatus(); }, 3_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    window.clearInterval(windowLooks);
    expect(fetchMock).toHaveBeenCalledTimes(4 + 10);

    // The window closes: the shield's own 5 s clock is back.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4 + 10 + 2);
  });

  it("an answer the window asked for reaches the shield at once", async () => {
    let body: unknown = boxWithBackupAged(HOUR);
    vi.stubGlobal("fetch", vi.fn<FakeFetch>(async () => ok(body)));

    const { result } = renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.protection).toEqual({ state: "protected", reason: "ok" });

    // A backup started from the window: its refresh says so before the
    // shield's own next look is due.
    body = { ...boxWithBackupAged(HOUR), lastHeartbeatStatus: "running", lastHeartbeatAtMs: Date.now() };
    await act(async () => {
      await refreshClawkeepStatus();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.busy).toBe(true);
  });

  it("a look that falls due while a request is out joins it; a refresh never does", async () => {
    const out = deferred<FakeResponse>();
    const fetchMock = vi.fn<FakeFetch>(() => out.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const joined = pollClawkeepStatus();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After an action the answer must come from a request sent after it.
    fetchMock.mockImplementation(async () => ok(boxWithBackupAged(HOUR)));
    const fresh = refreshClawkeepStatus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await fresh; await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.protection).toEqual({ state: "protected", reason: "ok" });

    // The first request lands last, with an older answer: it changes nothing.
    out.resolve(ok(boxWithBackupAged(40 * HOUR)));
    await act(async () => { await joined; await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.protection).toEqual({ state: "protected", reason: "ok" });
  });

  it("a request still out after 15 s is not waited on for ever", async () => {
    const stuck = deferred<FakeResponse>();
    const fetchMock = vi.fn<FakeFetch>(() => stuck.promise);
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(async () => ok(boxWithBackupAged(HOUR)));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stuck.resolve(ok(boxWithBackupAged(HOUR)));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  });

  it("lets a stuck request go after 15 s of the box's own time, whatever its wall clock does", async () => {
    // The box has no RTC and its clock steps at NTP sync. Stepped back an
    // hour while a request was out, a wall-clock window kept that request
    // joinable for the hour — the shield and the ClawKeep window both waiting
    // on an answer that was never coming.
    const stuck = deferred<FakeResponse>();
    const fetchMock = vi.fn<FakeFetch>(() => stuck.promise);
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useClawkeepShieldStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() - HOUR);
    fetchMock.mockImplementation(async () => ok(boxWithBackupAged(HOUR)));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stuck.resolve(ok(boxWithBackupAged(HOUR)));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  });
});
