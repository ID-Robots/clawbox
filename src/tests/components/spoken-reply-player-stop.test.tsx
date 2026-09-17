import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import SpokenReplyPlayer, { resetSpokenReplyPeakCache } from "@/components/SpokenReplyPlayer";
import { _resetSpokenReplyPlaybackForTests, claimSpokenReply } from "@/lib/spoken-reply-playback";

/**
 * Stop, and one reply at a time, on the player itself.
 *
 * Every surface that shows a spoken reply draws this component, so the rules
 * pinned here hold on the mascot chat, the full-page chat and the Voice tab
 * alike: a Stop control while a reply speaks, which silences it and puts it
 * back to the start; a second reply started over the first stops the first;
 * and the chat's own automatic playback — a separate element — is stoppable
 * from the bubble it belongs to.
 */

const MEDIA = window.HTMLMediaElement.prototype;
const saved: Array<[string, PropertyDescriptor | undefined]> = [];
const paused = new WeakMap<HTMLMediaElement, boolean>();
const clocks = new WeakMap<HTMLMediaElement, number>();

function stubMedia() {
  for (const name of ["play", "pause", "paused", "currentTime", "duration"]) {
    saved.push([name, Object.getOwnPropertyDescriptor(MEDIA, name)]);
  }
  Object.defineProperty(MEDIA, "duration", { configurable: true, get() { return 12; } });
  Object.defineProperty(MEDIA, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) { return paused.get(this) !== false; },
  });
  Object.defineProperty(MEDIA, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) { return clocks.get(this) ?? 0; },
    set(this: HTMLMediaElement, value: number) { clocks.set(this, value); this.dispatchEvent(new Event("timeupdate")); },
  });
  Object.defineProperty(MEDIA, "play", {
    configurable: true,
    value: vi.fn(async function (this: HTMLMediaElement) {
      paused.set(this, false);
      this.dispatchEvent(new Event("play"));
    }),
  });
  Object.defineProperty(MEDIA, "pause", {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      if (paused.get(this) === false) {
        paused.set(this, true);
        this.dispatchEvent(new Event("pause"));
      }
    }),
  });
}

const isPlaying = (el: HTMLMediaElement) => paused.get(el) === false;

function twoReplies() {
  render(
    <div>
      <div data-testid="first"><SpokenReplyPlayer src="/clip-a.wav" label="A" downloadName="a.wav" /></div>
      <div data-testid="second"><SpokenReplyPlayer src="/clip-b.wav" label="B" downloadName="b.wav" /></div>
    </div>,
  );
  const part = (id: string) => {
    const root = within(screen.getByTestId(id));
    return {
      audio: root.getByTestId("chat-audio") as HTMLAudioElement,
      play: () => root.getByTestId("spoken-reply-play"),
      maybePlay: () => root.queryByTestId("spoken-reply-play"),
      stop: () => root.queryByTestId("spoken-reply-stop"),
    };
  };
  return { a: part("first"), b: part("second") };
}

describe("stopping a spoken reply", () => {
  beforeEach(() => {
    resetSpokenReplyPeakCache();
    _resetSpokenReplyPlaybackForTests();
    stubMedia();
  });

  afterEach(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(MEDIA, name, descriptor);
      else delete (MEDIA as unknown as Record<string, unknown>)[name];
    }
    saved.length = 0;
    _resetSpokenReplyPlaybackForTests();
  });

  it("shows Stop only while the reply plays, and stops it back to the start", async () => {
    const { a } = twoReplies();
    expect(a.stop()).toBeNull();
    fireEvent.click(a.play());
    await waitFor(() => expect(a.stop()).not.toBeNull());
    expect(a.stop()).toHaveAccessibleName("chat.audioStop A");
    act(() => { a.audio.currentTime = 7; });

    fireEvent.click(a.stop()!);
    expect(isPlaying(a.audio)).toBe(false);
    expect(a.audio.currentTime).toBe(0);
    await waitFor(() => expect(a.stop()).toBeNull());
    expect(a.play()).toHaveAccessibleName("chat.audioPlay A");
  });

  it("never lets two replies talk at once: starting one stops the other", async () => {
    const { a, b } = twoReplies();
    fireEvent.click(a.play());
    await waitFor(() => expect(isPlaying(a.audio)).toBe(true));
    act(() => { a.audio.currentTime = 4; });

    fireEvent.click(b.play());
    await waitFor(() => expect(isPlaying(b.audio)).toBe(true));
    expect(isPlaying(a.audio)).toBe(false);
    // Stopped, not paused: pressing it again starts from its first word.
    expect(a.audio.currentTime).toBe(0);
    await waitFor(() => expect(a.stop()).toBeNull());
    expect(b.stop()).not.toBeNull();
  });

  it("stops the chat's automatic playback of its clip from the bubble", async () => {
    const { a, b } = twoReplies();
    const automatic = new Audio("/clip-a.wav");
    act(() => {
      claimSpokenReply(automatic, "/clip-a.wav", { automatic: true, detached: true });
      void automatic.play();
    });
    // The bubble for THAT clip offers Stop — and ONLY Stop, because that
    // element's position is the chat queue's and no pause here could be
    // honoured. The other bubble is untouched.
    await waitFor(() => expect(a.stop()).not.toBeNull());
    expect(a.stop()).toHaveAccessibleName("chat.audioStop A");
    expect(a.maybePlay()).toBeNull();
    expect(b.stop()).toBeNull();
    expect(b.maybePlay()).not.toBeNull();

    fireEvent.click(a.stop()!);
    expect(isPlaying(automatic)).toBe(false);
    expect(automatic.currentTime).toBe(0);
    await waitFor(() => expect(a.stop()).toBeNull());
    // The transport comes back, and the bubble's own player plays the reply
    // again from its first word.
    fireEvent.click(a.play());
    await waitFor(() => expect(isPlaying(a.audio)).toBe(true));
    expect(a.audio.currentTime).toBe(0);
  });
});
