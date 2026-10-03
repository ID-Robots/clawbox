// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProviderCatalog } from "@/hooks/useProviderCatalog";
import { notifyProvidersChanged } from "@/lib/ui-events";

/**
 * `useProviderCatalog` on a provider-set signal.
 *
 * The hook is mounted inside the chat popup — one very large component — and a
 * signal (a key saved, a provider switched on, a new default) re-asks the
 * catalogue route, which nearly always answers with the rows the picker
 * already draws. The signal used to reach the re-read through a state counter
 * that re-ran the hook's effect, so every signal rendered the whole popup
 * before a byte had been fetched, and React then called it once more to find
 * the unchanged answer changed nothing. These pin that a signal whose answer
 * is the catalogue already shown costs the host no render — and that the reads
 * a signal makes are exactly the ones the counter made: one `?refresh=1`, the
 * read in flight dropped, plain reads after it.
 */

const LIVE = {
  provider: "anthropic",
  models: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ],
  defaultModelId: "claude-sonnet-5",
  allowCustom: true,
  source: "live",
};

/** The catalog URLs asked for, in order. */
let urls: string[];
/** How the next catalog read is answered; a held one resolves when released. */
let answer: () => Promise<unknown>;

function respond(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  urls = [];
  answer = async () => LIVE;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/setup-api/ai-models/catalog")) {
      urls.push(url);
      return respond(await answer());
    }
    return respond({});
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(provider = "anthropic") {
  const counter = { renders: 0 };
  const rendered = renderHook(({ p }: { p: string }) => {
    counter.renders += 1;
    return useProviderCatalog(p);
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

describe("useProviderCatalog on a provider-set signal", () => {
  it("renders nothing when the catalogue it re-reads is the one already shown", async () => {
    const { result, counter, unmount } = mount();
    await settle();
    expect(result.current?.models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    const catalog = result.current;
    const renders = counter.renders;

    for (let i = 0; i < 3; i += 1) await signal();

    // Each signal still asks the route to re-enumerate…
    expect(urls).toHaveLength(4);
    expect(urls.slice(1).every((u) => u.includes("refresh=1"))).toBe(true);
    // …and an unchanged answer reaches nobody.
    expect(counter.renders).toBe(renders);
    expect(result.current).toBe(catalog);
    unmount();
  });

  it("still hands over a catalogue the signal's read changed", async () => {
    const { result, unmount } = mount();
    await settle();
    answer = async () => ({ ...LIVE, models: [...LIVE.models, { id: "claude-fable-5", label: "Claude Fable 5" }] });

    await signal();

    expect(result.current?.models.map((m) => m.id)).toContain("claude-fable-5");
    unmount();
  });

  it("drops the read in flight when the signal lands, so the older answer never wins", async () => {
    let release: (body: unknown) => void = () => {};
    answer = () => new Promise((resolve) => { release = resolve; });
    const { result, unmount } = mount();
    await settle();
    const preConnect = release;

    // The signal's read answers first, with the post-connect rows…
    answer = async () => ({ ...LIVE, models: [{ id: "claude-fable-5", label: "Claude Fable 5" }] });
    await signal();
    expect(result.current?.models.map((m) => m.id)).toEqual(["claude-fable-5"]);

    // …and the pre-connect read that was still out lands after it, discarded.
    await act(async () => {
      preConnect(LIVE);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current?.models.map((m) => m.id)).toEqual(["claude-fable-5"]);
    unmount();
  });

  it("asks for a refresh once per signal: the warming polls after it, and a later provider switch, are plain reads", async () => {
    answer = async () => ({ ...LIVE, warming: true });
    const { rerender, unmount } = mount();
    await settle();
    expect(urls).toEqual(["/setup-api/ai-models/catalog?provider=anthropic"]);

    await signal();
    expect(urls[1]).toContain("refresh=1");

    // The route is enumerating: the poll that follows must not tell it to
    // start again (2 s, the first step of the warming backoff).
    await settle(2_100);
    expect(urls[2]).toBe("/setup-api/ai-models/catalog?provider=anthropic");

    // A different provider received no signal: no refresh for it.
    answer = async () => ({ ...LIVE, provider: "openai" });
    rerender({ p: "openai" });
    await settle();
    expect(urls[urls.length - 1]).toBe("/setup-api/ai-models/catalog?provider=openai");
    unmount();
  });

  it("restarts the warming poll's budget on a signal, as a fresh cause", async () => {
    answer = async () => ({ ...LIVE, warming: true });
    const { unmount } = mount();
    await settle();
    // Two polls in: the next one is due 4 s later.
    await settle(2_100);
    await settle(4_100);
    expect(urls).toHaveLength(3);

    await signal();
    const afterSignal = urls.length;
    // Back to the first step: the next poll is 2 s after the signal's read,
    // not the 8 s the old schedule had reached.
    await settle(2_100);
    expect(urls.length).toBe(afterSignal + 1);
    unmount();
  });

  it("asks nothing, and listens to nothing, for a provider without a catalogue", async () => {
    const { result, counter, unmount } = mount("llamacpp");
    await settle();
    const renders = counter.renders;
    await signal();
    expect(urls).toEqual([]);
    expect(result.current).toBeNull();
    expect(counter.renders).toBe(renders);
    unmount();
  });
});
