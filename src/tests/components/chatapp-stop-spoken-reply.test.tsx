import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import { installHermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import {
  _resetSpokenReplyPlaybackForTests,
  claimSpokenReply,
  currentSpokenReply,
} from "@/lib/spoken-reply-playback";

/**
 * The FULL-PAGE chat and the one speaker (TASK-890).
 *
 * `/app/clawbox` is the surface behind "Open in new tab" and the one a phone
 * lands on, and it is a second chat implementation — which is exactly how it
 * came to sit behind a dead gateway banner on Hermes once before. So the rule
 * that a new prompt silences the answer still talking is pinned HERE too, not
 * only on the mascot popup: the two surfaces share `spoken-reply-playback.ts`
 * and must not drift into one of them leaving the old reply speaking over the
 * new question.
 */

describe("the full-page chat stops a spoken reply", () => {
  beforeEach(() => {
    resetHarnessCache();
    window.localStorage.clear();
    // jsdom has no layout engine; the transcript's auto-scroll has nothing to
    // call. Unrelated to what is under test.
    Element.prototype.scrollIntoView = vi.fn();
    installHermesBox();
    _resetSpokenReplyPlaybackForTests();
  });

  afterEach(() => {
    _resetSpokenReplyPlaybackForTests();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("silences the reply still speaking when the owner sends a new prompt", async () => {
    render(<ChatApp />);
    const textarea = await screen.findByRole("textbox");
    await waitFor(() => expect(textarea).not.toBeDisabled());

    const speaking = { pause: vi.fn(), currentTime: 6 } as unknown as HTMLAudioElement;
    claimSpokenReply(speaking, "/clip.wav", { automatic: true, detached: true });

    fireEvent.change(textarea, { target: { value: "and tomorrow?" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(speaking.pause).toHaveBeenCalled();
    // Back to the start: the bubble keeps its clip and plays it from the first
    // word, and nothing holds the speaker for the answer about to arrive.
    expect(speaking.currentTime).toBe(0);
    expect(currentSpokenReply()).toBeNull();
  });
});
