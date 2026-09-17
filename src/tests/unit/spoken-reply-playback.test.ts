import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetSpokenReplyPlaybackForTests,
  claimSpokenReply,
  currentSpokenReply,
  releaseSpokenReply,
  spokenReplyInterruptions,
  stopSpokenReply,
  subscribeSpokenReply,
} from "@/lib/spoken-reply-playback";

function fakeElement() {
  return { pause: vi.fn(), currentTime: 9 } as unknown as HTMLAudioElement & { pause: ReturnType<typeof vi.fn> };
}

describe("the document's one spoken-reply speaker", () => {
  afterEach(() => _resetSpokenReplyPlaybackForTests());

  it("a new claim stops and rewinds the previous holder", () => {
    const a = fakeElement();
    const b = fakeElement();
    claimSpokenReply(a, "a");
    claimSpokenReply(b, "b");
    expect(a.pause).toHaveBeenCalled();
    expect(a.currentTime).toBe(0);
    expect(currentSpokenReply()).toEqual({ src: "b", element: b, detached: false });
  });

  it("only the holder can release", () => {
    const a = fakeElement();
    const b = fakeElement();
    claimSpokenReply(a, "a");
    claimSpokenReply(b, "b");
    releaseSpokenReply(a);
    expect(currentSpokenReply()?.element).toBe(b);
    releaseSpokenReply(b);
    expect(currentSpokenReply()).toBeNull();
  });

  it("a named stop silences only that clip", () => {
    const a = fakeElement();
    claimSpokenReply(a, "a");
    expect(stopSpokenReply("other")).toBe(false);
    expect(a.pause).not.toHaveBeenCalled();
    expect(stopSpokenReply("a")).toBe(true);
    expect(a.pause).toHaveBeenCalled();
    expect(a.currentTime).toBe(0);
    expect(currentSpokenReply()).toBeNull();
  });

  it("counts a person cutting in, never the chat's own queue", () => {
    const a = fakeElement();
    const b = fakeElement();
    const start = spokenReplyInterruptions();
    claimSpokenReply(a, "a", { automatic: true });
    claimSpokenReply(b, "b", { automatic: true });
    expect(spokenReplyInterruptions()).toBe(start);
    claimSpokenReply(a, "a");
    expect(spokenReplyInterruptions()).toBe(start + 1);
    // Moving on (a new prompt) counts even with nothing sounding.
    stopSpokenReply("a");
    stopSpokenReply();
    expect(spokenReplyInterruptions()).toBe(start + 3);
  });

  it("records whether the element is the chat's own detached one", () => {
    // What a bubble may OFFER for the clip: a detached element's position is
    // the chat queue's, so the bubble draws Stop and no pause for it.
    const own = fakeElement();
    const chats = fakeElement();
    claimSpokenReply(own, "a");
    expect(currentSpokenReply()?.detached).toBe(false);
    claimSpokenReply(chats, "b", { automatic: true, detached: true });
    expect(currentSpokenReply()?.detached).toBe(true);
  });

  it("tells subscribers when the speaker changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpokenReply(listener);
    const a = fakeElement();
    claimSpokenReply(a, "a");
    stopSpokenReply();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    claimSpokenReply(a, "a");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
