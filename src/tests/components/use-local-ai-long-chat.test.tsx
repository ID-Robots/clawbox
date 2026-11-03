import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SHORTEN_REMEASURE_MS, useLocalAiLongChat, type LocalAiLongChatOptions } from "@/lib/use-local-ai-long-chat";
import type { HarnessAdapter } from "@/lib/harness/transport";

/**
 * TASK-2127: the timing half of a long conversation on Local AI — the 90-second
 * bound on a local turn (or a "shorten first") still summarizing, and the
 * status line's "loading" only while llama-server says it is not ready. The
 * card and the sends through the real chat are pinned in
 * src/tests/components/chat-local-ai.test.tsx.
 */

const KEY = "agent:main:main";
const pending = { text: "Колко е 17 × 23?", attachments: [] };

function adapterWith(tokens: number, compact?: () => Promise<unknown>) {
  return {
    conversationSize: vi.fn(async () => ({ tokens })),
    compactConversation: vi.fn(compact ?? (() => new Promise(() => {}))),
    abortTurn: vi.fn(async () => {}),
  } as unknown as HarnessAdapter & {
    conversationSize: ReturnType<typeof vi.fn>;
    compactConversation: ReturnType<typeof vi.fn>;
    abortTurn: ReturnType<typeof vi.fn>;
  };
}

function setup(adapter: HarnessAdapter, overrides: Partial<LocalAiLongChatOptions> = {}) {
  const base: LocalAiLongChatOptions = {
    adapter,
    onLocalAi: true,
    llamaCpp: true,
    localWindow: 32768,
    activeKey: KEY,
    connected: true,
    sending: false,
    historyMark: 0,
    turnHeardFrom: false,
    turnStartedAt: 0,
    sessionKeyRef: { current: KEY },
    openNewChat: vi.fn(async () => "agent:main:clawbox-abcdef012345"),
    queueSend: vi.fn(),
    restoreDraft: vi.fn(),
    noteSystem: vi.fn(),
    shortenedText: "Conversation shortened for the local model.",
    abortTurn: () => adapter.abortTurn(),
    fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ running: true }) })) as unknown as typeof fetch,
    ...overrides,
  };
  const view = renderHook((props: LocalAiLongChatOptions) => useLocalAiLongChat(props), { initialProps: base });
  return { ...view, base };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the 90-second bound", () => {
  it("stops a local turn sent into a too-long conversation that is still shortening, and offers the new chat with its question", async () => {
    const adapter = adapterWith(100460);
    const { result, rerender, base } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));

    // The owner closed the card and carried on: the turn goes, on a long chat.
    act(() => { result.current.dismiss(); });
    let held = true;
    act(() => { held = result.current.admitTurn(KEY, pending); });
    expect(held).toBe(false);
    rerender({ ...base, sending: true, turnStartedAt: Date.now() });
    expect(result.current.phase).toBe("shortening");

    await act(async () => { await vi.advanceTimersByTimeAsync(89_000); });
    expect(adapter.abortTurn).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(adapter.abortTurn).toHaveBeenCalledTimes(1);
    expect(result.current.offer).toMatchObject({ kind: "timeout", pending: { text: "Колко е 17 × 23?" } });
  });

  it("infers nothing on a harness that reports its own compaction (Hermes)", async () => {
    const adapter = adapterWith(100460);
    const { result, rerender, base } = setup(adapter, { inferCompaction: false });
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    act(() => { result.current.dismiss(); });
    act(() => { result.current.admitTurn(KEY, pending); });
    rerender({ ...base, inferCompaction: false, sending: true, turnStartedAt: Date.now() });
    expect(result.current.phase).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
    expect(adapter.abortTurn).not.toHaveBeenCalled();
    // Its own frames still say so, and still bound it.
    act(() => { result.current.noteAgentFrame({ stream: "compaction", data: { phase: "start" } }); });
    expect(result.current.phase).toBe("shortening");
  });

  it("follows the core's compaction frames: a summary that ends in time is never stopped", async () => {
    const adapter = adapterWith(9000);
    const { result, rerender, base } = setup(adapter);
    await waitFor(() => expect(adapter.conversationSize).toHaveBeenCalled());
    act(() => { result.current.admitTurn(KEY, pending); });
    rerender({ ...base, sending: true, turnStartedAt: Date.now() });
    expect(result.current.phase).toBeNull();

    act(() => { result.current.noteAgentFrame({ stream: "compaction", data: { phase: "start" } }); });
    expect(result.current.phase).toBe("shortening");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    act(() => { result.current.noteAgentFrame({ stream: "compaction", data: { phase: "end", completed: true } }); });
    expect(result.current.phase).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(adapter.abortTurn).not.toHaveBeenCalled();
  });

  it("ignores a compaction frame that arrives after the turn (the core's post-reply maintenance)", async () => {
    const adapter = adapterWith(9000);
    const { result, rerender, base } = setup(adapter);
    act(() => { result.current.noteAgentFrame({ stream: "compaction", data: { phase: "start" } }); });
    rerender({ ...base, sending: true, turnStartedAt: Date.now() });
    expect(result.current.phase).toBeNull();
  });

  it("gives a 'shorten first' that runs past the bound the new-chat offer", async () => {
    const adapter = adapterWith(100460);
    const { result } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));

    act(() => { result.current.shorten(); });
    expect(adapter.compactConversation).toHaveBeenCalledWith(KEY);
    expect(result.current.shorteningSince).toBeGreaterThan(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(90_500); });
    expect(result.current.offer?.kind).toBe("timeout");
    expect(result.current.shorteningSince).toBe(0);
  });

  it("says a shorten that failed did not shorten anything", async () => {
    const adapter = adapterWith(100460, async () => { throw new Error("The conversation was not shortened."); });
    const { result } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    await act(async () => { result.current.shorten(); });
    await waitFor(() => expect(result.current.offer?.kind).toBe("failed"));
    expect(result.current.shorteningSince).toBe(0);
  });

  it("does not call a conversation shortened that is still too long for the local model, and keeps the message on the card", async () => {
    // A board: Hermes folded one exchange of seven, 52k → 50k over its 32k line.
    const adapter = adapterWith(52770, async () => ({ tokensBefore: 52770, tokensAfter: 49726 }));
    adapter.conversationSize.mockResolvedValue({ tokens: 52770, window: 65536, limit: 32768 });
    const { result, base } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    let held = false;
    act(() => { held = result.current.admitTurn(KEY, pending); });
    expect(held).toBe(true);

    adapter.conversationSize.mockResolvedValue({ tokens: 49726, window: 65536, limit: 32768 });
    await act(async () => { result.current.shorten(); });
    await waitFor(() => expect(result.current.offer?.kind).toBe("failed"));
    expect(result.current.offer).toMatchObject({ tokens: 49726, window: 32768, pending: { text: "Колко е 17 × 23?" } });
    expect(result.current.shorteningSince).toBe(0);
    expect(base.noteSystem).not.toHaveBeenCalled();
    expect(base.queueSend).not.toHaveBeenCalled();
  });

  it("calls it shortened, and sends the waiting message, once it fits", async () => {
    const adapter = adapterWith(100460, async () => ({ tokensBefore: 100460, tokensAfter: 9000 }));
    const { result, base } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    act(() => { result.current.admitTurn(KEY, pending); });

    adapter.conversationSize.mockResolvedValue({ tokens: 9000 });
    await act(async () => { result.current.shorten(); });
    await waitFor(() => expect(base.noteSystem).toHaveBeenCalledWith(KEY, "Conversation shortened for the local model."));
    expect(base.queueSend).toHaveBeenCalledWith(KEY, expect.objectContaining({ text: "Колко е 17 × 23?" }));
    expect(result.current.offer).toBeNull();
  });

  it("takes the harness's word when the size after a shorten is unknown, or does not come in time", async () => {
    for (const after of [Promise.resolve(null), new Promise(() => {})]) {
      const adapter = adapterWith(100460, async () => ({}));
      const { result, base, unmount } = setup(adapter);
      await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
      adapter.conversationSize.mockReturnValue(after);
      await act(async () => { result.current.shorten(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(SHORTEN_REMEASURE_MS + 500); });
      await waitFor(() => expect(base.noteSystem).toHaveBeenCalledWith(KEY, "Conversation shortened for the local model."));
      expect(result.current.offer).toBeNull();
      expect(result.current.shorteningSince).toBe(0);
      unmount();
    }
  });

  it("does not bring back a card the owner closed while the shorten ran past the bound", async () => {
    const adapter = adapterWith(100460);
    const { result } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    act(() => { result.current.shorten(); });
    act(() => { result.current.dismiss(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(90_500); });
    expect(result.current.offer).toBeNull();
    expect(result.current.shorteningSince).toBe(0);
  });
});

describe("loading, only while llama-server is not ready", () => {
  it("says loading while the server answers not ready, then stops asking once it is", async () => {
    const answers = [false, false, true];
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ running: answers.shift() ?? true }) }));
    const adapter = adapterWith(2000);
    const { result, rerender, base } = setup(adapter, { fetchImpl: fetchImpl as unknown as typeof fetch });
    act(() => { result.current.admitTurn(KEY, pending); });
    rerender({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sending: true, turnStartedAt: Date.now() });

    await waitFor(() => expect(result.current.phase).toBe("loading"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    await waitFor(() => expect(result.current.phase).toBeNull());
    const asked = fetchImpl.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchImpl.mock.calls.length).toBe(asked);
  });

  it("never says loading for an answer it could not read", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const adapter = adapterWith(2000);
    const { result, rerender, base } = setup(adapter, { fetchImpl: fetchImpl as unknown as typeof fetch });
    act(() => { result.current.admitTurn(KEY, pending); });
    rerender({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sending: true, turnStartedAt: Date.now() });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetchImpl).toHaveBeenCalled();
    expect(result.current.phase).toBeNull();
  });
});

describe("the card", () => {
  it("measures again once the conversation's history has landed (Hermes learns its session from it)", async () => {
    const adapter = adapterWith(100460);
    (adapter.conversationSize as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { result, rerender, base } = setup(adapter);
    await waitFor(() => expect(adapter.conversationSize).toHaveBeenCalledTimes(1));
    expect(result.current.offer).toBeNull();
    rerender({ ...base, historyMark: 30 });
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
  });

  it("names the harness's own line as the local model's room when it gives one", async () => {
    const adapter = adapterWith(52000);
    (adapter.conversationSize as ReturnType<typeof vi.fn>).mockResolvedValue({ tokens: 52000, window: 65536, limit: 32768 });
    const { result } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    expect(result.current.offer).toMatchObject({ tokens: 52000, window: 32768 });
  });

  it("is gone once the chat is not on Local AI, and comes back with it", async () => {
    const adapter = adapterWith(100460);
    const { result, rerender, base } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    rerender({ ...base, onLocalAi: false });
    expect(result.current.offer).toBeNull();
    rerender({ ...base });
    expect(result.current.offer?.kind).toBe("fit");
  });

  it("holds every message sent while it is up, joined, for the one choice", async () => {
    const adapter = adapterWith(100460);
    const { result, base } = setup(adapter);
    await waitFor(() => expect(result.current.offer?.kind).toBe("fit"));
    act(() => { result.current.admitTurn(KEY, { text: "first", attachments: [] }); });
    act(() => { result.current.admitTurn(KEY, { text: "second", attachments: [] }); });
    expect(result.current.offer?.pending?.text).toBe("first\n\nsecond");

    act(() => { result.current.startNewChat(); });
    await waitFor(() => expect(base.queueSend).toHaveBeenCalledWith(
      "agent:main:clawbox-abcdef012345",
      expect.objectContaining({ text: "first\n\nsecond" }),
    ));
    expect(result.current.offer).toBeNull();
  });
});
