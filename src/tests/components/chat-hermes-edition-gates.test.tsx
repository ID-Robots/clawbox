import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import {
  HERMES_SESSION,
  installHermesBox,
  mountHermesChat,
  type HermesBox,
} from "@/tests/helpers/hermes-chat-box";
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
 * is the answer that can differ between two devices of the same edition.
 */

let box: HermesBox;

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
  const before = box.chatPosts.length;
  await waitFor(() => expect(textarea).not.toBeDisabled());
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(box.chatPosts.length).toBe(before + 1));
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  box = installHermesBox();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("what the composer offers when the box cannot do it", () => {
  it("offers no attach button where a staged file could not reach the model", async () => {
    // `hermesSupportsImages: false` on the box — the installed agent takes no
    // image on a turn, so staging one would put a chip on screen for a file the
    // model never sees.
    await mountHermesChat(box);
    expect(screen.queryByTitle("Attach file")).toBeNull();
  });

  it("offers no attach button where the picture would arrive but nothing could see it", async () => {
    // The half that shipped wrong. `hermes chat --image` exists on an unlinked
    // box, so the flag probe says yes — but with no `auxiliary.vision` model
    // configured, `image_routing.py` has no route to fall back to for a chat
    // model that is not vision-capable. Observed on the bench box: the file
    // reached the agent, the model reached for a `vision_analyze` tool that was
    // not there, and finally hand-wrote pixel-scanning code to answer at all.
    box.facts.hermesSupportsImages = true;
    box.facts.hermesHasVisionRoute = false;
    await mountHermesChat(box);
    expect(screen.queryByTitle("Attach file")).toBeNull();
  });

  it("DOES offer the attach button once the picture can both arrive and be seen", async () => {
    box.facts.hermesSupportsImages = true;
    box.facts.hermesHasVisionRoute = true;
    await mountHermesChat(box);
    await screen.findByTitle("Attach file");
  });

  it("offers no microphone on a box with no transcription credential", async () => {
    await mountHermesChat(box);
    // Not because of the edition — the transcription route is edition-neutral.
    // Because THIS device holds nothing to transcribe with.
    expect(screen.queryByTestId("voice-record")).toBeNull();
  });

  it("never opens a gateway socket on a box that runs no gateway", async () => {
    await mountHermesChat(box);
    expect(box.socketsOpened).toBe(0);
  });

  it("DOES offer the microphone once the same box is linked", async () => {
    // The inverse is the point. Nothing about the edition changed here — only
    // whether this device holds a credential — and that is what decides. A gate
    // written against the harness would keep a working microphone hidden.
    box.facts.hasClawaiToken = true;
    await mountHermesChat(box);
    await screen.findByTestId("voice-record");
  });
});

describe("pasting an image the turn could not carry", () => {
  it("stages nothing, rather than promising something and dropping it", async () => {
    const textarea = await mountHermesChat(box);

    pasteImage(textarea);
    // The upload is a fetch and the chip is painted from its response, so let
    // both settle rather than asserting on the frame the paste happened in.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The strip is the promise: a chip says "this went with your message". If
    // the turn cannot carry it, that chip is a lie the customer only discovers
    // from an answer that never looked at the picture.
    expect(box.fetchedUrls.some((u) => u.includes("/setup-api/chat/attachments"))).toBe(false);
    expect(screen.queryByTestId("chat-attachments")).toBeNull();
  });

  it("still lets the turn be typed and sent as text", async () => {
    const textarea = await mountHermesChat(box);

    pasteImage(textarea);
    await sendTurn(textarea, "what does this say?");

    // Refusing the picture must not disable the composer: the paste is ignored,
    // not swallowed along with the conversation.
    expect(box.chatPosts[0].message).toBe("what does this say?");
  });
});

describe("New chat where there is no gateway to reset", () => {
  it("clears the conversation without reaching for one", async () => {
    const textarea = await mountHermesChat(box);
    await sendTurn(textarea, "remember the number 41");
    await screen.findByText("hello back");

    fireEvent.click(screen.getByTestId("chat-new-tab"));

    await waitFor(() => expect(screen.queryByText("hello back")).toBeNull());
    expect(screen.queryByText("remember the number 41")).toBeNull();
    // `sessions.reset` is a gateway call. With no socket it could only ever
    // fail — and it did, with a red 'Not connected' banner over a conversation
    // that was never cleared.
    expect(screen.queryByText(/Could not start a new chat/)).toBeNull();
    expect(box.socketsOpened).toBe(0);
    // Forgetting has to reach the DISK too. Dropping only the session id would
    // make the agent forget while the screen refilled with the old conversation
    // on the next refresh — the two halves of "new chat" drifting apart.
    await waitFor(() => expect(box.transcriptDeletes).toBe(1));
  });

  it("makes the next turn a new session rather than a resumed one", async () => {
    const textarea = await mountHermesChat(box);
    await sendTurn(textarea, "remember the number 41");
    // The route echoes the session id; the next turn resumes it. That is the
    // whole of this conversation's memory.
    await sendTurn(textarea, "what was the number?");
    expect(box.chatPosts[1].sessionId).toBe(HERMES_SESSION);

    fireEvent.click(screen.getByTestId("chat-new-tab"));
    await waitFor(() => expect(screen.queryByText("hello back")).toBeNull());

    await sendTurn(textarea, "what was the number?");
    // Blanking the screen while the agent still holds the thread is the worst
    // outcome of the two: the customer believes the box forgot and it has not.
    expect(box.chatPosts[2]).not.toHaveProperty("sessionId");
  });
});

describe("the conversation surviving a refresh", () => {
  it("replays what the box recorded, on a harness with no socket to ask", async () => {
    // THE bug this fixes: a reload emptied the screen while the agent still
    // remembered the thread, so the customer's next message read as a non
    // sequitur to a conversation only one side could see.
    box.storedTranscript = [
      { role: "user", text: "remember the number 41", timestamp: 10 },
      { role: "assistant", text: "Noted — 41.", timestamp: 20 },
    ];
    await mountHermesChat(box);
    await screen.findByText("remember the number 41");
    await screen.findByText("Noted — 41.");
    // Replayed from the store, not from a gateway that is not there.
    expect(box.socketsOpened).toBe(0);
  });

  it("greets once on a genuinely first conversation, and completes the turn", async () => {
    // An empty transcript is the only "first conversation" signal there is now.
    // The greeting must also END: a harness that resolves with its reply has no
    // socket handler to paint it, so a greet that went straight to the adapter
    // left the composer disabled with a Stop button and nothing running.
    box.storedTranscript = [];
    const textarea = await mountHermesChat(box);
    await waitFor(() => expect(box.chatPosts.length).toBe(1));
    expect(box.chatPosts[0].message).toBe("hi");
    await screen.findByText("hello back");
    await waitFor(() => expect(textarea).not.toBeDisabled());
  });

  it("does not greet a conversation that already exists", async () => {
    await mountHermesChat(box);
    await screen.findByText("Earlier in this chat.");
    expect(box.chatPosts).toHaveLength(0);
  });
});

describe("a chat nobody has opened yet", () => {
  it("neither replays nor greets while the popup is closed", async () => {
    // The surface stays mounted behind the desktop, so an effect keyed only on
    // "the harness resolved" runs for a chat the owner has never opened. On an
    // empty transcript that ends in the auto-greet, which is a real turn: it
    // reaches the agent and is written into the stored conversation.
    box.storedTranscript = [];
    render(<ChatPopup isOpen={false} onClose={() => {}} />);

    await waitFor(() => {
      expect(box.fetchedUrls.some((u) => u.includes("/setup-api/harness/active"))).toBe(true);
    });
    // Give the replay effect every chance to misfire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(box.chatPosts).toEqual([]);
    expect(box.fetchedUrls.some((u) => u.includes("/setup-api/chat/history"))).toBe(false);
  });
});
