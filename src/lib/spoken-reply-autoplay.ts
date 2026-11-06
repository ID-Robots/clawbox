/**
 * Whether the desktop chat plays a TYPED question's reply by itself.
 *
 * A spoken question's reply always plays — asking aloud is asking to hear the
 * answer. A typed one, by default, gets its clip on the bubble to press, and
 * the owner's Settings → Voice → "Auto-play every spoken reply" switch
 * (`voice_auto_play_all`, src/lib/voice-reply.ts) turns that default around.
 * Pure, so the rule is pinned without mounting a chat
 * (src/tests/unit/spoken-reply-autoplay.test.ts); ChatPopup's `voiceReply` is
 * its one caller, and hands it everything it reads.
 */
export interface TypedReplyAutoPlay {
  /**
   * The reply closes a run the OWNER started from this composer: this tab's
   * own one-shot mark, already spent by the caller. A line the UI composed
   * (the opener, the New App handoff, Fix-My-Error), a reply re-delivered
   * after its mark was spent, a history load and a run another device started
   * all arrive without it.
   */
  asked: boolean
  /**
   * The reply is landing now, in the conversation on screen — not one picked
   * up on a return to a tab whose run finished while the owner was elsewhere.
   */
  live: boolean
  /**
   * The owner is at the chat as the reply lands: the popup open and its
   * browser tab the one on screen. A turn outlives both, and a reply that
   * finishes after the owner walked away is a clip to press, not a voice
   * talking to an empty room. (The chat asks again when the sound would
   * start; see ChatPopup's `onlyWithOwner`.)
   */
  present: boolean
  /** The owner's switch, as the box last stated it (off until it says otherwise). */
  autoPlayAll: boolean
  /**
   * The reply came with a clip of its own: Hermes' chat route attaches one,
   * a gateway can push its own, the agent can send an audio file.
   */
  hasClip: boolean
  /** The chat would make this reply a clip anyway (ChatPopup's `chatOwesAClip`). */
  owedAClip: boolean
}

export function typedReplyAutoPlays({ asked, live, present, autoPlayAll, hasClip, owedAClip }: TypedReplyAutoPlay): boolean {
  // Only ever a clip the reply would have had anyway: the switch decides
  // whether a clip PLAYS, never whether one is made, so it costs no synthesis.
  return autoPlayAll && asked && live && present && (hasClip || owedAClip)
}
