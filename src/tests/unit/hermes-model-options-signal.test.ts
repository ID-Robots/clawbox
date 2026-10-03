// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHermesModelOptions } from "@/hooks/useHermesModelOptions";
import { notifyProvidersChanged } from "@/lib/ui-events";

/**
 * `useHermesModelOptions` on a provider-set signal.
 *
 * The hook is mounted inside the chat popup — one very large component — on
 * EVERY edition, with a null provider wherever Hermes is not the harness. A
 * signal (a key saved, a provider switched on, a new default) used to reach the
 * re-read through a state counter that re-ran the load effect, so every signal
 * rendered the whole popup before a byte was fetched — on an OpenClaw box too,
 * where the provider is null and nothing was ever asked — and an answer equal
 * to the one shown then rendered it again. These pin that neither costs the
 * host a render now, and that the reads a signal makes are exactly the ones the
 * counter made: one plain re-read, the read in flight dropped, and a Refresh
 * the owner pressed carried over to the read that replaces its dropped one.
 */

function scope(models: string[], provider = "openai") {
  return {
    provider,
    authenticated: true,
    models: models.map((id) => ({ id })),
    defaultModel: models[0] ?? "",
    current: models[0] ?? "",
    savedElsewhere: null,
    source: "dashboard",
    stale: false,
  };
}

/** The model-options URLs asked for, in order. */
let urls: string[];
/** How the next read is answered; a held one resolves when released. */
let answer: () => Promise<unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  urls = [];
  answer = async () => scope(["openai/gpt-5", "openai/gpt-5-mini"]);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/setup-api/hermes/models")) {
      urls.push(url);
      const body = await answer();
      return { ok: true, json: async () => body } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(provider: string | null = "openai") {
  const counter = { renders: 0 };
  const rendered = renderHook(({ p }: { p: string | null }) => {
    counter.renders += 1;
    return useHermesModelOptions(p);
  }, { initialProps: { p: provider } });
  return { ...rendered, counter };
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function signal() {
  await act(async () => {
    notifyProvidersChanged();
    // Past the shared subscriber's debounce, and the read it starts.
    await vi.advanceTimersByTimeAsync(500);
  });
}

const ids = (s: ReturnType<typeof useHermesModelOptions>["scope"]) => s?.models.map((m) => m.id);

describe("useHermesModelOptions on a provider-set signal", () => {
  it("renders nothing when the scope it re-reads is the one already shown", async () => {
    const { result, counter, unmount } = mount();
    await settle();
    expect(ids(result.current.scope)).toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);
    const shown = result.current.scope;
    const renders = counter.renders;

    for (let i = 0; i < 3; i += 1) await signal();

    // Each signal still re-asks the route — plainly, never the live sweep…
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u === "/setup-api/hermes/models?provider=openai")).toBe(true);
    // …and an unchanged answer reaches nobody.
    expect(counter.renders).toBe(renders);
    expect(result.current.scope).toBe(shown);
    unmount();
  });

  it("asks nothing, and renders nothing, without a provider — the chat on an OpenClaw box", async () => {
    const { result, counter, unmount } = mount(null);
    await settle();
    const renders = counter.renders;

    await signal();
    await signal();

    expect(urls).toEqual([]);
    expect(result.current.scope).toBeNull();
    expect(counter.renders).toBe(renders);
    unmount();
  });

  it("still hands over a scope the signal's read changed", async () => {
    const { result, unmount } = mount();
    await settle();
    answer = async () => scope(["openai/gpt-5", "openai/gpt-5-mini", "openai/o5"]);

    await signal();

    expect(ids(result.current.scope)).toContain("openai/o5");
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it("drops the read in flight when the signal lands, so the older answer never wins", async () => {
    let release: (body: unknown) => void = () => {};
    answer = () => new Promise((resolve) => { release = resolve; });
    const { result, unmount } = mount();
    await settle();
    const preConnect = release;

    // The signal's read answers first, with the post-configure models…
    answer = async () => scope(["openai/o5"]);
    await signal();
    expect(ids(result.current.scope)).toEqual(["openai/o5"]);

    // …and the pre-configure read that was still out lands after it, discarded.
    await act(async () => {
      preConnect(scope(["openai/gpt-5"]));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ids(result.current.scope)).toEqual(["openai/o5"]);
    unmount();
  });

  it("carries a Refresh whose read the signal dropped over to the read that replaces it, and only that once", async () => {
    const { result, unmount } = mount();
    await settle();
    expect(urls).toEqual(["/setup-api/hermes/models?provider=openai"]);

    let release: (body: unknown) => void = () => {};
    answer = () => new Promise((resolve) => { release = resolve; });
    act(() => result.current.refresh());
    await settle();
    expect(urls[1]).toContain("refresh=1");

    // The signal lands while the Refresh is still out: its read is dropped,
    // so the owner's ask rides on the one that replaces it.
    answer = async () => scope(["openai/gpt-5"]);
    await signal();
    expect(urls[2]).toContain("refresh=1");
    release(scope(["openai/gpt-5"]));

    // That read answered: the next signal is a plain re-read again.
    await signal();
    expect(urls[3]).toBe("/setup-api/hermes/models?provider=openai");
    unmount();
  });

  it("restarts the retries of a box still answering with a placeholder, as a fresh cause", async () => {
    answer = async () => ({ ...scope([]), stale: true, source: "catalog-file" });
    const { result, unmount } = mount();
    await settle();
    // Two retries in (1 s, then 2 s): the next one is booked 4 s later.
    await settle(1_100);
    await settle(2_100);
    expect(urls).toHaveLength(3);
    expect(result.current.loading).toBe(true);

    await signal();
    const afterSignal = urls.length;
    // Back to the first step: the next retry is 1 s after the signal's read,
    // not the 4 s the old schedule had reached.
    await settle(1_100);
    expect(urls.length).toBe(afterSignal + 1);
    unmount();
  });
});
