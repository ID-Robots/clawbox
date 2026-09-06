import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedActiveHarness,
  cachedEdition,
  fetchHarness,
  invalidateActiveHarness,
  resetHarnessCache,
} from "@/lib/client-harness";

/**
 * Five components fetched /setup-api/harness/active independently on every
 * mount, so re-opening Settings re-ran the request and re-showed the skeleton
 * that waits on it. These cover the cache that removed that.
 */
describe("client harness cache", () => {
  let calls: number;

  beforeEach(() => {
    resetHarnessCache();
    calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ active: "hermes", edition: "hermes", editionKnown: true }),
      } as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetHarnessCache();
  });

  it("serves repeat callers from cache instead of re-fetching", async () => {
    const answer = { active: "hermes", edition: "hermes", editionKnown: true };
    expect(await fetchHarness()).toEqual(answer);
    // From the cache, and carrying the same `editionKnown`: a caller that must
    // not brand the box on a guess reads it, and a cached answer that dropped
    // it would silently turn a fact back into a doubt on the second mount.
    expect(await fetchHarness()).toEqual(answer);
    expect(calls).toBe(1);
  });

  it("reports the edition as NOT known when the device did not say", async () => {
    // A server that predates the field. Absent is not "true": the field exists
    // because an unreadable lock answers "openclaw" like a real OpenClaw box,
    // and reading silence as a fact is the failure it was added to stop.
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) } as Response;
    }));
    expect(await fetchHarness()).toEqual({
      active: "openclaw",
      edition: "openclaw",
      editionKnown: false,
    });
    expect(await fetchHarness()).toMatchObject({ editionKnown: false });
    expect(calls).toBe(1);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const [a, b, c] = await Promise.all([fetchHarness(), fetchHarness(), fetchHarness()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("exposes the resolved values synchronously afterwards", async () => {
    expect(cachedEdition()).toBeNull();
    await fetchHarness();
    // This is what lets a remounted panel skip its loading skeleton entirely.
    expect(cachedEdition()).toBe("hermes");
    expect(cachedActiveHarness()).toBe("hermes");
  });

  it("keeps the edition but re-reads the active harness once the TTL lapses", async () => {
    vi.useFakeTimers();
    await fetchHarness();
    vi.advanceTimersByTime(10_000);
    // The edition is baked into a root-owned env file and cannot change under a
    // live page, so it never expires; the active harness can, so it does.
    expect(cachedEdition()).toBe("hermes");
    expect(cachedActiveHarness()).toBeNull();
  });

  it("re-fetches after an explicit invalidation", async () => {
    await fetchHarness();
    invalidateActiveHarness();
    await fetchHarness();
    expect(calls).toBe(2);
  });

  it("returns null on failure without poisoning the cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchHarness()).toBeNull();
    expect(cachedEdition()).toBeNull();
  });
});
