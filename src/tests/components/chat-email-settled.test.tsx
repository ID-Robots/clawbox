// A card must never offer to send mail that has already gone.
//
// THE BUG THIS PINS, in the owner's words: "when an email is approved from
// telegram, the email queue in the dashboard/chat [must] be fixed / cleared by
// itself. Not to have the drafts staying despite being sent."
//
// The batch card is FROZEN AT DISPLAY on purpose — that is what stops a draft
// queued during the reading pause from riding along on the tap (#498). The
// mistake was to freeze the VERDICT with it: the card kept its drafts in
// component state and never asked again what became of them, so a draft
// approved anywhere else — Settings → Email, a second tab, the Telegram
// approvals bot — left a live "Approve & send" button over a message that was
// already in somebody's inbox. Pressing it was harmless (the route answers
// "gone"), but the screen was lying, and a screen that says mail has not gone
// out is a screen the owner acts on.
//
// Freezing what is being asked and refreshing the ANSWER are different things.
// The card goes on showing exactly the text that was read; what it stops doing
// is claiming that text is still waiting.
//
// The queue is re-read by `installPendingRefresh` — the same visibility-gated
// schedule Settings → Email uses, and the one the recovery tests already lean
// on. No new poller.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

/** What the queue answers a GET with. Mutated mid-test to move the device. */
let queued: Record<string, unknown>[] = [];
/** What the store says became of the drafts that have left it. */
let receipts: Record<string, unknown>[] = [];

function pendingDraft(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `draft-${n}`,
    to: [`person${n}@example.com`],
    subject: `Subject ${n}`,
    preview: `The body of message ${n}.`,
    body: `The body of message ${n}.`,
    createdAt: 1_700_000_000_000 + n,
    fingerprint: `fingerprint-${n}`,
    ...over,
  };
}

/**
 * Reads of the queue the test is holding open, in the order they were ISSUED.
 *
 * Each one carries the snapshot the device would have answered it with at the
 * moment it was made, so releasing them out of order is exactly the race two
 * overlapping reads produce on a real box.
 */
let heldReads: (() => void)[] = [];
/** Whether a GET waits to be released instead of answering at once. */
let holdReads = false;

/** Bodies POSTed to the approval route with a reject action, in order. */
let rejectPosts: Record<string, unknown>[] = [];
/** What the device answers a reject with. Throwing stands for an unreachable box. */
let rejectResponse: (() => unknown) | null = null;
/** The same hook for the approve side, which has its own refusal handling. */
let approveResponse: (() => unknown) | null = null;

/** How many times the approval queue has been READ. */
function queueReads(): number {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(
      (call) =>
        String(call[0]).includes("/setup-api/email/pending")
        && ((call[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET",
    ).length;
}

function installBoxWithMailQueue(): HermesBox {
  const box = installHermesBox();
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/email/pending")) {
        if ((init?.method ?? "GET").toUpperCase() === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          if (body.action === "reject_batch") {
            rejectPosts.push(body);
            if (!rejectResponse) return { ok: true, status: 200, json: async () => ({ success: true }) };
            const answer = rejectResponse();
            return { ok: true, status: 200, json: async () => answer };
          }
          if (body.action === "approve_batch" && approveResponse) {
            const answer = approveResponse();
            return { ok: true, status: 200, json: async () => answer };
          }
          return { ok: true, status: 200, json: async () => ({ success: true, sent: 1, failed: 0, results: [] }) };
        }
        // The snapshot is taken NOW, when the request is made — an answer
        // released later still says what the queue held at the time it was
        // asked, which is the whole point of the race below.
        const snapshot = { pending: queued, outcomes: receipts };
        const answer = { ok: true, status: 200, json: async () => snapshot };
        if (!holdReads) return answer;
        return new Promise((resolve) => {
          heldReads.push(() => resolve(answer));
        });
      }
      return inner(input as RequestInfo, init);
    }),
  );
  return box;
}

/**
 * Which ENDING the card is showing for one draft, or null when it shows none.
 *
 * The attribute rather than the sentence: this mounts the real chat, whose
 * I18nProvider reaches its table through a dynamic import and answers with the
 * key until it lands. Asserting on English here would be asserting on a key
 * name. The words themselves are pinned in chat-email-batch.test.tsx, which
 * warms the provider first.
 */
function outcomeFor(draftId: string): string | null {
  const row = document.querySelector(`[data-draft-id="${draftId}"]`);
  const line = row?.querySelector('[data-testid="chat-email-batch-outcome"]');
  return line?.getAttribute("data-outcome-kind") ?? null;
}

beforeEach(() => {
  queued = [];
  receipts = [];
  heldReads = [];
  holdReads = false;
  rejectPosts = [];
  rejectResponse = null;
  approveResponse = null;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  resetHarnessCache();
});

describe("a draft approved somewhere else", () => {
  it("stops being offered and says it was sent", async () => {
    queued = [pendingDraft(1)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    // Approved from Telegram, or from Settings → Email in another tab. The
    // draft is gone from the queue and the store says why.
    queued = [];
    receipts = [{ id: "draft-1", kind: "sent", at: 1_700_000_000_500, to: ["person1@example.com"], subject: "Subject 1" }];
    fireEvent.focus(window);

    // The control is gone: there is nothing left here to consent to.
    await waitFor(() => expect(screen.queryByTestId("chat-email-batch-approve")).toBeNull());
    // And the card says what happened, rather than silently going quiet.
    expect(outcomeFor("draft-1")).toBe("sent");
    // The text the owner read is still on screen — the card is a record now.
    expect(screen.getByTestId("chat-email-batch-body").textContent).toBe("The body of message 1.");
  });

  it("says 'deleted' for one the owner threw away, not 'sent'", async () => {
    queued = [pendingDraft(2)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    queued = [];
    receipts = [{ id: "draft-2", kind: "rejected", at: 1_700_000_000_500, to: ["person2@example.com"], subject: "Subject 2" }];
    fireEvent.focus(window);

    await waitFor(() => expect(outcomeFor("draft-2")).toBeTruthy());
    expect(outcomeFor("draft-2")).toBe("rejected");
    expect(screen.queryByTestId("chat-email-batch-approve")).toBeNull();
  });

  it("names the message a duplicate was covered by", async () => {
    queued = [pendingDraft(3), pendingDraft(4)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    queued = [];
    receipts = [
      { id: "draft-3", kind: "sent", at: 1_700_000_000_500, to: ["person3@example.com"], subject: "Subject 3" },
      { id: "draft-4", kind: "duplicate", at: 1_700_000_000_500, sentAs: "draft-3", to: ["person4@example.com"], subject: "Subject 4" },
    ];
    fireEvent.focus(window);

    await waitFor(() => expect(screen.queryByTestId("chat-email-batch-approve")).toBeNull());
    expect(outcomeFor("draft-3")).toBe("sent");
    expect(outcomeFor("draft-4")).toBe("duplicate");
  });

  it("never turns an unconfirmed send into 'no longer waiting'", async () => {
    // The box handed the message to the mail server and never heard back, and
    // the store says exactly that. The card used to drop the receipt on the
    // floor — its parser knew four kinds of five — and fell back to "it left
    // the queue, no idea why", which reads as "it did not go". That is the one
    // sentence that gets a delivered message sent a second time.
    queued = [pendingDraft(7)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    queued = [];
    receipts = [{
      id: "draft-7",
      kind: "unconfirmed",
      at: 1_700_000_000_500,
      to: ["person7@example.com"],
      subject: "Subject 7",
      error: "the connection dropped",
    }];
    fireEvent.focus(window);

    await waitFor(() => expect(outcomeFor("draft-7")).toBeTruthy());
    expect(outcomeFor("draft-7")).toBe("unconfirmed");
    expect(screen.queryByTestId("chat-email-batch-approve")).toBeNull();
  });

  it("does not let an older read of the queue overrule a newer one", async () => {
    // Two reads of the approval queue are in flight together — the turn-end
    // collect and a focus or timer tick — and nothing makes two fetches of the
    // same URL come back in the order they were sent.
    //
    // The older one was issued before the draft was written, so its answer does
    // not mention it. Applied on top of the newer answer, that reads as "the
    // draft has left the queue" and settles the card as decided elsewhere —
    // over a draft that is waiting, on a card the reconcile then skips for
    // ever, so it can never be approved from the chat again.
    holdReads = true;
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(heldReads).toHaveLength(1));

    // The agent queues the draft, and a second read goes out after it.
    queued = [pendingDraft(8)];
    fireEvent.focus(window);
    await waitFor(() => expect(heldReads).toHaveLength(2));

    // The newer read answers first and puts the card up.
    heldReads[1]();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    // Then the older one arrives, still describing an empty queue.
    heldReads[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The draft is waiting, so the card is still a live control and says
    // nothing about an ending it does not have.
    expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy();
    expect(outcomeFor("draft-8")).toBeNull();
  });

  it("keeps the button for the drafts that ARE still waiting", async () => {
    queued = [pendingDraft(5), pendingDraft(6)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    // One of the two was approved elsewhere; the other is untouched.
    queued = [pendingDraft(6)];
    receipts = [{ id: "draft-5", kind: "sent", at: 1_700_000_000_500, to: ["person5@example.com"], subject: "Subject 5" }];
    fireEvent.focus(window);

    await waitFor(() => expect(outcomeFor("draft-5")).toBeTruthy());
    const approve = screen.getByTestId("chat-email-batch-approve");
    // Still offered — but for ONE message, not two. A count that still said
    // two would be the same lie in a smaller place.
    expect(approve.textContent).not.toMatch(/2/);
    expect(outcomeFor("draft-6")).toBeNull();
  });
});

// ── "Send nothing" ───────────────────────────────────────────────────────────
//
// THE BUG, in the owner's words (Hermes box, 2026-09-03): "when I click dismiss
// ('Send nothing') nothing happens; it returns after 20 secs."
//
// He was right on both counts. `cancelEmailBatch` dropped the card from this
// component's state and touched nothing else, so the drafts stayed queued and
// the next visibility-gated tick — 15 s — found them and offered them again.
// The button's entire effect was to hide itself until the next poll.
//
// It is the same "one source of truth" defect as the stale Approve button, seen
// from the other side: the card was deciding what the queue holds instead of
// asking. So the gesture now goes to the store, names the drafts it means with
// the fingerprints they were shown with, and the card renders what came back.
//
// (The card is rebuilt from GET /setup-api/email/pending, NOT from the
// transcript's `EMAIL:` directives — those are IMAP uids for opening received
// mail, a different mechanism entirely. The owner counted about 20 seconds; the
// schedule behind it is PENDING_REFRESH_MS, which is 15.)

describe("send nothing", () => {
  it("deletes the drafts it is showing, and says so on the card", async () => {
    queued = [pendingDraft(1), pendingDraft(2)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-cancel")).toBeTruthy());

    // The device answers the way the route does, and stops listing them.
    rejectResponse = () => {
      queued = [];
      return {
        success: true,
        rejected: 2,
        failed: 0,
        results: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: true },
        ],
      };
    };
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));

    // ONE request, naming both drafts with what they said.
    await waitFor(() => expect(rejectPosts).toHaveLength(1));
    expect(rejectPosts[0]).toMatchObject({
      action: "reject_batch",
      drafts: [
        { id: "draft-1", fingerprint: "fingerprint-1" },
        { id: "draft-2", fingerprint: "fingerprint-2" },
      ],
    });

    // The card stays as a record and says what happened — it does not vanish
    // and leave the owner wondering whether the click landed.
    await waitFor(() => expect(outcomeFor("draft-1")).toBe("rejected"));
    expect(outcomeFor("draft-2")).toBe("rejected");
    expect(screen.queryByTestId("chat-email-batch-approve")).toBeNull();
  });

  it("does not come back on the next poll", async () => {
    queued = [pendingDraft(1)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-cancel")).toBeTruthy());

    rejectResponse = () => {
      queued = [];
      return { success: true, rejected: 1, failed: 0, results: [{ id: "draft-1", ok: true }] };
    };
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));
    await waitFor(() => expect(outcomeFor("draft-1")).toBe("rejected"));

    // The 20 seconds the owner counted.
    fireEvent.focus(window);
    await waitFor(() => expect(queueReads()).toBeGreaterThan(1));
    expect(screen.queryByTestId("chat-email-batch-approve")).toBeNull();
    expect(outcomeFor("draft-1")).toBe("rejected");
  });

  it("does not go quiet when the device deleted nothing it was asked to", async () => {
    // A row the route refuses leaves the draft WAITING, so it gets no outcome —
    // giving it one would take its checkbox away for good. The card then has to
    // say something, or the click is the old bug again: "nothing happens".
    queued = [pendingDraft(1)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-cancel")).toBeTruthy());

    rejectResponse = () => ({
      success: false,
      rejected: 0,
      failed: 1,
      results: [{ id: "draft-1", ok: false, reason: "changed", error: "That draft changed." }],
    });
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));

    await waitFor(() => expect(screen.getByTestId("chat-email-batch-error")).toBeTruthy());
    // Still a live control over a draft that is still waiting.
    expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy();
    expect(outcomeFor("draft-1")).toBeNull();
  });

  it("says why the one it could not delete is still there", async () => {
    // The mixed answer, and the gap the all-refused case above did not cover.
    // A refused row gets no outcome on purpose — its draft is still waiting and
    // an outcome would take its checkbox away for good — and `settleCard` then
    // clears `requestError` and hands the card straight back. One deleted, one
    // silently still on screen is the "nothing happens" click again, in a
    // smaller place.
    queued = [pendingDraft(1), pendingDraft(2)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-cancel")).toBeTruthy());

    rejectResponse = () => {
      queued = [pendingDraft(2)];
      return {
        success: false,
        rejected: 1,
        resolved: 0,
        failed: 1,
        results: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: false, reason: "changed", error: "That draft changed after it was shown, so it was not deleted." },
        ],
      };
    };
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));

    await waitFor(() => expect(outcomeFor("draft-1")).toBe("rejected"));
    // The route's own words, about the draft that is still waiting.
    const said = await screen.findByTestId("chat-email-batch-error");
    expect(said).toHaveTextContent("That draft changed after it was shown");
    // And it is still a live control for the one that did not go.
    expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy();
    expect(outcomeFor("draft-2")).toBeNull();
  });

  it("says why the one it could not send is still there", async () => {
    // The MIRROR of the case above, on the approve handler, and it is not the
    // same test twice: `cancelEmailBatch` throws on an empty `outcomes`, so an
    // all-refused delete was already loud, while `approveEmailBatch` has no
    // such throw — before the refusal sentence, an all-refused approve settled
    // in complete silence. Reverting either handler's two lines leaves the
    // other one's test green, which is why both exist.
    queued = [pendingDraft(1), pendingDraft(2)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());

    approveResponse = () => {
      queued = [pendingDraft(2)];
      return {
        success: false,
        sent: 1,
        failed: 1,
        results: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: false, reason: "changed", error: "That draft changed after it was shown, so it was not sent." },
        ],
      };
    };
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(outcomeFor("draft-1")).toBe("sent"));
    // The route's own words, about the draft that is still waiting.
    const said = await screen.findByTestId("chat-email-batch-error");
    expect(said).toHaveTextContent("That draft changed after it was shown");
    // And it is still a live control for the one that did not go.
    expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy();
    expect(outcomeFor("draft-2")).toBeNull();
  });

  it("keeps the button when the deletion did not get through", async () => {
    // Nothing was deleted, so saying "removed" here would be the false success
    // this card exists to avoid — in the direction that loses the owner's mail.
    queued = [pendingDraft(1)];
    const box = installBoxWithMailQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-cancel")).toBeTruthy());

    rejectResponse = () => {
      throw new Error("the device did not answer");
    };
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));

    await waitFor(() => expect(screen.getByTestId("chat-email-batch-error")).toBeTruthy());
    expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy();
    expect(outcomeFor("draft-1")).toBeNull();
  });
});
