import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bounded "which harness is this box?" probe, shared by the desktop and the
 * standalone `/app/<id>` window.
 *
 * The rule it encodes: an answer the DEVICE gave ends the asking, an answer that
 * is only this module's fallback does not, and the asking is bounded either way
 * — a page must not poll a route forever because a box cannot say what it is.
 */

const fetchMock = vi.hoisted(() =>
  vi.fn<(options?: { force?: boolean; signal?: AbortSignal }) => Promise<unknown>>(),
);
vi.mock("@/lib/client-harness", () => ({ fetchHarness: fetchMock }));

import { resolveHarnessProbe } from "@/lib/harness-probe";

const SETTLED = { active: "hermes", edition: "hermes", activeKnown: true };
const UNSETTLED = { active: "openclaw", edition: "openclaw", activeKnown: false };

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveHarnessProbe", () => {
  it("asks once when the device answered for itself", async () => {
    fetchMock.mockResolvedValue(SETTLED);
    await expect(resolveHarnessProbe()).resolves.toEqual(SETTLED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it("asks again past the cache when the answer was only a fallback", async () => {
    fetchMock.mockResolvedValueOnce(UNSETTLED).mockResolvedValue(SETTLED);
    const probe = resolveHarnessProbe();
    await vi.advanceTimersByTimeAsync(500);
    await expect(probe).resolves.toEqual(SETTLED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // `force`, or the second ask is served the first answer out of the client
    // cache and the retry is theatre.
    expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
  });

  it("gives up after its attempts and answers with the honest fallback", async () => {
    fetchMock.mockResolvedValue(UNSETTLED);
    const probe = resolveHarnessProbe();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(probe).resolves.toEqual(UNSETTLED);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a request that answered nothing at all, and reports null", async () => {
    fetchMock.mockResolvedValue(null);
    const probe = resolveHarnessProbe();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(probe).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports every answer as it lands, so a caller can paint the honest one", async () => {
    fetchMock.mockResolvedValueOnce(UNSETTLED).mockResolvedValue(SETTLED);
    const seen: string[] = [];
    const probe = resolveHarnessProbe({ onAnswer: (info) => seen.push(`${info.active}:${info.activeKnown}`) });
    await vi.advanceTimersByTimeAsync(500);
    await probe;
    expect(seen).toEqual(["openclaw:false", "hermes:true"]);
  });

  it("stops when the caller goes away, rather than waking a dead page", async () => {
    // An unmounted component's effect aborts; the pending backoff must not
    // outlive it and fire a request nobody reads.
    fetchMock.mockResolvedValue(UNSETTLED);
    const controller = new AbortController();
    const probe = resolveHarnessProbe({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(probe).resolves.toEqual(UNSETTLED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
