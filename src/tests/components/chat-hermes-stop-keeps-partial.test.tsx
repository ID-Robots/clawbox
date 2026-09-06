import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * Stop keeps what the box had already written — on BOTH editions (TASK-721).
 *
 * The gateway path keeps it: its `aborted`/`error` branch reads
 * `dropUnfinishedDirective(streamingRef.current)` and appends it before
 * anything else. The ADAPTER path — the one a Hermes box runs, and the one the
 * dual SKU runs while Hermes is active — cleared the same buffer in
 * `dispatchTurn`'s catch and appended nothing, so pressing Stop mid-answer
 * threw the half-written reply away on one edition and kept it on the other.
 *
 * The behavioural test that pinned this for TASK-703 stubs the harness to
 * `openclaw`, so the Hermes half of "the interrupted turn is kept" was neither
 * implemented nor pinned. This is that half.
 */

const REPLY = "Half an answer before the owner pressed Stop.";

let releaseChunk: ((chunk: string | null) => void) | null = null;
/** A Hermes box runs no gateway; asserted, not merely counted. */
let socketsOpened = 0;

class ForbiddenWs {
  static readonly OPEN = 1;
  readyState = ForbiddenWs.OPEN;
  constructor() { socketsOpened += 1; }
  send() {}
  close() {}
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * An SSE Response whose chunks are handed out one `releaseChunk` at a time —
 * and which HONOURS the abort signal.
 *
 * That second half is the whole fixture. A fake reader that ignores the signal
 * turns Stop into "the stream ended without a `done` frame", which the adapter
 * reports as an UPSTREAM failure, not an abort — so a test written against it
 * exercises the error branch while claiming to test the abort branch, and a
 * "shows no error line" assertion passes over a DOM that contains one. A real
 * browser rejects the pending `read()` with an `AbortError` the moment the
 * fetch is aborted, and that is what this does.
 */
function pacedStream(signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
              const abort = () => {
                const err = new Error("The operation was aborted.");
                err.name = "AbortError";
                reject(err);
              };
              if (signal?.aborted) { abort(); return; }
              signal?.addEventListener("abort", abort, { once: true });
              releaseChunk = (chunk) =>
                chunk === null ? resolve({ done: true }) : resolve({ done: false, value: encoder.encode(chunk) });
            }),
        };
      },
    },
  } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
    }
    if (url.includes("/setup-api/chat/capabilities")) {
      return {
        ok: true,
        json: async () => ({
          harness: "hermes",
          facts: {
            hasClawaiToken: false,
            hermesSupportsImages: false,
            hermesHasVisionRoute: false,
            hermesStreamsTurns: true,
            hasClawaiImageRoute: false,
          },
        }),
      };
    }
    if (url.includes("/setup-api/hermes/models")) {
      return {
        ok: true,
        json: async () => ({
          providers: [{ id: "clawai", name: "ClawBox AI", authenticated: true }],
          models: [{ id: "deepseek-v4-flash", name: "Flash" }],
          provider: "clawai",
          current: "deepseek-v4-flash",
          defaultModel: "deepseek-v4-flash",
          reasoning: "off",
        }),
      };
    }
    if (url.includes("/setup-api/chat/model")) return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    if (url.includes("/setup-api/chat/spoken-history")) return { ok: true, json: async () => ({ items: [] }) };
    // A non-empty history: an empty one makes the popup auto-greet, and that
    // turn would take the paced stream this test is pacing by hand.
    if (url.includes("/setup-api/chat/history")) {
      return { ok: true, json: async () => ({ messages: [{ role: "assistant", text: "Earlier.", timestamp: 1 }] }) };
    }
    if (url.includes("/setup-api/hermes/chat")) return pacedStream(init?.signal);
    return { ok: true, json: async () => ({}) };
  }));
}

/** How many times `needle` appears in what is on screen. */
function occurrences(needle: string): number {
  return (document.body.textContent ?? "").split(needle).length - 1;
}

async function mount() {
  // Under StrictMode, so the "exactly once" case below actually pins the
  // TASK-703 regression: React double-invokes updaters there, and an append
  // moved back inside one would put the fragment on screen twice.
  render(
    <StrictMode>
      <ChatPopup isOpen onClose={() => {}} />
    </StrictMode>,
  );
  const textarea = await screen.findByRole("textbox");
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea;
}

async function send(textarea: HTMLElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(releaseChunk).not.toBeNull());
}

async function push(chunk: string | null) {
  await waitFor(() => expect(releaseChunk).not.toBeNull());
  const release = releaseChunk!;
  releaseChunk = null;
  release(chunk);
  await new Promise((r) => setTimeout(r, 0));
}

describe("Stop on a Hermes box", () => {
  beforeEach(() => {
    releaseChunk = null;
    socketsOpened = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    installFetch();
    vi.stubGlobal("WebSocket", ForbiddenWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessCache();
  });

  it("keeps the half-written reply, exactly once", async () => {
    const textarea = await mount();
    await send(textarea, "Tell me a story");
    await push(frame("delta", { text: REPLY }));
    await waitFor(() => expect(occurrences(REPLY)).toBe(1));

    // The Stop button, which is only on screen while a turn is running. It
    // aborts the adapter's fetch, the body's pending read rejects with an
    // `AbortError` exactly as a browser's does, and the turn ends as
    // `HarnessError('aborted')` — no `push` needed, and none given: a stream
    // this test ended by hand would be the OTHER failure (see the case below).
    fireEvent.click(screen.getByTitle("chat.stop"));

    // The turn is over — the streaming bubble is gone, so anything still on
    // screen is a transcript entry.
    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    expect(occurrences(REPLY)).toBe(1);
    // A Hermes box runs no gateway, and this surface must not have opened one.
    expect(socketsOpened).toBe(0);
  });

  it("keeps it above the failure line when the turn dies instead", async () => {
    // The same buffer, the other half of the gateway branch this now mirrors:
    // a turn that fails mid-answer keeps what was written and puts the notice
    // UNDER it, rather than losing the fragment and showing only the notice.
    const textarea = await mount();
    await send(textarea, "Tell me a story");
    await push(frame("delta", { text: REPLY }));
    await push(frame("error", { error: "hermes said no" }));
    await push(null);

    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    // Against the BUBBLES, not `document.body.textContent`: the popup ships a
    // large inline <style> block and a row of control labels, and a substring
    // search over the whole document would match "failed" in chrome — before
    // the transcript (a spurious ordering failure) or after it (a pass with no
    // notice ever appended, which is the shape this file exists to catch).
    const answer = await screen.findByText(REPLY);
    const notice = await screen.findByText(/^Error: /);
    expect(
      answer.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the failure notice came before the answer it interrupted",
    ).toBeTruthy();
  });

  it("shows no error line for a Stop the owner asked for", async () => {
    const textarea = await mount();
    await send(textarea, "Tell me a story");
    await push(frame("delta", { text: REPLY }));
    fireEvent.click(screen.getByTitle("chat.stop"));

    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    // No notice of ANY wording. The first cut of this file ended the stream by
    // hand instead of letting the abort reject the read, so the adapter
    // reported "The reply was cut off before it finished." and this assertion
    // passed straight over it.
    expect(screen.queryByText(/^Error: /)).toBeNull();
    expect(screen.queryByText(/did not go through|Stopped\./i)).toBeNull();
  });

  it("still says so when the stream ends without finishing and no Stop was pressed", async () => {
    // The case the abort fixture used to stand in for, kept as its own: a body
    // that closes with no `done` frame is a genuine failure and must still be
    // reported.
    const textarea = await mount();
    await send(textarea, "Tell me a story");
    await push(frame("delta", { text: REPLY }));
    await push(null);

    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    expect(await screen.findByText(/^Error: /)).toBeTruthy();
    expect(occurrences(REPLY)).toBe(1);
  });
});
