// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { VoiceState } from "@/lib/chat-voice-input";
import {
  HOLD_MIN_MS,
  HOLD_TO_TALK_KEY,
  isHoldToTalkKey,
  isKeyForwardingTarget,
  RELEASE_SLACK_PX,
  releasedOver,
  stepHold,
  type Hold,
  type HoldEvent,
} from "@/lib/chat-hold-to-talk";

/**
 * Hold to talk: what every press, release and interruption does to the
 * composer's microphone. The component performs the actions; these are the
 * rules it performs them by.
 */

/** Run events through the reducer from no hold; the hold left over and every action taken. */
function run(...events: HoldEvent[]): { hold: Hold; actions: string[] } {
  let hold: Hold = null;
  const actions: string[] = [];
  for (const event of events) {
    const step = stepHold(hold, event);
    hold = step.hold;
    actions.push(step.action);
  }
  return { hold, actions };
}

const press = (source: "pointer" | "key", at: number, voice: VoiceState = "idle", repeat = false): HoldEvent =>
  ({ type: "press", source, at, voice, repeat });
const release = (source: "pointer" | "key", at: number, voice: VoiceState = "recording"): HoldEvent =>
  ({ type: "release", source, at, voice });

describe("the mic button: tap or hold", () => {
  it("opens the microphone on the press itself, so the first word is not lost", () => {
    const { hold, actions } = run(press("pointer", 1000));
    expect(actions).toEqual(["start"]);
    expect(hold).toEqual({ source: "pointer", since: 1000 });
  });

  it("finishes and sends on a release after a hold — exactly the Stop click", () => {
    const { hold, actions } = run(press("pointer", 1000), release("pointer", 1000 + HOLD_MIN_MS));
    expect(actions).toEqual(["start", "finish"]);
    expect(hold).toBeNull();
  });

  it("keeps recording after a quick tap: click to start, click to stop, as before", () => {
    const { hold, actions } = run(press("pointer", 1000), release("pointer", 1000 + HOLD_MIN_MS - 1));
    expect(actions).toEqual(["start", "none"]);
    expect(hold).toBeNull();
  });

  it("keeps recording when let go of while the permission prompt is up — the owner had to let go to answer it", () => {
    const { actions } = run(press("pointer", 1000), release("pointer", 5000, "requesting"));
    expect(actions).toEqual(["start", "none"]);
  });

  it("cancels when let go of off the button — an abandoned click never sent anything", () => {
    const off = (at: number, voice: VoiceState = "recording"): HoldEvent => ({ type: "release", source: "pointer", at, voice, inside: false });
    expect(run(press("pointer", 0), off(2000)).actions).toEqual(["start", "cancel"]);
    expect(run(press("pointer", 0), off(100)).actions).toEqual(["start", "cancel"]);
    expect(run(press("pointer", 0), off(2000, "requesting")).actions).toEqual(["start", "cancel"]);
    // A key has no "off".
    expect(stepHold({ source: "key", since: 0 }, { type: "release", source: "key", at: 900, voice: "recording", inside: false }).action).toBe("finish");
  });

  it("counts a finger that drifted a little as still on the button", () => {
    const rect = { left: 100, right: 144, top: 200, bottom: 244 };
    expect(releasedOver(rect, 120, 220)).toBe(true);
    expect(releasedOver(rect, 144 + RELEASE_SLACK_PX, 244 + RELEASE_SLACK_PX)).toBe(true);
    expect(releasedOver(rect, 100 - RELEASE_SLACK_PX - 1, 220)).toBe(false);
    expect(releasedOver(rect, 120, 400)).toBe(false);
  });

  it("leaves a press on Stop to its click", () => {
    expect(run(press("pointer", 1000, "recording")).actions).toEqual(["none"]);
    expect(run(press("pointer", 1000, "transcribing")).actions).toEqual(["none"]);
    expect(run(press("pointer", 1000, "requesting")).actions).toEqual(["none"]);
  });

  it("starts again from an error, as the button offers itself there", () => {
    expect(run(press("pointer", 1000, "error")).actions).toEqual(["start"]);
  });
});

describe("the hold-to-talk key", () => {
  it("records while held and sends on release", () => {
    const { hold, actions } = run(press("key", 0), release("key", 2500));
    expect(actions).toEqual(["start", "finish"]);
    expect(hold).toBeNull();
  });

  it("cancels a hold shorter than the minimum instead of sending it", () => {
    expect(run(press("key", 0), release("key", HOLD_MIN_MS - 1)).actions).toEqual(["start", "tooShort"]);
    expect(run(press("key", 0), release("key", 120, "requesting")).actions).toEqual(["start", "tooShort"]);
    // At the minimum it is a message.
    expect(run(press("key", 0), release("key", HOLD_MIN_MS)).actions).toEqual(["start", "finish"]);
  });

  it("ignores key-repeat: one recording however long the key auto-repeats", () => {
    const repeats = Array.from({ length: 20 }, (_, i) => press("key", 30 * (i + 1), "recording", true));
    const { actions } = run(press("key", 0), ...repeats, release("key", 1000));
    expect(actions.filter((a) => a === "start")).toHaveLength(1);
    expect(actions.at(-1)).toBe("finish");
  });

  it("does not start from a repeat alone — a key already down when the chat opened", () => {
    expect(run(press("key", 0, "idle", true)).actions).toEqual(["none"]);
  });

  it("cancels a long hold let go of before the microphone ever opened", () => {
    expect(run(press("key", 0), release("key", 900, "requesting")).actions).toEqual(["start", "cancel"]);
  });

  it("does nothing on release when the start itself failed — the error is already on screen", () => {
    expect(run(press("key", 0), release("key", 900, "error")).actions).toEqual(["start", "none"]);
    expect(run(press("key", 0), release("key", 100, "error")).actions).toEqual(["start", "none"]);
  });

  it("does not cancel what Stop already sent: a release while transcribing is nothing, however short", () => {
    expect(run(press("key", 0), release("key", 100, "transcribing")).actions).toEqual(["start", "none"]);
    expect(run(press("key", 0), release("key", 900, "transcribing")).actions).toEqual(["start", "none"]);
    expect(run(press("pointer", 0), release("pointer", 900, "transcribing")).actions).toEqual(["start", "none"]);
  });

  it("leaves a click-started recording alone", () => {
    expect(run(press("key", 0, "recording")).actions).toEqual(["none"]);
  });

  it("is a no-op release when nothing was held, or the other thing was", () => {
    expect(run(release("key", 500)).actions).toEqual(["none"]);
    const { hold, actions } = run(press("pointer", 0), release("key", 500));
    expect(actions).toEqual(["start", "none"]);
    expect(hold?.source).toBe("pointer");
  });

  it("holds one thing at a time: the key while the button is held changes nothing", () => {
    const { hold, actions } = run(press("pointer", 0), press("key", 100, "recording"));
    expect(actions).toEqual(["start", "none"]);
    expect(hold).toEqual({ source: "pointer", since: 0 });
  });
});

describe("leaving a hold without letting go", () => {
  it("cancels and discards on Escape", () => {
    expect(run(press("key", 0), { type: "escape" }).actions).toEqual(["start", "cancel"]);
    expect(run(press("pointer", 0), { type: "escape" }).actions).toEqual(["start", "cancel"]);
  });

  it("cancels on a blur, a hidden tab or the chat closing — a keyup elsewhere never arrives", () => {
    const { hold, actions } = run(press("key", 0), { type: "interrupt" });
    expect(actions).toEqual(["start", "cancel"]);
    expect(hold).toBeNull();
    // ...and the release that never should have come changes nothing.
    expect(stepHold(hold, release("key", 5000)).action).toBe("none");
  });

  it("ends quietly when the capture ended some other way, and owes nothing after", () => {
    const { hold, actions } = run(press("key", 0), { type: "ended" }, { type: "interrupt" }, release("key", 900));
    expect(actions).toEqual(["start", "none", "none", "none"]);
    expect(hold).toBeNull();
  });

  it("leaves Escape and interruptions alone when nothing is held", () => {
    expect(run({ type: "escape" }).actions).toEqual(["none"]);
    expect(run({ type: "interrupt" }).actions).toEqual(["none"]);
  });
});

describe("which key, and where", () => {
  it("is F8 on its own", () => {
    expect(HOLD_TO_TALK_KEY).toBe("F8");
    expect(isHoldToTalkKey({ key: "F8" })).toBe(true);
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(isHoldToTalkKey({ key: "F8", [mod]: true })).toBe(false);
    }
    expect(isHoldToTalkKey({ key: "F9" })).toBe(false);
    expect(isHoldToTalkKey({ key: " " })).toBe(false);
  });

  it("is left to a terminal or a remote-desktop canvas, which forward every key", () => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const inner = document.createElement("textarea");
    terminal.appendChild(inner);
    expect(isKeyForwardingTarget(inner)).toBe(true);

    const canvas = document.createElement("canvas");
    expect(isKeyForwardingTarget(canvas)).toBe(true);

    // The chat's own composer is where it is meant to work.
    const composer = document.createElement("textarea");
    expect(isKeyForwardingTarget(composer)).toBe(false);
    expect(isKeyForwardingTarget(document.body)).toBe(false);
    expect(isKeyForwardingTarget(window)).toBe(false);
    expect(isKeyForwardingTarget(null)).toBe(false);
  });
});
