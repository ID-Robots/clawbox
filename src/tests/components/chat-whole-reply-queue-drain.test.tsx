import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * The second message on a harness whose reply lands WHOLE.
 *
 * TASK-517 gave the composer a synchronous mirror of `sending` — `sendingRef` —
 * because the render-time closure lags a commit behind, and deciding from it
 * let a second run start on top of a live one. Every completion path therefore
 * has to clear that mirror, or the guard inverts: instead of stopping a second
 * concurrent run it stops EVERY later run, because the drain effect and both
 * send handlers only ever proceed while the ref says idle.
 *
 * The existing starvation test pins the gateway edition, where a turn is merely
 * ACKNOWLEDGED and the socket's `final`/`error` handlers end the run. This one
 * pins the other half of the unified send path: a harness that answers whole,
 * where `dispatchTurn` itself both paints the reply and ends the run. Leave the
 * mirror set there and the queue parks forever — the box takes the next
 * message, shows it in the transcript, and never sends it.
 */

let box: HermesBox;

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  box = installHermesBox((message) => `reply to ${message}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

function type(textarea: HTMLElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
}

/**
 * The line a box with an empty transcript opens the conversation with. It is
 * the harness's own turn, not one this test typed, and whether it appears
 * depends on what the edition can replay — so it is filtered out rather than
 * counted, and everything below asserts an EXACT sequence.
 */
const GREETING = "hi";

describe("a reply that lands whole still releases the queue", () => {
  /** Exactly what this test put on the wire, in order. */
  const typed = () =>
    box.chatPosts.map((p) => String(p.message)).filter((m) => m !== GREETING);

  it("sends the NEXT message after a completed whole reply (TASK-517)", async () => {
    const textarea = await mountHermesChat(box);

    type(textarea, "first");
    await screen.findByText("reply to first", undefined, { timeout: 5000 });

    type(textarea, "second");

    // The real regression: with the mirror left set, "second" is accepted into
    // the transcript and then parked forever, so it never reaches the wire.
    await screen.findByText("reply to second", undefined, { timeout: 5000 });
    // Exact, not `toContain`: a duplicate POST is its own bug, and the guard
    // this pins is the one that decides whether a turn is sent twice or not at
    // all.
    expect(typed()).toEqual(["first", "second"]);
  });

  it("drains a queue that really has several turns waiting in it", async () => {
    const textarea = await mountHermesChat(box);

    // Submitted back to back, WITHOUT awaiting the replies: the first starts a
    // run and the other two land while it is still in flight, which is the only
    // way the queue holds more than one entry. Awaiting each reply first — as
    // this test originally did — never puts a second turn in the queue at all,
    // so it could not tell a working drain from one that had stopped.
    for (const line of ["one", "two", "three"]) type(textarea, line);

    for (const line of ["one", "two", "three"]) {
      await screen.findByText(`reply to ${line}`, undefined, { timeout: 5000 });
    }
    // Order matters as much as arrival: a queue that drained out of sequence
    // would answer the wrong question first.
    expect(typed()).toEqual(["one", "two", "three"]);
  });
});
