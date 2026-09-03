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

/** The card's own colours, as jsdom serialises them. */
const OK_FG = "rgb(134, 239, 172)";
const WARN_FG = "rgb(252, 211, 77)";

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
    expect(button).toHaveAttribute("aria-disabled", "true");
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
    const { onApprove, onCancel } = await mount(card({ drafts: [draft(1)] }));
    fireEvent.click(await screen.findByTestId("chat-email-batch-include"));
    const cancel = screen.getByTestId("chat-email-batch-cancel");
    const approve = screen.getByTestId("chat-email-batch-approve");
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    expect(approve).toHaveAttribute("aria-disabled", "true");
    // Announced as unavailable AND actually unpressable: the guard is in the
    // handler, not in an attribute the browser may or may not honour.
    fireEvent.click(cancel);
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps both controls reachable, and says why they are inert", async () => {
    // The escape from an empty selection is to tick something again, and a
    // native `disabled` took both buttons OUT of the sequential focus order —
    // so a keyboard or screen-reader user landed on neither them nor the
    // sentence beside them, and the card had simply gone quiet. `aria-disabled`
    // keeps the stop; `aria-describedby` is what makes the reason audible from
    // the control the user is standing on.
    await mount(card({ drafts: [draft(1)] }));
    fireEvent.click(await screen.findByTestId("chat-email-batch-include"));

    const reason = screen.getByTestId("chat-email-batch-none");
    expect(reason.id).toBeTruthy();
    for (const id of ["chat-email-batch-approve", "chat-email-batch-cancel"]) {
      const button = screen.getByTestId(id);
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute("aria-describedby", reason.id);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
    expect(reason).toHaveTextContent("No messages are selected");
  });

  it("cannot be clicked twice while the first send is in flight", async () => {
    const { onApprove, onCancel } = await mount(card({ status: "sending" }));
    const button = await screen.findByTestId("chat-email-batch-approve");
    expect(button).toHaveAttribute("aria-disabled", "true");
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
    expect(screen.getByTestId("chat-email-batch-approve")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("chat-email-batch-cancel")).toHaveAttribute("aria-disabled", "true");
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

  it("lets a receipt correct a 'gone' the poll had only guessed at", async () => {
    // Every approval path claims the draft BEFORE it sends and writes the
    // receipt after, so for the length of an SMTP conversation the draft is in
    // neither list. A poll landing in that window recorded "gone" — and, with
    // `known` seeded from every outcome, never looked at that draft again. A
    // permanent shrug over a message that went out.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const caught = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    const after = reconcileBatchCards(
      caught,
      new Set(["draft-2"]),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const, at: 1_700_000_000_500 }]]),
    );
    expect(after[0].outcomes).toHaveLength(1);
    expect(after[0].outcomes[0]).toMatchObject({ kind: "sent", at: 1_700_000_000_500 });
  });

  it("does not replace an ending the store actually recorded", async () => {
    // Only the guess is provisional. A real receipt is the store's word and a
    // later poll must not overwrite it — nor churn the card into a re-render.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: false, kind: "rejected" }],
      }),
    ];
    expect(
      reconcileBatchCards(
        before,
        new Set(["draft-2"]),
        new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const }]]),
      ),
    ).toBe(before);
  });

  it("leaves a guessed 'gone' alone when the poll learned nothing new", async () => {
    // No receipt, no better information — and no re-render either.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    expect(reconcileBatchCards(before, new Set(["draft-2"]), new Map())).toBe(before);
  });

  it("withdraws a guessed 'gone' for a draft that came BACK to the queue", async () => {
    // The guess is provisional in BOTH directions or it is not provisional.
    // `approve_batch` restores a draft it claimed when the tab that posted it
    // aborts before the first byte (`restorePending`), and a second tab that
    // polled inside that claim window has already written "No longer waiting —
    // it was handled elsewhere" over it. The draft is queued and still waiting;
    // the card dropped it from `included` and can never rebuild one for it,
    // because `shownDraftIds` still covers it. Answerable in Settings → Email
    // only — a live draft with no control on the surface that offered it.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: false, kind: "gone" },
          { id: "draft-2", ok: true, kind: "sent" },
        ],
      }),
    ];
    const after = reconcileBatchCards(before, new Set(["draft-1"]), new Map());
    expect(after[0].outcomes.map((o) => o.id)).toEqual(["draft-2"]);
    // And it must NOT settle: draft-1 is a live draft again, so the card is
    // still a control for it.
    expect(after[0].status).toBe("waiting");
  });

  it("never withdraws a REAL ending, only the guess", async () => {
    // A receipt is not provisional. A draft the store answered `rejected` and
    // then somehow listed as pending again keeps its ending: taking that away
    // would put an Approve button back over a decision already made.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: true, kind: "rejected" }],
      }),
    ];
    expect(reconcileBatchCards(before, new Set(["draft-1"]), new Map())).toBe(before);
  });

  it("leaves a SETTLED card's 'gone' alone when the draft comes back", async () => {
    // Deliberately one-sided. Re-opening a settled card would hand the owner a
    // live Approve button under a verdict he has already read, which is the
    // exact defect the settled-card guard exists for — so a draft that returns
    // after the card closed is Settings → Email's to answer.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    expect(reconcileBatchCards(before, new Set(["draft-1"]), new Map())).toBe(before);
  });

  it("still settles a card whose last draft only ever got a 'gone'", async () => {
    // "Provisional" must not mean "never decided": a card that could not settle
    // would keep a live Approve button over mail that is no longer waiting,
    // which is the defect this whole card was rebuilt to remove.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const after = reconcileBatchCards([card({ drafts: [draft(1)] })], new Set<string>(), new Map());
    expect(after[0].status).toBe("settled");
    expect(after[0].outcomes.map((o) => o.kind)).toEqual(["gone"]);
  });

  it("corrects a guessed 'gone' on a card that has already settled", async () => {
    // The half of the provisional-guess rule the first pass did not reach. A
    // one-draft card whose only draft was caught in the claim-to-send window
    // settles on the guess immediately, and the receipt — which lives 24 h —
    // arrives afterwards. Skipping settled cards made that guess permanent,
    // which is the "vague word here is permanent" hazard, on the client.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    const after = reconcileBatchCards(
      before,
      new Set<string>(),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const, at: 1_700_000_000_500 }]]),
    );
    expect(after[0].outcomes[0]).toMatchObject({ kind: "sent", at: 1_700_000_000_500 });
    // Corrected, never RE-OPENED: a settled card that went live again would put
    // an Approve button back over mail that is no longer waiting.
    expect(after[0].status).toBe("settled");
  });

  it("weighs that correction against the gesture that settled the card", async () => {
    // The third producer, and the one the settled-card pass above opened. The
    // receipt is the POLL'S, written `ok: kind === "sent"` because a waiting
    // card is offering to send — the right default, and exactly wrong on a card
    // the owner settled with *Delete without sending*. Without the gesture the
    // card flipped to a green "1 sent." the moment the receipt landed, over the
    // click that asked for that message NOT to go out.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "delete",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    const after = reconcileBatchCards(
      before,
      new Set<string>(),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const, at: 1_700_000_000_500 }]]),
    );
    // The WORDS are the receipt's and unchanged — it really was sent, and
    // softening that would hide the one thing he has to know.
    expect(after[0].outcomes[0]).toMatchObject({ kind: "sent", at: 1_700_000_000_500 });
    // The VERDICT is the gesture's: this is the worst news on that card.
    expect(after[0].outcomes[0].ok).toBe(false);
  });

  it("reads a send as good news on a card the owner approved", async () => {
    // The other direction, and the guard on the rule above: an approve answered
    // "sent" is exactly what was asked for, and must stay green.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "approve",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    const after = reconcileBatchCards(
      before,
      new Set<string>(),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const }]]),
    );
    expect(after[0].outcomes[0]).toMatchObject({ kind: "sent", ok: true });
  });

  it("still reads a send as good news on a card no gesture settled", async () => {
    // A card a poll settled by itself has no gesture to weigh anything against,
    // and what it was OFFERING to do is send — so the poll's own reading stands.
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    const after = reconcileBatchCards(
      before,
      new Set<string>(),
      new Map([["draft-1", { id: "draft-1", ok: true, kind: "sent" as const }]]),
    );
    expect(after[0].outcomes[0]).toMatchObject({ kind: "sent", ok: true });
  });

  it("does not re-open a settled card, or touch one it has nothing better for", async () => {
    const { reconcileBatchCards } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "gone" }],
      }),
    ];
    // No receipt, nothing learned — the same array back, so no re-render.
    expect(reconcileBatchCards(before, new Set<string>(), new Map())).toBe(before);
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

  it("does not answer an APPROVE with '1 deleted. Nothing was sent.'", async () => {
    // One draft, approved, and an identical message this very batch had already
    // sent covered it — `dropDuplicatesOf`, answered `ending: "duplicate"`. Two
    // contradictions in one sentence: the message DID reach the recipient, and
    // this card deleted nothing. `discardedCount` counts a duplicate on the
    // ending alone, which is right for a delete and wrong for the click that
    // was asking to send.
    await mount(
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "approve",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: true, kind: "duplicate" }],
      }),
    );
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result).toHaveTextContent("decided somewhere else");
    expect(result.textContent).not.toContain("deleted");
    // The row still says exactly what happened; only the summary changes.
    expect(screen.getByTestId("chat-email-batch-outcome")).toHaveTextContent(
      "Already sent as an identical message",
    );
  });

  it("does not answer a DELETE over a duplicate with 'Nothing was sent.'", async () => {
    // The other half of the same contradiction, and the one that costs the
    // owner. He deleted a draft an identical message had already covered: the
    // words DID reach the recipient, and "Nothing was sent." sat directly under
    // a row saying so. That is the sentence that gets a message sent twice.
    await mount(
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "delete",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: true, kind: "duplicate" }],
      }),
    );
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result.textContent).not.toContain("Nothing was sent");
    expect(result.textContent).not.toContain("deleted");
    expect(screen.getByTestId("chat-email-batch-outcome")).toHaveTextContent(
      "Already sent as an identical message",
    );
  });

  it("does not say 'Nothing was sent.' when a deletion sits BESIDE a duplicate", async () => {
    // The same contradiction one draft further along, and the shape the guard
    // above misses: he pressed *Delete without sending* over two drafts, one of
    // which an identical message had already covered. `resultDiscarded` was
    // gated on `deletedCount`, so a single real deletion beside the duplicate
    // put "Nothing was sent." back over a message that reached the recipient —
    // the sentence that gets it sent twice.
    await mount(
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "delete",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: true, kind: "duplicate" },
          { id: "draft-2", ok: true, kind: "rejected" },
        ],
      }),
    );
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result.textContent).not.toContain("Nothing was sent");
    // And neither half is dropped: the deletion he made AND the copy that went.
    expect(result).toHaveTextContent("1 deleted");
    expect(result).toHaveTextContent("identical message");
    expect(within(screen.getByTestId("chat-email-batch")).getAllByTestId("chat-email-batch-outcome")[0])
      .toHaveTextContent("Already sent as an identical message");
  });

  it("still tells an APPROVE that nothing went out", async () => {
    // Reserving "{n} deleted." for a delete must not cost the owner the half of
    // that sentence which was true. He pressed *Approve & send*; the drafts had
    // been deleted somewhere else, so nothing went out — and "did my send
    // happen?" is the only question that click was asking.
    await mount(
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "approve",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "rejected" }],
      }),
    );
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result).toHaveTextContent("Nothing was sent");
    // But it does not claim THIS card deleted anything.
    expect(result.textContent).not.toContain("deleted");
  });

  it("still says what a DELETE threw away", async () => {
    // The guard on the rule above: over a deletion "1 deleted." is the honest
    // sentence, and so it is on a card no gesture settled — a poll that found
    // the draft deleted in Settings is reporting a deletion either way.
    await mount(
      card({
        status: "settled",
        settledByOwner: true,
        lastGesture: "delete",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: true, kind: "rejected" }],
      }),
    );
    expect(await screen.findByTestId("chat-email-batch-result")).toHaveTextContent("1 deleted.");
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

  it("does not congratulate the owner for a send he was deleting", async () => {
    // He pressed *Delete all 2 without sending*; one of them had been approved
    // on Telegram while he was reading and went out. Reading the ending without
    // the gesture painted that row green "Sent ✓" and settled the card on a
    // green "1 sent." — the box congratulating him for the one thing he was
    // trying to prevent, with the deletion he DID get dropped from the verdict
    // because a single sentence can only be the head of the chain once.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: true, kind: "rejected" },
          { id: "draft-2", ok: false, kind: "sent", at: 1_700_000_000_500 },
        ],
      }),
    );
    const summary = await screen.findByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("1 deleted, 1 already sent");
    expect(summary).toHaveTextContent("check your Sent folder");
    // Never the green all-sent line, and never a claim that nothing went out.
    expect(summary.textContent).not.toContain("1 sent.");
    expect(summary).not.toHaveTextContent("Nothing was sent");
    expect(summary.style.color).toBe(WARN_FG);
  });

  it("does not say '0 sent' over a message the row above says went out", async () => {
    // The failure branch QUOTES a number of sends inside a sentence about
    // failures, and that number has to be about the mail rather than about the
    // click. Narrowing it to "sent, and that is what you asked for" made a
    // delete gesture answer "0 sent, 1 not sent." in red over a card whose own
    // row two lines up reads "Sent ✓ at 11:34" — the false failure this chain
    // exists to prevent, arriving through the arithmetic.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: false, kind: "sent", at: 1_700_000_000_500 },
          { id: "draft-2", ok: false, kind: "failed", error: "The mail server refused the message." },
        ],
      }),
    );
    const summary = await screen.findByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("1 sent, 1 not sent.");
    expect(summary.textContent).not.toContain("0 sent");
  });

  it("counts the same way when the other one could not be confirmed", async () => {
    await mount(
      card({
        status: "settled",
        drafts: [draft(1), draft(2)],
        outcomes: [
          { id: "draft-1", ok: false, kind: "sent", at: 1_700_000_000_500 },
          { id: "draft-2", ok: false, kind: "unconfirmed" },
        ],
      }),
    );
    const summary = await screen.findByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("1 sent, 1 not confirmed");
    expect(summary.textContent).not.toContain("0 sent");
  });

  it("says so on its own when the only draft had already gone out", async () => {
    await mount(
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "sent", at: 1_700_000_000_500 }],
      }),
    );
    const summary = await screen.findByTestId("chat-email-batch-result");
    expect(summary).toHaveTextContent("1 already sent");
    // Never "0 deleted": this card deleted nothing.
    expect(summary).not.toHaveTextContent("0 deleted");
    expect(summary.style.color).toBe(WARN_FG);
  });

  it("keeps the row honest about the send while taking the green off it", async () => {
    // The words are the receipt's — it really was sent, and softening that
    // would hide the one thing he has to know. The colour is the gesture's.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: false, kind: "sent", at: 1_700_000_000_500 }],
      }),
    );
    const row = await screen.findByTestId("chat-email-batch-outcome");
    expect(row.textContent).toMatch(/^Sent /);
    expect(row.textContent).not.toContain("Not sent");
    expect(row.style.color).not.toBe(OK_FG);
    expect(row.style.color).toBe(WARN_FG);
  });

  it("still paints a send the owner asked for green", async () => {
    // The guard on the rule above.
    await mount(
      card({
        status: "settled",
        drafts: [draft(1)],
        outcomes: [{ id: "draft-1", ok: true, kind: "sent", at: 1_700_000_000_500 }],
      }),
    );
    const row = await screen.findByTestId("chat-email-batch-outcome");
    expect(row.style.color).toBe(OK_FG);
    expect(screen.getByTestId("chat-email-batch-result").style.color).toBe(OK_FG);
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
    const after = settleCard(before, "batch-1", [{ id: "draft-2", ok: true }], "approve");

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
    const after = settleCard(before, "batch-1", [{ id: "draft-1", ok: true }], "approve");
    expect(after[0].outcomes).toEqual([{ id: "draft-1", ok: true }]);
  });

  it("stays WAITING while a draft still has no ending", async () => {
    // A settled card is skipped by the reconcile and never rebuilt by
    // `batchFromPending`, so settling early makes a draft unmentionable for the
    // life of the component. This is the deletion-partly-failed case.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1), draft(2)] })];
    const after = settleCard(before, "batch-1", [{ id: "draft-1", ok: false, kind: "rejected" }], "delete");
    expect(after[0].status).toBe("waiting");
    expect(after[0].outcomes).toHaveLength(1);
  });

  it("re-reads a send the poll recorded against the gesture that settles the card", async () => {
    // The sibling producer. `reconcileBatchCards` has no gesture, so it reads a
    // send as good news — right while the card is offering to send, and wrong
    // the moment a DELETE settles on top of it. Without this the card answered
    // "Delete it without sending" with a green "1 sent." about a message this
    // click never touched, and the deletion he did get vanished from the line.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: true, kind: "sent", at: 1_700_000_000_500 }],
      }),
    ];
    const after = settleCard(before, "batch-1", [{ id: "draft-2", ok: true, kind: "rejected" }], "delete");
    // The WORDS are untouched — it really was sent, and the row still says so.
    expect(after[0].outcomes[0]).toMatchObject({ id: "draft-1", ok: false, kind: "sent", at: 1_700_000_000_500 });
  });

  it("leaves that same row alone when the gesture was a send", async () => {
    const { settleCard } = await import("@/lib/chat-email-batch");
    const kept = { id: "draft-1", ok: true, kind: "sent" as const, at: 1_700_000_000_500 };
    const before = [card({ drafts: [draft(1), draft(2)], outcomes: [kept] })];
    const after = settleCard(before, "batch-1", [{ id: "draft-2", ok: true, kind: "sent" }], "approve");
    // The very same object back: nothing crossed, so nothing is rebuilt.
    expect(after[0].outcomes[0]).toBe(kept);
  });

  it("records WHICH gesture the owner made", async () => {
    // Not decoration: a poll that corrects one of these rows later has no
    // gesture of its own, and reads a send as good news. This is the only place
    // the card can learn that the click was a deletion.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1)] })];
    expect(settleCard(before, "batch-1", [{ id: "draft-1", ok: true, kind: "rejected" }], "delete")[0]).toMatchObject({
      status: "settled",
      settledByOwner: true,
      lastGesture: "delete",
    });
    expect(settleCard(before, "batch-1", [{ id: "draft-1", ok: true }], "approve")[0]).toMatchObject({
      lastGesture: "approve",
    });
  });

  it("keeps the gesture on a card the click only PARTLY answered", async () => {
    // The half a settle-gated field forgets, and the one that matters most. A
    // click that answers only some of the drafts — the owner unticked one, or
    // the route refused one whose text had moved — leaves the card waiting for
    // the poll to finish it, and the poll has no gesture of its own to write.
    // Recorded only on the settle, such a card reached the correction carrying
    // a deletion it could not see, and went green anyway.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1), draft(2)] })];
    const after = settleCard(before, "batch-1", [{ id: "draft-1", ok: true, kind: "rejected" }], "delete");
    expect(after[0].status).toBe("waiting");
    expect(after[0].lastGesture).toBe("delete");
    // The caret licence is a different question and stays gated on the settle:
    // the card has not finished being a control.
    expect(after[0].settledByOwner).toBeUndefined();
  });

  it("weighs a later correction against a PARTIAL delete", async () => {
    // The two halves together, which is the shape the field exists for: a
    // partial delete, then the poll finishes the card, then the receipt behind
    // the guessed "gone" lands.
    const { reconcileBatchCards, settleCard } = await import("@/lib/chat-email-batch");
    // Only draft-1 is answered — draft-2 was unticked, so it is not in the
    // request at all and the card is handed back LIVE.
    const clicked = settleCard(
      [card({ drafts: [draft(1), draft(2)] })],
      "batch-1",
      [{ id: "draft-1", ok: true, kind: "rejected" }],
      "delete",
    );
    expect(clicked[0].status).toBe("waiting");
    // The poll finishes the card, with no gesture of its own: draft-2 left the
    // queue while another surface was mid-send, so it is only guessed at.
    const settled = reconcileBatchCards(clicked, new Set<string>(), new Map());
    expect(settled[0].status).toBe("settled");
    expect(settled[0].outcomes.find((o) => o.id === "draft-2")).toMatchObject({ kind: "gone" });
    const corrected = reconcileBatchCards(
      settled,
      new Set<string>(),
      new Map([["draft-2", { id: "draft-2", ok: true, kind: "sent" as const }]]),
    );
    // The words are the receipt's; the verdict is the deletion he asked for.
    expect(corrected[0].outcomes.find((o) => o.id === "draft-2")).toMatchObject({ kind: "sent", ok: false });
  });

  it("reads a deletion recorded elsewhere as what a DELETE asked for", async () => {
    // The rest of the table, not just the sent row. A poll writes a `rejected`
    // receipt `ok: false` because a waiting card is offering to send — and a
    // deletion is precisely what this gesture asked for, which is what
    // `emailRowOutcome` already writes for the identical event. One row shaped
    // two ways on one card is the latency this whole change removes.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [
      card({
        drafts: [draft(1), draft(2)],
        outcomes: [{ id: "draft-1", ok: false, kind: "rejected" }],
      }),
    ];
    const after = settleCard(before, "batch-1", [{ id: "draft-2", ok: true, kind: "rejected" }], "delete");
    expect(after[0].outcomes[0]).toMatchObject({ id: "draft-1", ok: true, kind: "rejected" });
    // And an approve still reads the same row as the bad news it is.
    const asApprove = settleCard(before, "batch-1", [{ id: "draft-2", ok: true, kind: "sent" }], "approve");
    expect(asApprove[0].outcomes[0]).toMatchObject({ id: "draft-1", ok: false, kind: "rejected" });
  });

  it("clears a request error the store has now answered", async () => {
    // "Nothing was sent" in red directly above "1 sent." in green.
    const { settleCard } = await import("@/lib/chat-email-batch");
    const before = [card({ drafts: [draft(1)], requestError: "The approval could not be delivered." })];
    expect(settleCard(before, "batch-1", [{ id: "draft-1", ok: true }], "approve")[0].requestError).toBe("");
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
