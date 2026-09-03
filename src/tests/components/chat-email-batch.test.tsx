// The batch approval card, as the owner meets it.
//
// The route tests prove the server sends what it is told to send. What they
// cannot prove is the half that makes the gate worth having: that everything
// about to go out in his name is actually ON THE SCREEN before the single
// click, that unticking one drops exactly one, and that a partial failure is
// shown as a partial failure rather than as a tick.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import { EmailBatchCard, type EmailBatchCardState, type EmailBatchDraft } from "@/lib/chat-email-batch";

/** Longer than the clamp, so the "show the whole message" path is exercised. */
const LONG_TAIL = "Then, quietly, a paragraph nobody asked for. ";
const LONG_BODY = `${"Perfectly ordinary opening. ".repeat(30)}${LONG_TAIL}`;

function draft(n: number, over: Partial<EmailBatchDraft> = {}): EmailBatchDraft {
  return {
    id: `draft-${n}`,
    to: [`person${n}@example.com`],
    subject: `Subject ${n}`,
    body: `The body of message ${n}.`,
    createdAt: 1_700_000_000_000 + n,
    fingerprint: `fingerprint-${n}`,
    ...over,
  };
}

function card(over: Partial<EmailBatchCardState> = {}): EmailBatchCardState {
  return {
    batchId: "batch-1",
    drafts: [draft(1), draft(2), draft(3)],
    status: "waiting",
    outcomes: [],
    requestError: "",
    ...over,
  };
}

/**
 * Render inside a real I18nProvider and wait for the copy to land.
 *
 * The provider loads its table asynchronously, and until it does `t` returns
 * the KEY. Asserting before that point passes against "chat.emailBatch.sendAll"
 * — which would let a card that never renders a count look correct.
 */
async function mount(state: EmailBatchCardState, opts: { hermes?: boolean } = {}) {
  const onApprove = vi.fn();
  const onCancel = vi.fn();
  render(
    <I18nProvider>
      <EmailBatchCard card={state} hermes={opts.hermes ?? true} onApprove={onApprove} onCancel={onCancel} />
    </I18nProvider>,
  );
  await waitFor(
    () => expect(screen.getByTestId("chat-email-batch")).toHaveAccessibleName("Email waiting for your approval"),
    // Longer than the default second: the provider reaches its table through a
    // dynamic import, and the first case in the file pays for compiling it.
    { timeout: 5_000 },
  );
  return { onApprove, onCancel };
}

beforeAll(async () => {
  // Warm the table the provider reaches through a dynamic import, so the first
  // case does not spend its whole waitFor budget compiling it.
  await import("@/lib/translations");
});

beforeEach(() => {
  // The provider asks for the saved language before it can render real copy.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ ui_language: "en" }) })),
  );
});

describe("everything that will be sent is on the screen", () => {
  it("shows one row per draft, with its recipients, subject and body", async () => {
    await mount(card());

    const rows = await screen.findAllByTestId("chat-email-batch-draft");
    expect(rows).toHaveLength(3);

    rows.forEach((row, index) => {
      const n = index + 1;
      expect(within(row).getByText(`Subject ${n}`)).toBeInTheDocument();
      expect(within(row).getByText(`To: person${n}@example.com`)).toBeInTheDocument();
      // The BODY, not a preview of it: this is the text a human has to read to
      // catch an instruction they did not write.
      expect(within(row).getByTestId("chat-email-batch-body")).toHaveTextContent(`The body of message ${n}.`);
    });
  });

  it("names every recipient when a draft goes to several people", async () => {
    await mount(card({ drafts: [draft(1, { to: ["a@example.com", "b@example.com"] })] }));
    expect(await screen.findByText("To: a@example.com, b@example.com")).toBeInTheDocument();
  });

  it("says exactly how much of a long body is folded away, and opens it in full", async () => {
    await mount(card({ drafts: [draft(1, { body: LONG_BODY })] }));

    const toggle = await screen.findByTestId("chat-email-batch-expand");
    // Not "show more": the number is the point, because how much is hidden is
    // what you need to know when you are checking for a paragraph you did not
    // write.
    expect(toggle).toHaveTextContent(String(LONG_BODY.length - 600));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("chat-email-batch-body")).not.toHaveTextContent(LONG_TAIL.trim());

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-email-batch-body")).toHaveTextContent(LONG_TAIL.trim());
  });

  it("clamps a long body by character, never through the middle of one", async () => {
    // Every one of these is a surrogate PAIR: "\u{1F642}".length is 2, so a
    // clamp counting UTF-16 units would cut one in half and render a lone
    // surrogate — a character the draft does not contain — and would claim
    // twice as much was hidden as actually is.
    const emoji = "\u{1F642}";
    const body = emoji.repeat(700);
    await mount(card({ drafts: [draft(1, { body })] }));

    const shown = screen.getByTestId("chat-email-batch-body").textContent ?? "";
    expect(Array.from(shown)).toHaveLength(600);
    expect(shown).not.toContain("�");
    // 700 characters, 600 shown, so 100 are folded away — not 800, which is
    // what counting UTF-16 units would have reported.
    expect(screen.getByTestId("chat-email-batch-expand")).toHaveTextContent("100");

    fireEvent.click(screen.getByTestId("chat-email-batch-expand"));
    expect(Array.from(screen.getByTestId("chat-email-batch-body").textContent ?? "")).toHaveLength(700);
  });

  it("shows a body of exactly the clamp length whole, with no control at all", async () => {
    await mount(card({ drafts: [draft(1, { body: "x".repeat(600) })] }));
    expect(screen.queryByTestId("chat-email-batch-expand")).not.toBeInTheDocument();
  });

  it("clamps a long body by code point, so no character is cut in half", async () => {
    // `slice` counts UTF-16 units. A clamp landing between the halves of a
    // surrogate pair renders U+FFFD in the middle of the owner's own message —
    // text that is not what the draft says, on the one card whose whole job is
    // showing exactly what will be sent. The folded-away count has the same
    // bug: "🙂".length is 2, so an emoji body would overstate what is hidden.
    const emoji = "🙂";
    const total = 700; // code points, comfortably past the 600 clamp
    await mount(card({ drafts: [draft(1, { body: emoji.repeat(total) })] }));

    const body = await screen.findByTestId("chat-email-batch-body");
    expect(body.textContent).not.toContain("�");
    expect(Array.from(body.textContent ?? "")).toHaveLength(600);

    // 700 code points shown 600 of them leaves 100 — not 800, which is what
    // counting UTF-16 units would have claimed.
    const toggle = screen.getByTestId("chat-email-batch-expand");
    expect(toggle).toHaveTextContent("100");

    fireEvent.click(toggle);
    expect(Array.from(screen.getByTestId("chat-email-batch-body").textContent ?? "")).toHaveLength(total);
  });

  it("never reduces the batch to a count", async () => {
    // The summary says how many, and the rows still say what. A card that only
    // said "send 3 emails?" would keep the click and throw the protection away.
    await mount(card());
    await screen.findByTestId("chat-email-batch-summary");
    expect(screen.getAllByTestId("chat-email-batch-body")).toHaveLength(3);
  });
});

describe("one gesture", () => {
  it("approves all three at once, naming each draft and its fingerprint", async () => {
    const { onApprove } = await mount(card());
    const button = await screen.findByTestId("chat-email-batch-approve");
    expect(button).toHaveTextContent("Send all 3");

    fireEvent.click(button);

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0][0]).toEqual({
      batchId: "batch-1",
      entries: [
        { id: "draft-1", fingerprint: "fingerprint-1" },
        { id: "draft-2", fingerprint: "fingerprint-2" },
        { id: "draft-3", fingerprint: "fingerprint-3" },
      ],
    });
  });

  it("drops exactly the draft that was unticked, and is still one approval", async () => {
    const { onApprove } = await mount(card());
    const checks = await screen.findAllByTestId("chat-email-batch-include");
    fireEvent.click(checks[1]);

    const button = screen.getByTestId("chat-email-batch-approve");
    expect(button).toHaveTextContent("Send all 2");
    fireEvent.click(button);

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0][0].entries.map((e: { id: string }) => e.id)).toEqual(["draft-1", "draft-3"]);
  });

  it("cannot be sent once every draft has been unticked", async () => {
    const { onApprove } = await mount(card());
    for (const check of await screen.findAllByTestId("chat-email-batch-include")) fireEvent.click(check);

    const button = screen.getByTestId("chat-email-batch-approve");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-email-batch-none")).toBeInTheDocument();
  });

  it("sends nothing when the owner cancels, and names what it is throwing away", async () => {
    // Cancelling used to hand back a bare batch id, because it only removed the
    // card from the screen. It deletes the drafts now, so it names them with
    // the fingerprints they were shown with — the same freeze approving keeps,
    // so a draft queued during the reading pause cannot be swept up either.
    const { onApprove, onCancel } = await mount(card());
    fireEvent.click(await screen.findByTestId("chat-email-batch-cancel"));
    expect(screen.getByTestId("chat-email-batch-cancel")).toHaveTextContent("Delete all 3 without sending");
    expect(onCancel).toHaveBeenCalledWith({
      batchId: "batch-1",
      entries: [
        { id: "draft-1", fingerprint: "fingerprint-1" },
        { id: "draft-2", fingerprint: "fingerprint-2" },
        { id: "draft-3", fingerprint: "fingerprint-3" },
      ],
    });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("leaves an already-decided draft out of a cancel", async () => {
    // It is not this click's to delete: it is already gone from the queue.
    const { onCancel } = await mount(
      card({ drafts: [draft(1), draft(2)], outcomes: [{ id: "draft-1", ok: true, kind: "sent" }] }),
    );
    fireEvent.click(await screen.findByTestId("chat-email-batch-cancel"));
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ id: "draft-2", fingerprint: "fingerprint-2" }] }),
    );
  });

  it("spares a draft the owner unticked, and says how many it will take", async () => {
    // The checkbox is documented in chat-email-batch.tsx as "how one draft is
    // dropped from the batch". It cannot mean "spare it" for the send button
    // and "delete it anyway" for the other one — and of the two readings, the
    // one that destroys less is the one to be wrong about. The count on the
    // button is what makes the set it acts on visible before the click.
    const { onCancel } = await mount(card({ drafts: [draft(1), draft(2)] }));
    await screen.findByTestId("chat-email-batch-cancel");
    fireEvent.click(screen.getAllByTestId("chat-email-batch-include")[0]);

    expect(screen.getByTestId("chat-email-batch-cancel")).toHaveTextContent("Delete it without sending");
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ id: "draft-2", fingerprint: "fingerprint-2" }] }),
    );
  });

  it("will not offer to delete an empty set", async () => {
    // Nothing ticked, nothing to delete — the same rule the send button keeps,
    // so neither control ever claims to act on nothing.
    await mount(card({ drafts: [draft(1)] }));
    fireEvent.click(await screen.findByTestId("chat-email-batch-include"));
    expect(screen.getByTestId("chat-email-batch-cancel")).toBeDisabled();
    expect(screen.getByTestId("chat-email-batch-approve")).toBeDisabled();
  });

  it("cannot be clicked twice while the first send is in flight", async () => {
    const { onApprove, onCancel } = await mount(card({ status: "sending" }));
    const button = await screen.findByTestId("chat-email-batch-approve");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));
    expect(onApprove).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("what actually happened", () => {
  it("reports a partial failure as a partial failure, per draft", async () => {
    await mount(
      card({
        status: "settled",
        outcomes: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: false, error: "The mail server refused the message." },
          { id: "draft-3", ok: true },
        ],
      }),
    );

    // Never "sent" on its own — the same false success this codebase already
    // shipped once as `{ restarted: true }` for a restart that had failed.
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result).toHaveTextContent("2 sent, 1 not sent.");

    const rows = screen.getAllByTestId("chat-email-batch-draft");
    expect(within(rows[1]).getByTestId("chat-email-batch-outcome")).toHaveTextContent(
      "The mail server refused the message.",
    );
    expect(within(rows[0]).getByTestId("chat-email-batch-outcome")).toHaveTextContent("Sent");
    // The text of the message that did not go is still on screen, so nothing
    // the owner approved is lost to a transient error.
    expect(within(rows[1]).getByTestId("chat-email-batch-body")).toHaveTextContent("The body of message 2.");
  });

  it("says so plainly when everything went", async () => {
    await mount(
      card({
        status: "settled",
        outcomes: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: true },
          { id: "draft-3", ok: true },
        ],
      }),
    );
    expect(await screen.findByTestId("chat-email-batch-result")).toHaveTextContent("3 sent.");
    // The controls are gone: there is nothing left to approve.
    expect(screen.queryByTestId("chat-email-batch-approve")).not.toBeInTheDocument();
  });

  it("does not call a settled batch with no outcomes a send", async () => {
    // The route answers with an empty `results` when the approval was cut short
    // before a single draft was claimed. A verdict computed from the failure
    // count alone finds zero failures here and would render "0 sent." in the
    // colour that means it went well.
    await mount(card({ status: "settled", outcomes: [] }));
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result).toHaveTextContent("Nothing was sent");
    expect(result.textContent).not.toContain("0 sent.");
    // No draft carries a tick either.
    expect(screen.queryAllByTestId("chat-email-batch-outcome")).toHaveLength(0);
  });

  it("puts the button back when the approval itself could not be delivered", async () => {
    await mount(card({ requestError: "The approval could not be delivered." }));
    expect(await screen.findByTestId("chat-email-batch-error")).toBeInTheDocument();
    expect(screen.getByTestId("chat-email-batch-approve")).toBeEnabled();
  });
});

describe("reachable without a mouse", () => {
  it("names the region, and announces the summary politely", async () => {
    await mount(card());
    const region = await screen.findByTestId("chat-email-batch");
    expect(region.tagName).toBe("SECTION");
    expect(region).toHaveAccessibleName("Email waiting for your approval");

    const summary = screen.getByTestId("chat-email-batch-summary");
    expect(summary).toHaveAttribute("role", "status");
    // Polite, never assertive: it lands while the customer may still be reading
    // the reply above it.
    expect(summary).toHaveAttribute("aria-live", "polite");
  });

  it("gives each include checkbox its own label, naming the draft it drops", async () => {
    await mount(card());
    const checks = await screen.findAllByTestId("chat-email-batch-include");
    // Distinct names, so a screen reader listing the controls does not read
    // three identical checkboxes.
    const names = checks.map((check) => check.getAttribute("id"));
    expect(new Set(names).size).toBe(3);
    for (const [index, check] of checks.entries()) {
      expect(check).toHaveAccessibleName(expect.stringContaining(`Subject ${index + 1}`) as unknown as string);
    }
  });

  it("moves the caret to the outcome once the buttons it was on are gone", async () => {
    await mount(card({ status: "settled", settledByOwner: true, outcomes: [{ id: "draft-1", ok: true }] }));
    const result = await screen.findByTestId("chat-email-batch-result");
    await waitFor(() => expect(document.activeElement).toBe(result));
    // A destination, not a tab stop: the card has finished being a control.
    expect(result).toHaveAttribute("tabindex", "-1");
  });
});

describe("edition accent", () => {
  it("wears Hermes green on a Hermes box", async () => {
    await mount(card(), { hermes: true });
    const button = await screen.findByTestId("chat-email-batch-approve");
    expect(button.getAttribute("style")).toContain("rgb(18, 214, 164)");
  });

  it("wears OpenClaw coral otherwise", async () => {
    await mount(card(), { hermes: false });
    const button = await screen.findByTestId("chat-email-batch-approve");
    expect(button.getAttribute("style")).toContain("--coral-bright");
  });
});

// ── Endings the card learned from the store ──────────────────────────────────
//
// Three of these cannot come from the card's own approval request: a draft the
// owner deleted in Settings, one whose twin was sent so it needed no send of
// its own, and one that simply is not in the queue any more. They arrive
// through `reconcileBatchCards`, and each has to read as itself — a single
// "not sent" over all three would tell the owner to go and look at something
// that is already handled.

describe("a draft decided somewhere other than this card", () => {
  it("gives each ending its own words, and takes its controls away", async () => {
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2), draft(3)],
        outcomes: [
          { id: "draft-1", ok: true, kind: "sent", at: Date.UTC(2026, 8, 3, 11, 30) },
          { id: "draft-2", ok: false, kind: "rejected" },
          { id: "draft-3", ok: false, kind: "duplicate" },
        ],
      }),
    );

    const rows = screen.getAllByTestId("chat-email-batch-draft");
    // The time is what answers "did that go out before I left?".
    expect(within(rows[0]).getByTestId("chat-email-batch-outcome")).toHaveTextContent(/^Sent ✓ at /);
    expect(within(rows[1]).getByTestId("chat-email-batch-outcome")).toHaveTextContent("Removed — not sent");
    expect(within(rows[2]).getByTestId("chat-email-batch-outcome")).toHaveTextContent(
      "Already sent as an identical message",
    );
    for (const box of screen.getAllByTestId("chat-email-batch-include")) expect(box).toBeDisabled();
  });

  it("counts only what is still waiting on the button", async () => {
    // Two drafts, one already decided elsewhere. The card is still a live
    // control for the other — and must say "Send it", not "Send all 2".
    await mount(
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: true, kind: "sent", at: Date.UTC(2026, 8, 3, 11, 30) }],
      }),
    );
    const approve = await screen.findByTestId("chat-email-batch-approve");
    expect(approve).toHaveTextContent("Send it");
    expect(within(screen.getAllByTestId("chat-email-batch-draft")[0]).getByTestId("chat-email-batch-include"))
      .toBeDisabled();
  });

  it("sends only the drafts that are still waiting", async () => {
    const { onApprove } = await mount(
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: true, kind: "sent" }],
      }),
    );
    fireEvent.click(await screen.findByTestId("chat-email-batch-approve"));
    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ id: "draft-2", fingerprint: "fingerprint-2" }] }),
    );
  });

  it("says it is deleting while it deletes, never that it is sending", async () => {
    // The two in-flight states shared one status, so the amber card's primary
    // button read "Sending…" over the messages the owner had just said must not
    // be sent — the surface asserting the opposite of what it is doing, for as
    // long as the round trip takes.
    await mount(card({ status: "deleting", drafts: [draft(1), draft(2)] }));
    expect(screen.getByTestId("chat-email-batch-cancel")).toHaveTextContent("Deleting…");
    expect(screen.getByTestId("chat-email-batch-approve")).not.toHaveTextContent("Sending…");
    // Neither button may be pressed while the request is out.
    expect(screen.getByTestId("chat-email-batch-approve")).toBeDisabled();
    expect(screen.getByTestId("chat-email-batch-cancel")).toBeDisabled();
  });

  it("paints an ending the owner chose in the colour of a note, not of a fault", async () => {
    // The summary line already learned this: "0 sent, 2 not sent." in red over
    // a card the owner deliberately emptied is a false alarm about his own act.
    // The per-draft line is the same claim in a smaller place and was still
    // making it — every ending that is not a failure was painted ERROR_FG.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2), draft(3), draft(4), draft(5)],
        outcomes: [
          { id: "draft-1", ok: true, kind: "sent" },
          { id: "draft-2", ok: false, kind: "rejected" },
          { id: "draft-3", ok: false, kind: "duplicate" },
          { id: "draft-4", ok: false, kind: "gone" },
          { id: "draft-5", ok: false, kind: "failed", error: "mailbox unavailable" },
        ],
      }),
    );
    const colourOf = (index: number) =>
      getComputedStyle(
        within(screen.getAllByTestId("chat-email-batch-draft")[index]).getByTestId("chat-email-batch-outcome"),
      ).color;

    // Green for the one that went, red for the one the mail server refused —
    // and the three that simply left without being sent read as notes.
    expect(colourOf(0)).toBe("rgb(134, 239, 172)");
    expect(colourOf(4)).toBe("rgb(248, 113, 113)");
    for (const index of [1, 2, 3]) {
      expect(colourOf(index)).toBe("rgba(255, 255, 255, 0.5)");
      expect(colourOf(index)).not.toBe(colourOf(4));
    }
  });

  it("does not paint an unconfirmed send as a refusal", async () => {
    // Amber, the colour of "look at this", not red, the colour of "this went
    // wrong" — the box handed the message over and never heard back.
    await mount(
      card({ status: "settled", drafts: [draft(1)], outcomes: [{ id: "draft-1", ok: false, kind: "unconfirmed" }] }),
    );
    expect(getComputedStyle(screen.getByTestId("chat-email-batch-outcome")).color).toBe("rgb(252, 211, 77)");
  });

  it("never says a send nobody could confirm was decided somewhere else", async () => {
    // The row says "the box could not tell"; a verdict saying the message was
    // handled elsewhere over the top of it is the two disagreeing, and the
    // reading that gets a delivered message sent a second time.
    await mount(
      card({ status: "settled", drafts: [draft(1)], outcomes: [{ id: "draft-1", ok: false, kind: "unconfirmed" }] }),
    );
    const summary = screen.getByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("not confirmed");
    expect(summary).not.toHaveTextContent("decided somewhere else");
    // Amber, like the row: something to look at, not something that failed.
    expect(getComputedStyle(summary).color).toBe("rgb(252, 211, 77)");
  });

  it("does not count a draft handled elsewhere as one that failed to send", async () => {
    // One went from this card; the other had already been decided in Settings
    // or on Telegram. "1 sent, 1 not sent." in red would be this card claiming
    // a fault over something that is not one — and is not even its business.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: true, kind: "sent" },
          { id: "draft-2", ok: false, kind: "gone" },
        ],
      }),
    );
    const summary = screen.getByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("1 sent.");
    expect(summary).not.toHaveTextContent("not sent");
  });

  it("says so plainly when everything on it was decided somewhere else", async () => {
    await mount(
      card({ status: "settled", drafts: [draft(1)], outcomes: [{ id: "draft-1", ok: false, kind: "gone" }] }),
    );
    const summary = screen.getByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("decided somewhere else");
    // Never "0 deleted": this card deleted nothing. And never a claim about
    // whether the message went — the same line covers a send this box handed
    // over and could not confirm, and only the row can say which it was.
    expect(summary).not.toHaveTextContent("deleted");
    expect(summary).not.toHaveTextContent("sent");
  });

  it("says a draft that left the queue with no word about it is no longer waiting", async () => {
    await mount(
      card({ status: "settled", drafts: [draft(1)], outcomes: [{ id: "draft-1", ok: false, kind: "gone" }] }),
    );
    expect(screen.getByTestId("chat-email-batch-outcome")).toHaveTextContent("No longer waiting");
  });
});

describe("reconciling live cards against the store", () => {
  it("settles a card whose drafts have all been decided", async () => {
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1), draft(2)] })];
    const after = reconcileBatchCards(
      before,
      new Set<string>(),
      new Map([
        ["draft-1", { id: "draft-1", ok: true, kind: "sent" as const }],
        ["draft-2", { id: "draft-2", ok: false, kind: "rejected" as const }],
      ]),
    );
    expect(after[0].status).toBe("settled");
    expect(after[0].outcomes.map((o) => o.kind)).toEqual(["sent", "rejected"]);
  });

  it("leaves a card whose drafts are all still waiting exactly as it was", async () => {
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1)] })];
    // The SAME array back, not a copy: a fresh one is a re-render on every poll.
    expect(reconcileBatchCards(before, new Set(["draft-1"]), new Map())).toBe(before);
  });

  it("keeps a card open while one of its drafts is still waiting", async () => {
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1), draft(2)] })];
    const after = reconcileBatchCards(
      before,
      new Set(["draft-2"]),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const }]]),
    );
    expect(after[0].status).toBe("waiting");
    expect(after[0].outcomes).toHaveLength(1);
  });

  it("does not touch a card that is mid-send", async () => {
    // Its own approval request owns it and will settle it; a poll landing in
    // that window must not decide the card out from under the response.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [card({ status: "sending", drafts: [draft(1)] })];
    expect(reconcileBatchCards(before, new Set<string>(), new Map())).toBe(before);
  });
});

describe("a verdict that does not cry wolf", () => {
  it("calls a deletion a deletion, not a failure to send", async () => {
    // "0 sent, 2 not sent." in the colour that means something needs doing, over
    // a card the owner deliberately emptied, is a false alarm about their own
    // act — and it trains them to ignore the line that does matter.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: false, kind: "rejected" },
          { id: "draft-2", ok: false, kind: "rejected" },
        ],
      }),
    );
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result).toHaveTextContent("2 deleted. Nothing was sent.");
    expect(result.textContent).not.toContain("not sent.");
  });

  it("still reports a real failure as one, alongside what did go", async () => {
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2), draft(3)],
        outcomes: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: false, error: "The mail server refused the message." },
          { id: "draft-3", ok: false, kind: "rejected" },
        ],
      }),
    );
    // The deleted one is not counted as a failure; the refused one is.
    expect(await screen.findByTestId("chat-email-batch-result")).toHaveTextContent("1 sent, 1 not sent.");
  });

  it("does not let a covered duplicate turn a clean batch into a partial one", async () => {
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: true },
          { id: "draft-2", ok: false, kind: "duplicate" },
        ],
      }),
    );
    expect(await screen.findByTestId("chat-email-batch-result")).toHaveTextContent("1 sent.");
  });
});

// ── What the card's own answer may overwrite ─────────────────────────────────
//
// A card can learn two things at once: the store's word about drafts decided
// somewhere else (`reconcileBatchCards`, from the poll), and the route's word
// about the drafts it just posted (`settleCard`). They cover different ids by
// construction — the posted set excludes anything already decided — so one may
// never replace the other wholesale.

describe("settling a card against its own request", () => {
  it("keeps the verdicts the poll had already written", async () => {
    const { settleCard } = await import("@/lib/chat-email-batch");
    // Draft 1 was approved on Telegram and reconciled in; draft 2 is the one
    // the owner then sent from this card.
    const before = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: true, kind: "sent", at: 1_700_000_000_500 }],
      }),
    ];
    const after = settleCard(before, "batch-1", [{ id: "draft-2", ok: true }]);

    expect(after[0].status).toBe("settled");
    // Both, in the order they were learned. Replacing wholesale left draft 1
    // with no verdict, its checkbox live again, and "1 sent." over two rows.
    expect(after[0].outcomes.map((o) => o.id)).toEqual(["draft-1", "draft-2"]);
  });

  it("lets the route's answer beat a verdict the poll guessed mid-flight", async () => {
    const { settleCard } = await import("@/lib/chat-email-batch");
    // A poll that landed while the send was in flight can have recorded a
    // premature "gone". The route was there; it knows better.
    const before = [
      card({ drafts: [draft(1)], outcomes: [{ id: "draft-1", ok: false, kind: "gone" }] }),
    ];
    const after = settleCard(before, "batch-1", [{ id: "draft-1", ok: true }]);
    expect(after[0].outcomes).toEqual([{ id: "draft-1", ok: true }]);
  });

  it("stays WAITING while a draft still has no ending", async () => {
    // A settled card is skipped by the reconcile and never rebuilt by
    // `batchFromPending`, so settling early makes a draft unmentionable for the
    // life of the component. This is the deletion-partly-failed case.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1), draft(2)] })];
    const after = settleCard(before, "batch-1", [{ id: "draft-1", ok: false, kind: "rejected" }]);
    expect(after[0].status).toBe("waiting");
    expect(after[0].outcomes).toHaveLength(1);
  });

  it("clears a request error the store has now answered", async () => {
    // "Nothing was sent" in red directly above "1 sent." in green.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1)], requestError: "The approval could not be delivered." })];
    expect(settleCard(before, "batch-1", [{ id: "draft-1", ok: true }])[0].requestError).toBe("");
  });
});

describe("who is allowed to move the caret", () => {
  it("does not take focus when a background poll settled the card", async () => {
    // This chat never steals focus. The commonest reconcile trigger is
    // `window.focus` — the owner clicking back into the tab — and taking the
    // caret there pulls it out of the composer they are typing in.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const settled = reconcileBatchCards(
      [card({ drafts: [draft(1)] })],
      new Set<string>(),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const }]]),
    );
    expect(settled[0].status).toBe("settled");
    expect(settled[0].settledByOwner).not.toBe(true);

    const composer = document.createElement("input");
    document.body.appendChild(composer);
    composer.focus();
    await mount(settled[0]);
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("still takes focus when the owner's own click settled it", async () => {
    // Approving REMOVES the control that was focused; focus falling to the body
    // leaves a keyboard user with no idea whether the mail went.
    await mount(card({ status: "settled", settledByOwner: true, outcomes: [{ id: "draft-1", ok: true }] }));
    expect(document.activeElement).toBe(await screen.findByTestId("chat-email-batch-result"));
  });
});

describe("an unconfirmed send", () => {
  it("does not claim the message was not sent", async () => {
    await mount(
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "unconfirmed" }],
      }),
    );
    const line = await screen.findByTestId("chat-email-batch-outcome");
    expect(line).toHaveTextContent(/could not tell/i);
    expect(line.textContent).not.toMatch(/^Not sent/);
    // And it is not counted among the failures, which would put a red
    // "0 sent, 1 not sent." over something nobody knows the answer to.
    expect(await screen.findByTestId("chat-email-batch-result")).not.toHaveTextContent("not sent.");
  });
});
