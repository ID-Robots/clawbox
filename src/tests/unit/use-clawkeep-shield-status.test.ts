// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useClawkeepShieldStatus } from "@/hooks/useClawkeepShieldStatus";

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
