import { describe, expect, it } from "vitest";
import { unechoedUserTurns, type ChatMessage } from "@/lib/chat-history-cache";

/**
 * Which of this browser's own turns a history read has not echoed back yet —
 * the reconcile both chat surfaces run on every read, and since TASK-1364 on
 * every push from another device.
 *
 * Pinned: a turn is recognised by its run's key, with text only as the
 * fallback where one side has no key; two different keys never match by text
 * (the phone's "yes" is not this browser's "yes"); a keyed turn survives a
 * browser clock behind the box's, and is let go only once it has aged out of
 * the window the read returned.
 */

const BOX = 1_790_000_000_000;
const user = (text: string, timestamp: number, idempotencyKey?: string): ChatMessage => ({
  role: "user",
  text,
  timestamp,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});
const assistant = (text: string, timestamp: number): ChatMessage => ({ role: "assistant", text, timestamp });

describe("matching a local turn to the server's copy", () => {
  it("recognises its own turn by the run's key, whatever the text says", () => {
    // An attachment turn shows its 📎 line here; the gateway stores the prompt alone.
    const local = user("📎 pic.png\nwhat is this", BOX + 50, "run-a");
    const restored = [user("what is this", BOX, "run-a:user"), assistant("A cat.", BOX + 10)];
    expect(unechoedUserTurns([local], restored, BOX + 10)).toEqual([]);
  });

  it("does not take another device's identical words for its own turn", () => {
    // The phone said "yes" (run-p) and the box has filed it; this browser's own
    // "yes" (run-d) has not been written yet.
    const restored = [assistant("Shall I book it?", BOX), user("yes", BOX + 5, "run-p:user")];
    const local = user("yes", BOX + 6, "run-d");
    expect(unechoedUserTurns([local], restored, BOX + 5)).toEqual([local]);
  });

  it("falls back to text where the server's copy has no key (an older gateway)", () => {
    const local = user("yes", BOX + 6, "run-d");
    expect(unechoedUserTurns([local], [user("yes", BOX + 5)], BOX + 5)).toEqual([]);
  });

  it("falls back to text where the local turn has no key", () => {
    const local = user("yes", BOX + 6);
    expect(unechoedUserTurns([local], [user("yes", BOX + 5, "run-d:user")], BOX + 5)).toEqual([]);
  });

  it("keeps the second of two identical turns until the server has both", () => {
    const first = user("again", BOX, "run-1:user");
    const second = user("again", BOX + 20, "run-2");
    const restored = [first, assistant("ok", BOX + 10)];
    expect(unechoedUserTurns([first, assistant("ok", BOX + 10), second], restored, BOX + 10)).toEqual([second]);
    // Without keys the count still tells them apart.
    const a = user("again", BOX);
    const b = user("again", BOX + 20);
    expect(unechoedUserTurns([a, b], [user("again", BOX)], BOX)).toEqual([b]);
  });
});

describe("keeping what is still in flight", () => {
  it("keeps a keyed turn sent from a browser whose clock is behind the box", () => {
    // Sent a moment ago, stamped 30 s behind the box's newest message.
    const restored = [user("earlier", BOX - 600_000, "run-0:user"), assistant("Reply", BOX)];
    const local = user("just now", BOX - 30_000, "run-new");
    expect(unechoedUserTurns([...restored, local], restored, BOX)).toEqual([local]);
  });

  it("lets a keyed turn go once it has aged out of the window the read returned", () => {
    // A long conversation: the read is the newest messages only, and this turn
    // from the previous read is older than all of them.
    const aged = user("from long ago", BOX - 9_000_000, "run-old:user");
    const restored = [user("recent", BOX - 1_000, "run-r:user"), assistant("Reply", BOX)];
    expect(unechoedUserTurns([aged, ...restored], restored, BOX)).toEqual([]);
  });

  it("keeps the timestamp rule for a turn with no key", () => {
    const restored = [assistant("Reply", BOX)];
    expect(unechoedUserTurns([user("behind", BOX - 1)], restored, BOX)).toEqual([]);
    const ahead = user("ahead", BOX + 1);
    expect(unechoedUserTurns([ahead], restored, BOX)).toEqual([ahead]);
  });

  it("keeps everything unechoed on an empty read", () => {
    const local = user("first words", 5, "run-1");
    expect(unechoedUserTurns([local], [], 0)).toEqual([local]);
  });
});
