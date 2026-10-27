import { describe, expect, it, vi } from "vitest";
import { OpenClawGatewayAdapter, type GatewayLink } from "@/lib/harness/openclaw-gateway-adapter";
import type { FetchLike, HarnessCapabilities } from "@/lib/harness/transport";

/**
 * The delta half of `chat.history`.
 *
 * A full page is the last 50 messages — ~206 KB on the audit's box — and the
 * chat pulled one for every append the gateway pushed, whether or not anyone
 * was looking. The RPC accepts a `cursor`, and one that is not a page cursor
 * asks for only what was appended since. What is pinned here: the cursor a
 * page hands back is spent on the next read; the delta's ENVELOPES are
 * unwrapped and appended to the rows already read, so one projection (with its
 * six shipped fixes) runs over the whole transcript; `reset` falls back to a
 * page; a core that predates the parameter is retried without it; and a
 * gateway that offers no cursor gets exactly the full read it always did.
 *
 * The projection is not re-derived here — the assertions are about which
 * messages come out and which frames go out.
 */

const MAIN = "agent:main:main";

const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });

type Answer = Record<string, unknown> | Error;

function adapterWith(answers: Answer[]) {
  const calls: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (_method: string, params: unknown) => {
    const p = (params ?? {}) as Record<string, unknown>;
    calls.push(p);
    const next = answers.shift();
    if (!next) throw new Error("no answer left");
    if (next instanceof Error) throw next;
    return next;
  });
  const link = {
    request,
    sessionKey: () => MAIN,
    open: async () => {},
    close: () => {},
    onStatus: () => () => {},
  } as unknown as GatewayLink;
  // The spoken-reply supplement is a local route; an empty answer is what a box
  // that stores TTS inside `chat.history` returns. Cast because the adapter
  // takes the DOM shape and this double answers with the two fields it reads.
  const fetchImpl = (vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })) as unknown) as FetchLike;
  const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, link, fetchImpl);
  return { adapter, calls, request };
}

const texts = (page: { messages: Array<{ text: string }> }) => page.messages.map((m) => m.text);

describe("OpenClawGatewayAdapter chat.history deltas", () => {
  it("spends the cursor a page handed back, and merges the delta into those rows", async () => {
    const { adapter, calls } = adapterWith([
      { messages: [user("one", 1), assistant("two", 2)], deltaCursor: "delta:1" },
      {
        kind: "delta",
        messages: [
          { sessionKey: MAIN, messageId: "m3", message: assistant("three", 3) },
          { sessionKey: MAIN, messageId: "m4", message: user("four", 4) },
        ],
        deltaCursor: "delta:2",
      },
    ]);

    const first = await adapter.loadHistory();
    expect(texts(first)).toEqual(["one", "two"]);
    // The first read of a chat has no cursor to spend.
    expect(calls[0]).toEqual({ sessionKey: MAIN, limit: 50 });

    const second = await adapter.loadHistory();
    expect(calls[1]).toEqual({ sessionKey: MAIN, limit: 50, cursor: "delta:1" });
    // Envelopes unwrapped and appended: the whole transcript, projected once.
    expect(texts(second)).toEqual(["one", "two", "three", "four"]);
  });

  it("reads a page again when the gateway answers `reset`", async () => {
    const { adapter, calls } = adapterWith([
      { messages: [assistant("before the reset", 1)], deltaCursor: "delta:1" },
      { kind: "reset" },
      { messages: [assistant("after the reset", 2)], deltaCursor: "delta:9" },
    ]);

    await adapter.loadHistory();
    const page = await adapter.loadHistory();

    expect(texts(page)).toEqual(["after the reset"]);
    expect(calls[1]).toMatchObject({ cursor: "delta:1" });
    // The fallback asks WITHOUT the cursor — the gateway has said it cannot
    // continue from it, so asking again with it would only loop.
    expect(calls[2]).toEqual({ sessionKey: MAIN, limit: 50 });
  });

  it("retries without the cursor when a core that predates it refuses the parameter", async () => {
    const { adapter, calls } = adapterWith([
      { messages: [assistant("one", 1)], deltaCursor: "delta:1" },
      new Error("invalid params: unknown field cursor"),
      { messages: [assistant("one", 1), assistant("two", 2)] },
      { messages: [assistant("one", 1), assistant("two", 2)] },
    ]);
    await adapter.loadHistory();

    const page = await adapter.loadHistory();
    expect(texts(page)).toEqual(["one", "two"]);
    expect(calls[2]).toEqual({ sessionKey: MAIN, limit: 50 });

    // And it stays a plain page reader: the box never offered a new cursor.
    await adapter.loadHistory();
    expect(calls[3]).toEqual({ sessionKey: MAIN, limit: 50 });
  });

  it("keeps the base when the read itself failed, so the next delta still has rows", async () => {
    // A socket that went away between two appends is not a verdict on the
    // cursor: the rows already read are still the base, and clearing them would
    // turn the next read into a full page and lose nothing but bandwidth. The
    // retry-without-cursor path must not drop them on its way out either.
    const { adapter, calls } = adapterWith([
      { messages: [assistant("one", 1)], deltaCursor: "delta:1" },
      new Error("gateway went away"),
      new Error("gateway went away"),
      { kind: "delta", messages: [assistant("two", 2)], deltaCursor: "delta:2" },
    ]);
    await adapter.loadHistory();
    await expect(adapter.loadHistory()).rejects.toThrow(/gateway went away/);

    const page = await adapter.loadHistory();
    expect(calls[3]).toEqual({ sessionKey: MAIN, limit: 50, cursor: "delta:1" });
    expect(texts(page)).toEqual(["one", "two"]);
  });

  it("keeps reading pages on a gateway that offers no cursor at all", async () => {
    const { adapter, calls } = adapterWith([
      { messages: [assistant("one", 1)] },
      { messages: [assistant("one", 1)] },
    ]);

    await adapter.loadHistory();
    await adapter.loadHistory();

    expect(calls[0]).toEqual({ sessionKey: MAIN, limit: 50 });
    expect(calls[1]).toEqual({ sessionKey: MAIN, limit: 50 });
  });

  it("drops the base when the session is reset, so a cleared transcript cannot be grafted back", async () => {
    const { adapter, calls } = adapterWith([
      { messages: [assistant("cleared away", 1)], deltaCursor: "delta:1" },
      {},
      { messages: [], deltaCursor: "delta:7" },
    ]);

    await adapter.loadHistory();
    await adapter.resetSession();
    const page = await adapter.loadHistory();

    expect(calls[2]).toEqual({ sessionKey: MAIN, limit: 50 });
    // The rows from before the reset are gone rather than re-appearing as the
    // base a delta appends to.
    expect(texts(page)).toEqual([]);
  });
});
