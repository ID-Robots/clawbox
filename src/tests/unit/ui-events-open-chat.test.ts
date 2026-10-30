// @vitest-environment jsdom
/**
 * `dispatchOpenChat` (src/lib/ui-events.ts): "open the chat, and put these
 * words in the composer — UNSENT".
 *
 * The run page's Message in chat and the agent chart's panel end here since
 * 2026-10-30 (the chat composes, the app shows). What is pinned: the event
 * carries the draft under `detail.draft`, a call without one carries an empty
 * detail rather than `draft: undefined`, and it is a DIFFERENT event from
 * CHAT_MESSAGE_EVENT — the one that SENDS — so a listener for sends never
 * mistakes a draft for the owner's turn.
 */
import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_EVENT, dispatchOpenChat, OPEN_CHAT_EVENT, type OpenChatDetail } from "@/lib/ui-events";

describe("dispatchOpenChat", () => {
  it("dispatches OPEN_CHAT_EVENT with the draft, and never CHAT_MESSAGE_EVENT", () => {
    const opens: OpenChatDetail[] = [];
    const sends: unknown[] = [];
    const onOpen = (e: Event) => opens.push((e as CustomEvent<OpenChatDetail>).detail);
    const onSend = (e: Event) => sends.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_CHAT_EVENT, onOpen);
    window.addEventListener(CHAT_MESSAGE_EVENT, onSend);
    try {
      dispatchOpenChat({ draft: "Tell coding run run-k3x9q2ab: " });
      dispatchOpenChat();
      dispatchOpenChat({ draft: "" });
      expect(opens).toEqual([{ draft: "Tell coding run run-k3x9q2ab: " }, {}, {}]);
      expect(sends).toEqual([]);
      expect(OPEN_CHAT_EVENT).toBe("clawbox:open-chat");
      expect(OPEN_CHAT_EVENT).not.toBe(CHAT_MESSAGE_EVENT);
    } finally {
      window.removeEventListener(OPEN_CHAT_EVENT, onOpen);
      window.removeEventListener(CHAT_MESSAGE_EVENT, onSend);
    }
  });
});
