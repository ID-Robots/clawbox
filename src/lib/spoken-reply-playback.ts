/**
 * One spoken reply at a time, for the whole document.
 *
 * A reply reaches the speaker two ways: the chat's automatic playback (a
 * detached `new Audio(src)` in ChatPopup, because the bubble it belongs to may
 * not be painted yet) and the bubble's own player (SpokenReplyPlayer). Neither
 * knew about the other, so pressing a second bubble talked over the first, a
 * reply played automatically could not be stopped from the bubble that showed
 * it — the bubble still read "play" — and sending a new prompt left the old
 * answer talking over the new question.
 *
 * Every element that starts making sound CLAIMS the speaker here, which pauses
 * whatever held it. The registry remembers the clip by the `src` the caller
 * names (the bubble's own URL, never the element's resolved absolute one), so
 * a bubble can tell that the detached player is speaking ITS words and draw
 * the Stop control for them.
 *
 * Client-only state, deliberately module-level: it describes this document's
 * speaker, of which there is one.
 */

export interface SpokenReplyPlayback {
  /** The clip, as the bubble that shows it names it. */
  src: string
  /** The element making the sound. */
  element: HTMLAudioElement
}

let current: SpokenReplyPlayback | null = null
/**
 * How many times a PERSON has cut the speaker off: a Stop, a new prompt, a
 * bubble pressed over another reply. The chat's queue of automatic replies
 * reads it, so an answer that was waiting its turn does not start talking the
 * moment the owner silenced the one before it.
 */
let interruptions = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try { listener() } catch { /* one listener must not silence the rest */ }
  }
}

/** Put a media element back to the start, silently. */
function rewind(element: HTMLAudioElement): void {
  try { element.pause() } catch { /* jsdom, a released element */ }
  try { element.currentTime = 0 } catch { /* no metadata yet: already at 0 */ }
}

/** What is speaking right now, or null. */
export function currentSpokenReply(): SpokenReplyPlayback | null {
  return current
}

/**
 * `element` has started (or is about to start) playing `src`: it takes the
 * speaker, and whatever held it is stopped. The same element claiming again
 * (a resume after a pause) changes nothing.
 */
export function claimSpokenReply(
  element: HTMLAudioElement,
  src: string,
  { automatic = false }: { automatic?: boolean } = {},
): void {
  const previous = current
  if (previous && previous.element === element && previous.src === src) return
  current = { src, element }
  if (previous && previous.element !== element) {
    // Only a person's press counts as cutting in; the chat's own queue
    // displacing something must not cancel the rest of that queue.
    if (!automatic) interruptions += 1
    rewind(previous.element)
  }
  notify()
}

/** See `interruptions`. */
export function spokenReplyInterruptions(): number {
  return interruptions
}

/**
 * `element` is no longer speaking (paused, ended, failed, unmounted). Only the
 * holder can let go — a stale pause event from an element that was already
 * displaced must not clear the one that displaced it.
 */
export function releaseSpokenReply(element: HTMLAudioElement): void {
  if (!current || current.element !== element) return
  current = null
  notify()
}

/**
 * Stop whatever is speaking and put it back to the start, so pressing play
 * again plays the reply from its first word. The text reply is untouched —
 * this is the speaker, not the transcript.
 *
 * With `src`, only when that clip is the one speaking: a Stop pressed on one
 * bubble can never silence another bubble's reply.
 */
export function stopSpokenReply(src?: string): boolean {
  const playing = current
  // A stop with nothing named is the owner moving on (a new prompt, the
  // microphone): whatever is queued to speak next is cut off too, even when
  // nothing happens to be sounding this very moment.
  if (src === undefined) interruptions += 1
  if (!playing) return false
  if (src !== undefined && playing.src !== src) return false
  if (src !== undefined) interruptions += 1
  current = null
  rewind(playing.element)
  notify()
  return true
}

/** Follow the speaker; answers the unsubscribe. */
export function subscribeSpokenReply(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test seam. */
export function _resetSpokenReplyPlaybackForTests(): void {
  current = null
  interruptions = 0
  listeners.clear()
}
