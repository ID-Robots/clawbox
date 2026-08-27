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

  it("sends nothing when the owner cancels", async () => {
    const { onApprove, onCancel } = await mount(card());
    fireEvent.click(await screen.findByTestId("chat-email-batch-cancel"));
    expect(onCancel).toHaveBeenCalledWith("batch-1");
    expect(onApprove).not.toHaveBeenCalled();
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
    await mount(card({ status: "settled", outcomes: [{ id: "draft-1", ok: true }] }));
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
