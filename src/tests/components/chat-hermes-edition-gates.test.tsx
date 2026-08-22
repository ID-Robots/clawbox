import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * What the composer offers on a box that runs no gateway.
 *
 * `status === 'connected'` is useless as a gate here: a harness with no socket
 * reports itself connected so the composer is usable at all. Two controls were
 * therefore correct only by accident and two were plainly wrong — the attach
 * button and the microphone tested the harness, while Ctrl+V and the (+) button
 * did not.
 *
 * None of them test the harness any more. Each asks what this box can do, which
 * is the answer that can differ between two devices of the same edition: the
 * one below holds no ClawBox AI credential, so it cannot transcribe and says so
 * by not offering a microphone. Link one and the same code offers it.
 */

const HERMES_SESSION = "20260810_221825_609d1e";

/** Bodies POSTed to the Hermes chat route, in order. */
let chatPosts: Record<string, unknown>[] = [];
/** Every URL the surface fetched, so an upload can be asserted absent. */
let fetchedUrls: string[] = [];
/** Constructed WebSockets. A box with no gateway must never open one. */
let socketsOpened = 0;
/** Whether this box holds a ClawBox AI credential — the microphone's real gate. */
let hasClawaiToken = false;
/**
 * What the durable transcript holds. A NON-empty one by default, because an
 * empty transcript is the "first conversation" signal that fires the auto-greet
 * — real behaviour, tested on its own below, and noise in every other test here.
 */
let storedTranscript: Record<string, unknown>[] = [];
/** Whether the installed `hermes` takes `chat --image` — the attach button's gate. */
let hermesSupportsImages = false;
/** DELETEs of the stored transcript, so "new chat" can be shown to reach it. */
let transcriptDeletes = 0;

class ForbiddenWs {
  static readonly OPEN = 1;
  readyState = ForbiddenWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    socketsOpened += 1;
  }
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
            facts: { hasClawaiToken, hermesSupportsImages },
          }),
        };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: "clawlocal", name: "On this box", authenticated: true }],
            // The scoped form of this route (?provider=…) answers the model
            // pill; one model means no pill, which is the plain case here.
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
      if (url.includes("/setup-api/chat/history")) {
        if (init?.method === "DELETE") {
          transcriptDeletes += 1;
          storedTranscript = [];
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ messages: storedTranscript }) };
      }
      if (url.includes("/setup-api/hermes/chat")) {
        chatPosts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return { ok: true, json: async () => ({ text: "hello back", sessionId: HERMES_SESSION }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

async function mountHermes() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  const textarea = await screen.findByRole("textbox");
  // The harness resolves through a fetch; until it lands the surface still
  // assumes the gateway and the gates under test are not in force yet. Seeding
  // the Hermes header is the one thing only this path does, so it is the signal
  // that the mode really switched — waiting on the attach button to vanish
  // would also "pass" if the button were never rendered at all.
  await waitFor(() => {
    expect(fetchedUrls.some((u) => u.includes("/setup-api/hermes/models"))).toBe(true);
  });
  await waitFor(() => expect(textarea).not.toBeDisabled());
  return textarea;
}

/** Ctrl+V of a screenshot, exactly as the gateway-mode staging test does it. */
function pasteImage(textarea: HTMLElement) {
  const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    },
  });
}

async function sendTurn(textarea: HTMLElement, text: string) {
  const before = chatPosts.length;
  await waitFor(() => expect(textarea).not.toBeDisabled());
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(chatPosts.length).toBe(before + 1));
}

beforeEach(() => {
  chatPosts = [];
  fetchedUrls = [];
  socketsOpened = 0;
  // The default box below is a customer on their own provider key: no ClawBox
  // AI credential, so nothing on it can turn a recording into text.
  hasClawaiToken = false;
  hermesSupportsImages = false;
  storedTranscript = [{ role: "assistant", text: "Earlier in this chat.", timestamp: 1 }];
  transcriptDeletes = 0;
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

describe("what the composer offers when the box cannot do it", () => {
  it("offers no attach button where a staged file could not reach the model", async () => {
    // `hermesSupportsImages: false` in the capabilities mock — the installed
    // agent takes no image on a turn, so staging one would put a chip on screen
    // for a file the model never sees.
    await mountHermes();
    expect(screen.queryByTitle("Attach file")).toBeNull();
  });

  it("DOES offer the attach button once the installed agent can take an image", async () => {
    hermesSupportsImages = true;
    await mountHermes();
    await screen.findByTitle("Attach file");
  });

  it("offers no microphone on a box with no transcription credential", async () => {
    await mountHermes();
    // Not because of the edition — the transcription route is edition-neutral.
    // Because THIS device holds nothing to transcribe with.
    expect(screen.queryByTestId("voice-record")).toBeNull();
  });

  it("never opens a gateway socket on a box that runs no gateway", async () => {
    await mountHermes();
    expect(socketsOpened).toBe(0);
  });

  it("DOES offer the microphone once the same box is linked", async () => {
    // The inverse is the point. Nothing about the edition changed here — only
    // whether this device holds a credential — and that is what decides. A gate
    // written against the harness would keep a working microphone hidden.
    hasClawaiToken = true;
    await mountHermes();
    await screen.findByTestId("voice-record");
  });
});

describe("pasting an image the turn could not carry", () => {
  it("stages nothing, rather than promising something and dropping it", async () => {
    const textarea = await mountHermes();

    pasteImage(textarea);
    // The upload is a fetch and the chip is painted from its response, so let
    // both settle rather than asserting on the frame the paste happened in.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The strip is the promise: a chip says "this went with your message". If
    // the turn cannot carry it, that chip is a lie the customer only discovers
    // from an answer that never looked at the picture.
    expect(fetchedUrls.some((u) => u.includes("/setup-api/chat/attachments"))).toBe(false);
    expect(screen.queryByTestId("chat-attachments")).toBeNull();
  });

  it("still lets the turn be typed and sent as text", async () => {
    const textarea = await mountHermes();

    pasteImage(textarea);
    await sendTurn(textarea, "what does this say?");

    // Refusing the picture must not disable the composer: the paste is ignored,
    // not swallowed along with the conversation.
    expect(chatPosts[0].message).toBe("what does this say?");
  });
});

describe("New chat where there is no gateway to reset", () => {
  it("clears the conversation without reaching for one", async () => {
    const textarea = await mountHermes();
    await sendTurn(textarea, "remember the number 41");
    await screen.findByText("hello back");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.queryByText("hello back")).toBeNull());
    expect(screen.queryByText("remember the number 41")).toBeNull();
    // `sessions.reset` is a gateway call. With no socket it could only ever
    // fail — and it did, with a red 'Not connected' banner over a conversation
    // that was never cleared.
    expect(screen.queryByText(/Could not start a new chat/)).toBeNull();
    expect(socketsOpened).toBe(0);
    // Forgetting has to reach the DISK too. Dropping only the session id would
    // make the agent forget while the screen refilled with the old conversation
    // on the next refresh — the two halves of "new chat" drifting apart.
    await waitFor(() => expect(transcriptDeletes).toBe(1));
  });

  it("makes the next turn a new session rather than a resumed one", async () => {
    const textarea = await mountHermes();
    await sendTurn(textarea, "remember the number 41");
    // The route echoes the session id; the next turn resumes it. That is the
    // whole of this conversation's memory.
    await sendTurn(textarea, "what was the number?");
    expect(chatPosts[1].sessionId).toBe(HERMES_SESSION);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.queryByText("hello back")).toBeNull());

    await sendTurn(textarea, "what was the number?");
    // Blanking the screen while the agent still holds the thread is the worst
    // outcome of the two: the customer believes the box forgot and it has not.
    expect(chatPosts[2]).not.toHaveProperty("sessionId");
  });
});

describe("the conversation surviving a refresh", () => {
  it("replays what the box recorded, on a harness with no socket to ask", async () => {
    // THE bug this fixes: a reload emptied the screen while the agent still
    // remembered the thread, so the customer's next message read as a non
    // sequitur to a conversation only one side could see.
    storedTranscript = [
      { role: "user", text: "remember the number 41", timestamp: 10 },
      { role: "assistant", text: "Noted — 41.", timestamp: 20 },
    ];
    await mountHermes();
    await screen.findByText("remember the number 41");
    await screen.findByText("Noted — 41.");
    // Replayed from the store, not from a gateway that is not there.
    expect(socketsOpened).toBe(0);
  });

  it("greets once on a genuinely first conversation, and completes the turn", async () => {
    // An empty transcript is the only "first conversation" signal there is now.
    // The greeting must also END: a harness that resolves with its reply has no
    // socket handler to paint it, so a greet that went straight to the adapter
    // left the composer disabled with a Stop button and nothing running.
    storedTranscript = [];
    const textarea = await mountHermes();
    await waitFor(() => expect(chatPosts.length).toBe(1));
    expect(chatPosts[0].message).toBe("hi");
    await screen.findByText("hello back");
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  it("does not greet a conversation that already exists", async () => {
    await mountHermes();
    await screen.findByText("Earlier in this chat.");
    expect(chatPosts).toHaveLength(0);
  });
});
