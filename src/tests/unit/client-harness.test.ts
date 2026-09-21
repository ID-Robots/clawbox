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
        json: async () => ({ active: "hermes", edition: "hermes", activeKnown: true }),
      } as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetHarnessCache();
  });

  it("serves repeat callers from cache instead of re-fetching", async () => {
    const answer = { active: "hermes", edition: "hermes", activeKnown: true };
    expect(await fetchHarness()).toEqual(answer);
    // From the cache, and carrying the same `activeKnown`: a caller that must
    // not brand the box on a guess reads it, and a cached answer that dropped
    // it would silently turn a fact back into a doubt on the second mount.
    expect(await fetchHarness()).toEqual(answer);
    expect(calls).toBe(1);
  });

  it("reports the harness as NOT resolved when the device did not say", async () => {
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
      activeKnown: false,
    });
    // ASKED AGAIN, deliberately. The edition is cached for the lifetime of the
    // document on the premise that it cannot change under a live page — true of
    // the edition, false of the ANSWER: while `install.sh` rewrites the
    // root-owned lock this route answers `openclaw, and that was a guess` for
    // any box, and a page that pinned it wore the wrong product until it was
    // reloaded. A guess is served once and asked again.
    expect(await fetchHarness()).toMatchObject({ activeKnown: false });
    expect(calls).toBe(2);
  });

  it("stops asking once the device answers for itself", async () => {
    // The other half: a settled answer IS pinned, so a box that can name
    // itself pays one request per document, as before.
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ active: "hermes", edition: "hermes", activeKnown: true }),
      } as Response;
    }));
    expect(await fetchHarness()).toMatchObject({ activeKnown: true });
    expect(await fetchHarness()).toMatchObject({ activeKnown: true });
    expect(calls).toBe(1);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const [a, b, c] = await Promise.all([fetchHarness(), fetchHarness(), fetchHarness()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("one caller's abort does not answer null for every other caller", async () => {
    // Both surfaces that probe the harness pass a signal now (the shared retry
    // helper aborts its attempts), and `inFlight` is handed to every concurrent
    // caller — so a signalled request stored there let a closing chat window
    // reject the desktop's and the standalone page's probes too. Each of those
    // reads null as "the device did not answer" and stops branding the box,
    // which is the false failure this guard removes. The signal still cancels
    // the request its OWN caller made.
    const answered = { active: "hermes", edition: "hermes", activeKnown: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            setTimeout(() => resolve({ ok: true, json: async () => answered } as Response), 5);
          }),
      ),
    );

    const controller = new AbortController();
    const signalled = fetchHarness({ signal: controller.signal });
    const bystander = fetchHarness();
    controller.abort();

    expect(await signalled, "the aborting caller gets its own cancellation").toBeNull();
    expect(await bystander, "and nobody else pays for it").toEqual(answered);
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
