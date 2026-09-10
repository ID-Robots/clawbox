import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import { installHermesBox, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { DESKTOP_TRANSCRIPT_KEY } from "@/lib/harness/transcript-key";

/**
 * The FULL-PAGE chat on a box that runs no gateway.
 *
 * `/app/clawbox` is not a second-class surface: `ui-events.ts` documents it as
 * the page behind "Open in new tab" and the one a phone lands on. On the Hermes
 * edition it used to fetch `/setup-api/gateway/ws-config` and open an OpenClaw
 * websocket regardless of the harness, so the composer sat disabled behind
 * "Could not connect to gateway" for ever — while the mascot popup, which
 * resolves the harness through `useHarnessAdapter`, worked on the same box.
 *
 * Two chat implementations and only one of them harness-aware is what produced
 * that, so what is asserted here is the SHARED resolution: no ws-config, no
 * socket, a usable composer, and a turn that reaches the Hermes chat route.
 */

let box: HermesBox;

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom has no layout engine, so the transcript's auto-scroll has nothing to
  // call. Unrelated to what is under test.
  Element.prototype.scrollIntoView = vi.fn();
  box = installHermesBox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

/** Mount the full-page chat and hand back its composer, once it is usable. */
async function mountChatApp(): Promise<HTMLElement> {
  render(<ChatApp />);
  const textarea = await screen.findByRole("textbox");
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea;
}

/**
 * Mount and let every mount-effect request go out, without waiting on the
 * composer.
 *
 * The two "never" assertions below have to be able to FAIL with a diff rather
 * than time out: a surface that opens the socket does so from its mount effect,
 * so what they need is for that effect to have run, not for the chat to become
 * usable.
 */
async function mountAndSettle(): Promise<void> {
  render(<ChatApp />);
  await screen.findByRole("textbox");
  await waitFor(() => expect(box.fetchedUrls.length).toBeGreaterThan(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the full-page chat on the Hermes edition", () => {
  it("never asks for the gateway's websocket config", async () => {
    await mountAndSettle();
    expect(box.fetchedUrls.filter((u) => u.includes("/setup-api/gateway/ws-config"))).toEqual([]);
  });

  it("never opens a websocket on a box that runs no gateway", async () => {
    await mountAndSettle();
    expect(box.socketsOpened).toBe(0);
  });

  it("leaves the composer usable instead of disabled behind a connection error", async () => {
    const textarea = await mountChatApp();
    expect(textarea).not.toBeDisabled();
    expect(document.body.textContent).not.toContain("Could not connect to gateway");
  });

  it("sends a typed question to the harness and shows the answer", async () => {
    const textarea = await mountChatApp();

    fireEvent.change(textarea, { target: { value: "what are you running on?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(box.chatPosts.length).toBe(1));
    expect(box.chatPosts[0].message).toBe("what are you running on?");
    await waitFor(() => expect(document.body.textContent).toContain("hello back"));
  });

  it("replays the conversation the box stored, so a reload is not an empty screen", async () => {
    await mountChatApp();
    await waitFor(() => expect(document.body.textContent).toContain("Earlier in this chat."));
  });

  it("reads and writes the DESKTOP conversation, the one the mascot chat shows", async () => {
    // Asserted on the key this surface SENDS, not on the transcript it gets back:
    // the route and the fake both default a missing `sessionKey` to the desktop
    // thread, so the one line that binds it could be deleted with every other
    // case here still green — and the full page and the popup would silently
    // drift onto two different Hermes conversations.
    const textarea = await mountChatApp();
    await waitFor(() => expect(box.historyReads).toEqual([DESKTOP_TRANSCRIPT_KEY]));

    fireEvent.change(textarea, { target: { value: "still the same chat?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(box.chatPosts.length).toBe(1));
    expect(box.chatPosts[0].sessionKey).toBe(DESKTOP_TRANSCRIPT_KEY);
  });
});

/**
 * The attachment a turn NAMES, on both editions.
 *
 * Routing the send through the adapter moved this surface's pictures from
 * inline base64 on the socket to a file staged on the box and named by absolute
 * path — the shape `TurnRequest` carries, the shape the mascot chat has always
 * staged, and the shape the shared history projection reads back as a picture
 * (`[Attached file: …]`). So it is pinned here on both arms: nothing else in the
 * suite sends an attachment from this component.
 */
const STAGED_PATH = "/home/clawbox/.openclaw/media/uploads/paste-1.png";

/**
 * Answer the staging route on top of a box's existing stub.
 *
 * `record` is the same list the underlying stub appends to, and this wrapper
 * appends to it itself: a short-circuit that never reached the inner stub would
 * leave the staging POST out of the very list the assertions read.
 */
function stubStaging(record: string[]): void {
  const inner = globalThis.fetch as unknown as (i: unknown, init?: RequestInit) => Promise<unknown>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/chat/attachments")) {
        record.push(url);
        return { ok: true, status: 200, json: async () => ({ name: "paste-1.png", path: STAGED_PATH }) };
      }
      return inner(input, init);
    }),
  );
}

/** Ctrl+V of a screenshot, exactly as the mascot chat's own suites do it. */
function pasteImage(textarea: HTMLElement): void {
  const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });
  fireEvent.paste(textarea, {
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
  });
}

describe("what a turn carries on the Hermes edition", () => {
  it("names the staged file rather than inlining its bytes", async () => {
    // A box that can both CARRY a picture on the turn and LOOK at it — the two
    // facts `canAttachImages` is computed from.
    box.facts.hermesSupportsImages = true;
    box.facts.hermesHasVisionRoute = true;
    const textarea = await mountChatApp();
    stubStaging(box.fetchedUrls);

    pasteImage(textarea);
    await waitFor(() => {
      expect(box.fetchedUrls.some((u) => u.includes("/setup-api/chat/attachments"))).toBe(true);
    });
    // $HOME/uploads is outside the media allowlist either harness reads from —
    // going back to the Files API is the regression this pins.
    expect(box.fetchedUrls.some((u) => u.includes("/setup-api/files"))).toBe(false);

    fireEvent.change(textarea, { target: { value: "what is this?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(box.chatPosts.length).toBe(1));
    expect(box.chatPosts[0].imagePaths).toEqual([STAGED_PATH]);
    expect(box.chatPosts[0].message).toBe("what is this?");
  });

  it("stages nothing a box could not show the picture to the model with", async () => {
    // The same gate the mascot chat carries, and it has to be on the PASTE path
    // too: a chip that says "this went with your message" is a lie on a box that
    // cannot pass the file to the model, and the button being hidden is not a
    // gate on its own.
    box.facts.hermesSupportsImages = true;
    box.facts.hermesHasVisionRoute = false;
    const textarea = await mountChatApp();
    stubStaging(box.fetchedUrls);

    pasteImage(textarea);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(box.fetchedUrls.some((u) => u.includes("/setup-api/chat/attachments"))).toBe(false);
  });
});

describe("the full-page chat on the OpenClaw edition", () => {
  /** The gateway, answering the handshake and recording what it is sent. */
  class FakeGatewayWs {
    static readonly OPEN = 1;
    readyState = FakeGatewayWs.OPEN;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      gatewaySockets.push(this);
      setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
    }
    send(raw: string) {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame.type !== "req") return;
      sent.push(frame);
      const id = frame.id as string;
      const payload = frame.method === "connect"
        ? { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } }
        : {};
      setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
    }
    close() {
      this.readyState = 3;
    }
    addEventListener() {}
    removeEventListener() {}
    emit(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  let gatewaySockets: FakeGatewayWs[];
  let sent: Record<string, unknown>[];
  let fetched: string[];

  beforeEach(() => {
    gatewaySockets = [];
    sent = [];
    fetched = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        fetched.push(url);
        if (url.includes("/setup-api/harness/active")) {
          return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw", activeKnown: true }) };
        }
        if (url.includes("/setup-api/gateway/ws-config")) {
          return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  });

  it("still opens the gateway socket", async () => {
    // The other half of the rule: making this surface harness-aware must not
    // take the gateway away from the edition that runs one.
    render(<ChatApp />);
    await waitFor(() => expect(fetched.some((u) => u.includes("/setup-api/gateway/ws-config"))).toBe(true));
    await waitFor(() => expect(gatewaySockets.length).toBe(1));
  });

  it("names the staged file on the turn it sends", async () => {
    render(<ChatApp />);
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());
    stubStaging(fetched);

    pasteImage(textarea);
    await waitFor(() => expect(fetched.some((u) => u.includes("/setup-api/chat/attachments"))).toBe(true));

    fireEvent.change(textarea, { target: { value: "what is this?" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    const message = await waitFor(() => {
      const text = sent
        .filter((f) => f.method === "chat.send")
        .map((f) => String((f.params as { message?: unknown }).message ?? ""))
        .find((m) => m.includes("what is this?"));
      expect(text).toBeDefined();
      return text as string;
    });
    // The absolute staged path, which is what the gateway opens and what the
    // shared history projection reads back as a picture. It used to be base64
    // on the socket, which replayed as nothing at all.
    expect(message).toContain(`[Attached file: ${STAGED_PATH}]`);
    // …and the BYTES are not on the wire any more. The base64 shape rather than
    // a string this test could never produce: inlining is what the turn used to
    // do, and it is what a revert would bring back.
    expect(message).not.toMatch(/[A-Za-z0-9+/]{100,}={0,2}/);
  });
});
