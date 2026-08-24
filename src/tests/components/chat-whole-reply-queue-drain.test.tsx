import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The second message on a harness whose reply lands WHOLE.
 *
 * TASK-517 gave the composer a synchronous mirror of `sending` — `sendingRef` —
 * because the render-time closure lags a commit behind, and deciding from it
 * let a second run start on top of a live one. Every completion path therefore
 * has to clear that mirror, or the guard inverts: instead of stopping a second
 * concurrent run it stops EVERY later run, because the drain effect and both
 * send handlers only ever proceed while the ref says idle.
 *
 * The existing starvation test pins the gateway edition, where a turn is merely
 * ACKNOWLEDGED and the socket's `final`/`error` handlers end the run. This one
 * pins the other half of the unified send path: a harness that answers whole,
 * where `dispatchTurn` itself both paints the reply and ends the run. Leave the
 * mirror set there and the queue parks forever — the box takes the next message,
 * shows it in the transcript, and never sends it.
 */

/** Bodies POSTed to the Hermes chat route, in order. */
let chatPosts: Record<string, unknown>[] = [];
/** Every URL the surface fetched. */
let fetchedUrls: string[] = [];

class ForbiddenWs {
  static readonly OPEN = 1;
  readyState = ForbiddenWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/chat/capabilities")) {
        return {
          ok: true,
          json: async () => ({
            harness: "hermes",
            facts: { hasClawaiToken: false, hermesSupportsImages: false },
          }),
        };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: "clawlocal", name: "On this box", authenticated: true }],
            models: [{ id: "gemma", name: "Gemma" }],
            provider: "clawlocal",
            current: "gemma",
            defaultModel: "gemma",
            reasoning: "off",
          }),
        };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      if (url.includes("/setup-api/chat/spoken-history")) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        chatPosts.push(body);
        // Answers whole — no event stream, no `acknowledgedOnly`.
        return {
          ok: true,
          json: async () => ({ text: `reply to ${String(body.message)}`, sessionId: "s1" }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function mountHermes() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  const textarea = await screen.findByRole("textbox");
  await waitFor(() => {
    expect(fetchedUrls.some((u) => u.includes("/setup-api/hermes/models"))).toBe(true);
  });
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea;
}

function type(textarea: HTMLElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
}

beforeEach(() => {
  chatPosts = [];
  fetchedUrls = [];
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  installFetch();
  vi.stubGlobal("WebSocket", ForbiddenWs as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("a reply that lands whole still releases the queue", () => {
  /**
   * Messages this surface actually POSTed, in order.
   *
   * A box whose transcript is empty opens the conversation itself, so the
   * first body on the wire can be that greeting rather than anything typed
   * here — and whether it appears depends on what the edition can replay, not
   * on what this test is pinning. Asserting on CONTENT rather than on counts
   * keeps the test about the queue and lets the greeting be present or absent.
   */
  const posted = () => chatPosts.map((p) => String(p.message));

  it("sends the NEXT message after a completed whole reply (TASK-517)", async () => {
    const textarea = await mountHermes();

    type(textarea, "first");
    await waitFor(() => expect(posted()).toContain("first"), { timeout: 5000 });
    // The turn is genuinely over: its answer is on screen, which only happens
    // on the success path that has to clear the guard.
    await screen.findByText("reply to first", undefined, { timeout: 5000 });

    type(textarea, "second");

    // The real regression: with the mirror left set, "second" is accepted into
    // the transcript and then parked forever, so it never reaches the wire.
    await waitFor(() => expect(posted()).toContain("second"), { timeout: 5000 });
    await screen.findByText("reply to second", undefined, { timeout: 5000 });
  });

  it("keeps draining turn after turn, not just the one after the first", async () => {
    const textarea = await mountHermes();
    for (const line of ["one", "two", "three"]) {
      type(textarea, line);
      await screen.findByText(`reply to ${line}`, undefined, { timeout: 5000 });
    }
    // Order matters as much as arrival: a queue that drained out of sequence
    // would answer the wrong question first.
    expect(posted().slice(-3)).toEqual(["one", "two", "three"]);
  });
});
