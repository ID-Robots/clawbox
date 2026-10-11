import { describe, expect, it } from "vitest";
import { typedReplyAutoPlays, type TypedReplyAutoPlay } from "@/lib/spoken-reply-autoplay";

/**
 * The chat's play decision for a TYPED question's reply
 * (src/lib/spoken-reply-autoplay.ts, called by ChatPopup's `voiceReply`).
 *
 * By default a typed question's reply gets a clip to press and is not played;
 * Settings → Voice → "Auto-play every spoken reply" plays it by itself, the
 * way a spoken question's reply plays. Pinned here: what the switch widens,
 * and every way a reply that must NOT start talking reaches the decision.
 * The flows themselves — the clip made, played once, the history never — are
 * pinned against the real chat in chat-voice-reply.test.tsx.
 */

/** The reply to a question the owner typed, landing live, on a box where the chat makes the clip. */
const typedLive: TypedReplyAutoPlay = { asked: true, live: true, present: true, autoPlayAll: true, hasClip: false, owedAClip: true };

describe("typedReplyAutoPlays", () => {
  it("plays a typed question's reply once the owner switched auto-play on", () => {
    // OpenClaw: no clip on the reply, the chat makes one.
    expect(typedReplyAutoPlays(typedLive)).toBe(true);
    // Hermes: the chat route attached the clip; the chat asks for nothing.
    expect(typedReplyAutoPlays({ ...typedLive, hasClip: true, owedAClip: false })).toBe(true);
  });

  it("leaves it on its player while the switch is off — the default", () => {
    expect(typedReplyAutoPlays({ ...typedLive, autoPlayAll: false })).toBe(false);
    expect(typedReplyAutoPlays({ ...typedLive, autoPlayAll: false, hasClip: true, owedAClip: false })).toBe(false);
  });

  it("never plays a reply this tab did not ask for", () => {
    // `asked` false: the chat's opener and the UI's own lines, a final the
    // gateway re-delivers after the mark was spent, a reconnect or history
    // load, and a run another browser tab or device started.
    expect(typedReplyAutoPlays({ ...typedLive, asked: false })).toBe(false);
    expect(typedReplyAutoPlays({ ...typedLive, asked: false, hasClip: true, owedAClip: false })).toBe(false);
  });

  it("never plays a reply picked up on a return to the tab it finished in", () => {
    // It landed while the owner was in another conversation: it keeps its
    // player and waits to be pressed.
    expect(typedReplyAutoPlays({ ...typedLive, live: false })).toBe(false);
    expect(typedReplyAutoPlays({ ...typedLive, live: false, hasClip: true, owedAClip: false })).toBe(false);
  });

  it("never plays a reply that lands after the owner left the chat", () => {
    // The popup closed, or its browser tab hidden, while the turn ran: the
    // reply keeps its clip to press.
    expect(typedReplyAutoPlays({ ...typedLive, present: false })).toBe(false);
    expect(typedReplyAutoPlays({ ...typedLive, present: false, hasClip: true, owedAClip: false })).toBe(false);
  });

  it("asks for no sound the reply would not have had anyway", () => {
    // No clip on the reply and none owed — a box that said it has no voice,
    // a Hermes box that attached none: the switch makes nothing up.
    expect(typedReplyAutoPlays({ ...typedLive, hasClip: false, owedAClip: false })).toBe(false);
  });
});
