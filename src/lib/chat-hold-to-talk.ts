// -- Hold to talk ------------------------------------------------------------
//
// The second way into the composer's microphone: hold it, speak, let go.
// Kept out of the component, like the rest of the voice input
// (chat-voice-input.ts), so every transition can be tested without a browser.
//
// Two things can be held:
//
//  - the MIC BUTTON. Pressing it opens the microphone at once, so the first
//    word is never lost to a delay. Letting go after HOLD_MIN_MS finishes the
//    recording exactly as the Stop click does — transcribed and sent. Letting
//    go sooner was a TAP, and a tap keeps the click-to-start, click-to-stop
//    behaviour the button always had: the recording goes on, with Stop on
//    screen. Letting go OFF the button — dragged away, the way a click is
//    abandoned, or a swipe that happened to start on it — sends nothing: the
//    recording is cancelled, as an abandoned click never started one.
//  - the HOLD_TO_TALK_KEY, while the chat is open. A key has no toggle: a hold
//    shorter than HOLD_MIN_MS is a brush of the key, not a message, and it is
//    cancelled — nothing is uploaded or sent. Key-repeat is not a new press.
//
// While anything is held, Escape cancels and discards, and so does anything
// that takes the hold away from the owner without a release they chose: the
// window losing focus, the tab going hidden, the chat closing. A keyup that
// lands in another window is never delivered here, so a hold that was not
// ended this way would leave the microphone recording with nobody holding it —
// and a microphone that is live while the interface looks idle is the one
// outcome the voice input must never produce.

import type { VoiceState } from "./chat-voice-input";
import { TERMINAL_SELECTOR } from "./screenshot/shortcuts";

/**
 * The key that records while held: F8.
 *
 * Chosen because nothing else on a ClawBox wants it. It types no character, so
 * it cannot collide with writing in the composer the way Space or a letter
 * would. Chromium binds F1, F3, F5, F6, F7, F10, F11 and F12 and leaves F8
 * alone; the kiosk extension takes only F12 and Ctrl+Shift+I; labwc's default
 * bindings and the desktop session's own (Super+D, Ctrl+Alt+Backspace,
 * Alt+Tab, Alt+F4) never touch it; the screenshot keys are Print Screen,
 * Ctrl+Shift+S and Alt+Shift+S; the terminal's are Ctrl/Alt+Shift chords and
 * F2 renames a tab. A modifier held alone (Right Alt, Ctrl) would have been
 * one of those chords half-pressed, or AltGr on half the layouts the box is
 * sold in.
 *
 * Pressed with a modifier it is not this key; pressed inside a terminal or the
 * remote desktop it belongs to what is running there (mc and htop live on the
 * F-keys).
 */
export const HOLD_TO_TALK_KEY = "F8";

/**
 * Shorter than this, a press of the mic button is a tap and a hold of the key
 * is cancelled. Long enough that a deliberate click never reads as a hold,
 * short enough that nobody holding the key to speak lets go before it.
 */
export const HOLD_MIN_MS = 300;

/** What is being held: the mic button (mouse, pen, finger) or the key. */
export type HoldSource = "pointer" | "key";

/** The hold in progress, or null. `since` is when the press landed. */
export type Hold = { source: HoldSource; since: number } | null;

export type HoldEvent =
  /** The button went down, or the key did. `voice` is the composer's state at that moment. */
  | { type: "press"; source: HoldSource; at: number; voice: VoiceState; repeat?: boolean }
  /**
   * The button or the key came back up. `inside` is whether a pointer was let
   * go of over the button (RELEASE_SLACK_PX around it); absent means it was.
   */
  | { type: "release"; source: HoldSource; at: number; voice: VoiceState; inside?: boolean }
  /** Escape, while something is held. */
  | { type: "escape" }
  /** The window lost focus, the tab was hidden, the chat closed, the pointer was taken away. */
  | { type: "interrupt" }
  /**
   * The capture ended some other way while held — Stop or Cancel clicked, the
   * start refused, the ten-minute cap. The hold is over and owes nothing: its
   * release must not cancel a transcription the owner already sent.
   */
  | { type: "ended" };

export type HoldAction =
  /** Nothing to do. */
  | "none"
  /** Open the microphone, as the mic button's click does. */
  | "start"
  /** Stop and send — exactly what the Stop click does. */
  | "finish"
  /** Stop and discard; the microphone is released and nothing is uploaded. */
  | "cancel"
  /** The same, for a key let go before HOLD_MIN_MS — the composer says why. */
  | "tooShort";

/** The voice states a press can start a recording from: what the mic button offers itself in. */
function canStart(voice: VoiceState): boolean {
  return voice === "idle" || voice === "error";
}

/**
 * One step of the hold. Pure: the caller keeps `hold`, performs the action.
 *
 * A press while a hold is already running (the key while the button is held,
 * a second finger) changes nothing: there is one microphone and one hold.
 * A press while the composer is already recording from a tap is the button's
 * own business — its click is Stop — and the key leaves it alone.
 */
export function stepHold(hold: Hold, event: HoldEvent): { hold: Hold; action: HoldAction } {
  switch (event.type) {
    case "press": {
      if (event.repeat || hold) return { hold, action: "none" };
      if (!canStart(event.voice)) return { hold, action: "none" };
      return { hold: { source: event.source, since: event.at }, action: "start" };
    }
    case "release": {
      if (!hold || hold.source !== event.source) return { hold, action: "none" };
      const held = event.at - hold.since;
      // Nothing is capturing any more (the start failed, or Stop was pressed
      // meanwhile): there is nothing for the release to finish or cancel.
      if (event.voice !== "recording" && event.voice !== "requesting") return { hold: null, action: "none" };
      if (event.source === "pointer") {
        // Dragged off before letting go: abandoned, like a click would be.
        if (event.inside === false) return { hold: null, action: "cancel" };
        // A tap, or a release while the permission prompt is still up — the
        // owner had to let go to answer it. Either way the recording carries
        // on as a click-started one, with Stop on screen.
        if (held < HOLD_MIN_MS || event.voice !== "recording") return { hold: null, action: "none" };
        return { hold: null, action: "finish" };
      }
      if (held < HOLD_MIN_MS) return { hold: null, action: "tooShort" };
      if (event.voice === "recording") return { hold: null, action: "finish" };
      // Let go before the microphone ever opened: nothing was said, and a
      // key has no toggle to fall back to.
      return { hold: null, action: "cancel" };
    }
    case "escape":
    case "interrupt":
      return hold ? { hold: null, action: "cancel" } : { hold, action: "none" };
    case "ended":
      return { hold: null, action: "none" };
  }
}

/**
 * How far outside the button a finger may drift and still count as letting go
 * ON it — a thumb holding a 44 px target to talk does not stay on its pixels.
 */
export const RELEASE_SLACK_PX = 24;

/** Was the pointer let go of over this button, give or take RELEASE_SLACK_PX? */
export function releasedOver(rect: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x >= rect.left - RELEASE_SLACK_PX && x <= rect.right + RELEASE_SLACK_PX
    && y >= rect.top - RELEASE_SLACK_PX && y <= rect.bottom + RELEASE_SLACK_PX;
}

type KeyLike = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

/** Is this the hold-to-talk key, on its own? */
export function isHoldToTalkKey(e: KeyLike): boolean {
  return e.key === HOLD_TO_TALK_KEY && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/**
 * Surfaces that send every key somewhere else: a terminal (its shell) and a
 * canvas holding the keyboard focus — the remote desktop's viewer focuses its
 * canvas and forwards every key to the remote machine (VNCApp's
 * `focusVncSurface`). The hold-to-talk key pressed there is the program's,
 * not the chat's.
 */
export const KEY_FORWARDING_SELECTOR = `${TERMINAL_SELECTOR}, canvas`;

export function isKeyForwardingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const closest = (target as { closest?: (selectors: string) => unknown }).closest;
  if (typeof closest !== "function") return false;
  return !!closest.call(target, KEY_FORWARDING_SELECTOR);
}
