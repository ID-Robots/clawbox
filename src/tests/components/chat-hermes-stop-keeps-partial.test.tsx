import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const HERMES_SESSION = "20260906_104200_a1b2c3";

let releaseChunk: ((chunk: string | null) => void) | null = null;
/** A Hermes box runs no gateway; this must stay 0. */
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

/** An SSE Response whose chunks are handed out one `releaseChunk` at a time. */
function pacedStream(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              releaseChunk = (chunk) =>
                chunk === null ? resolve({ done: true }) : resolve({ done: false, value: encoder.encode(chunk) });
            }),
        };
      },
    },
  } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
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
    if (url.includes("/setup-api/hermes/chat")) return pacedStream();
    return { ok: true, json: async () => ({}) };
  }));
}

/** How many times `needle` appears in what is on screen. */
function occurrences(needle: string): number {
  return (document.body.textContent ?? "").split(needle).length - 1;
}

async function mount() {
  render(<ChatPopup isOpen onClose={() => {}} />);
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

    // The Stop button, which is only on screen while a turn is running.
    fireEvent.click(screen.getByTitle("chat.stop"));
    // The route kills the child and closes the body; the adapter then sees its
    // controller aborted and rejects the turn with `HarnessError('aborted')`.
    await push(null);

    // The turn is over — the streaming bubble is gone, so anything still on
    // screen is a transcript entry.
    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    expect(occurrences(REPLY)).toBe(1);
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
    const rendered = document.body.textContent ?? "";
    const reply = rendered.indexOf(REPLY);
    // The failure notice, whatever its wording — the surface sanitises the
    // harness's own text rather than rendering it (TASK-440).
    const notice = rendered.search(/Error:|did not go through|could not|failed|try again/i);
    expect(reply, `the interrupted answer was not kept:\n${rendered}`).toBeGreaterThan(-1);
    expect(notice, `no failure notice was shown:\n${rendered}`).toBeGreaterThan(-1);
    expect(reply, `the notice came before the answer:\n${rendered}`).toBeLessThan(notice);
  });

  it("shows no error line for a Stop the owner asked for", async () => {
    const textarea = await mount();
    await send(textarea, "Tell me a story");
    await push(frame("delta", { text: REPLY }));
    fireEvent.click(screen.getByTitle("chat.stop"));
    await push(null);

    await waitFor(() => expect(screen.queryByTitle("chat.stop")).toBeNull());
    expect(document.body.textContent).not.toMatch(/did not go through|Stopped\./i);
  });
});
