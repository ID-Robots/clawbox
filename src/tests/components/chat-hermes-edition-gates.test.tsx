import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
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
 * is the answer that can differ between two devices of the same edition: the
 * one below holds no ClawBox AI credential, so it cannot transcribe and says so
 * by not offering a microphone. Link one and the same code offers it.
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
    await mountHermesChat(box);
    expect(screen.queryByTitle("Attach file")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(screen.queryByText("hello back")).toBeNull());
    expect(screen.queryByText("remember the number 41")).toBeNull();
    // `sessions.reset` is a gateway call. With no socket it could only ever
    // fail — and it did, with a red 'Not connected' banner over a conversation
    // that was never cleared.
    expect(screen.queryByText(/Could not start a new chat/)).toBeNull();
    expect(box.socketsOpened).toBe(0);
  });

  it("makes the next turn a new session rather than a resumed one", async () => {
    const textarea = await mountHermesChat(box);
    await sendTurn(textarea, "remember the number 41");
    // The route echoes the session id; the next turn resumes it. That is the
    // whole of this conversation's memory.
    await sendTurn(textarea, "what was the number?");
    expect(box.chatPosts[1].sessionId).toBe(HERMES_SESSION);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.queryByText("hello back")).toBeNull());

    await sendTurn(textarea, "what was the number?");
    // Blanking the screen while the agent still holds the thread is the worst
    // outcome of the two: the customer believes the box forgot and it has not.
    expect(box.chatPosts[2]).not.toHaveProperty("sessionId");
  });
});
