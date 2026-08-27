// The card, wired into a real chat turn.
//
// The card's own suite proves it renders and reports honestly when it is handed
// a batch. This one proves the half that only exists inside ChatPopup: that a
// turn which called `email_send` goes and LOOKS at the approval queue when it
// finishes, that everything waiting becomes ONE card, and that the single click
// posts one `approve_batch` naming exactly the drafts that were on screen.
//
// Without this, the card could be perfect and never appear.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

/** Resolves the streamed body's next chunk, so a test can pace the turn. */
let releaseChunk: ((chunk: string | null) => void) | null = null;
/** Bodies POSTed to the approval route, in order. */
let approvalPosts: Record<string, unknown>[] = [];
/** What the queue answers a GET with. */
let queued: Record<string, unknown>[] = [];
/** What the approval route answers. Replaced by the partial-failure case. */
let approvalReply: (drafts: { id: string }[]) => { ok: boolean; status: number; payload: unknown };

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

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

/** An SSE Response whose chunks are handed out one `releaseChunk` at a time. */
function pacedStream(): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              releaseChunk = (chunk) =>
                chunk === null ? resolve({ done: true }) : resolve({ done: false, value: encoder.encode(chunk) });
            }),
        };
      },
    },
  } as unknown as Response;
}

function installBoxWithMailQueue(): HermesBox {
  const box = installHermesBox();
  box.facts.hermesStreamsTurns = true;
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/email/pending")) {
        if ((init?.method ?? "GET").toUpperCase() === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          approvalPosts.push(body);
          const answer = approvalReply((body.drafts ?? []) as { id: string }[]);
          return { ok: answer.ok, status: answer.status, json: async () => answer.payload };
        }
        return { ok: true, status: 200, json: async () => ({ pending: queued }) };
      }
      if (url.includes("/setup-api/hermes/chat")) return pacedStream();
      return inner(input as RequestInfo, init);
    }),
  );
  return box;
}

async function send(textarea: HTMLElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(releaseChunk).not.toBeNull());
}

async function push(chunk: string | null) {
  await waitFor(() => expect(releaseChunk).not.toBeNull());
  const release = releaseChunk!;
  releaseChunk = null;
  release(chunk);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A finished turn that called `email_send`.
 *
 * The tool name is NAMESPACED on purpose: that is how a host hands ClawBox's
 * own MCP tool over, and a matcher that only knew the bare name would never
 * fire on a real box.
 */
async function turnThatSentMail(toolName = "clawbox_email_send"): Promise<HTMLElement> {
  const box = installBoxWithMailQueue();
  const textarea = await mountHermesChat(box);
  await send(textarea, "Email the team about Friday");
  await push(frame("tool", { kind: "tool", phase: "start", id: "t1", name: toolName }));
  await push(frame("tool", { kind: "tool", phase: "result", id: "t1", name: toolName, status: "ok" }));
  await push(frame("done", { text: "I have drafted those." }));
  await push(null);
  // Handed back so a second turn does not have to go looking for the composer:
  // `getByPlaceholderText(/./)` matched anything with a placeholder at all, and
  // would start throwing the day this surface grew a second one.
  return textarea;
}

beforeEach(() => {
  releaseChunk = null;
  approvalPosts = [];
  queued = [pendingDraft(1), pendingDraft(2), pendingDraft(3)];
  approvalReply = (drafts) => ({
    ok: true,
    status: 200,
    payload: {
      success: true,
      sent: drafts.length,
      failed: 0,
      results: drafts.map((d) => ({ id: d.id, ok: true, recipients: 1 })),
    },
  });
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("a turn that queued mail", () => {
  it("puts everything waiting into ONE card, with a row each", async () => {
    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());
    // One card, three drafts — not three cards, and not one line saying "3".
    expect(screen.getAllByTestId("chat-email-batch")).toHaveLength(1);
    const bodies = screen.getAllByTestId("chat-email-batch-body");
    expect(bodies).toHaveLength(3);
    expect(bodies.map((b) => b.textContent)).toEqual([
      "The body of message 1.",
      "The body of message 2.",
      "The body of message 3.",
    ]);
  });

  it("does not go looking when the turn never asked to send mail", async () => {
    const box = installBoxWithMailQueue();
    const textarea = await mountHermesChat(box);
    await send(textarea, "What is the disk usage?");
    await push(frame("tool", { kind: "tool", phase: "result", id: "t1", name: "disk_usage", status: "ok" }));
    await push(frame("done", { text: "42% used." }));
    await push(null);

    await waitFor(() => expect(screen.queryByTestId("chat-email-batch")).toBeNull());
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/setup-api/email/pending"))).toBe(false);
  });

  it("approves the whole batch on one click, naming every draft", async () => {
    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());

    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(approvalPosts).toHaveLength(1));
    expect(approvalPosts[0]).toEqual({
      action: "approve_batch",
      drafts: [
        { id: "draft-1", fingerprint: "fingerprint-1" },
        { id: "draft-2", fingerprint: "fingerprint-2" },
        { id: "draft-3", fingerprint: "fingerprint-3" },
      ],
    });
  });

  it("FREEZE: a draft queued while the owner reads is not in what he approves", async () => {
    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());

    // The agent is still running. It queues a fourth message during the pause
    // the card introduces — the #492 shape, where device state moved underneath
    // a human-length dialog.
    queued = [...queued, pendingDraft(4, { subject: "Wire the money" })];

    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));
    await waitFor(() => expect(approvalPosts).toHaveLength(1));

    const ids = (approvalPosts[0].drafts as { id: string }[]).map((d) => d.id);
    expect(ids).toEqual(["draft-1", "draft-2", "draft-3"]);
    expect(ids).not.toContain("draft-4");
  });

  it("posts only the drafts still ticked, and still posts once", async () => {
    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());

    fireEvent.click(screen.getAllByTestId("chat-email-batch-include")[1]);
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(approvalPosts).toHaveLength(1));
    expect((approvalPosts[0].drafts as { id: string }[]).map((d) => d.id)).toEqual(["draft-1", "draft-3"]);
  });

  it("posts nothing at all when the owner cancels, and takes the card away", async () => {
    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());

    fireEvent.click(screen.getByTestId("chat-email-batch-cancel"));

    await waitFor(() => expect(screen.queryByTestId("chat-email-batch")).toBeNull());
    expect(approvalPosts).toHaveLength(0);
  });

  it("reports a partial failure per draft rather than as a send", async () => {
    approvalReply = (drafts) => ({
      ok: true,
      status: 207,
      payload: {
        success: false,
        sent: drafts.length - 1,
        failed: 1,
        results: drafts.map((d, index) =>
          index === 1
            ? { id: d.id, ok: false, reason: "send_failed", error: "The mail server refused the message." }
            : { id: d.id, ok: true, recipients: 1 },
        ),
      },
    });

    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    // This surface is mounted without an I18nProvider, so `t` falls back to the
    // KEY — which is exactly the assertion worth making here: the verdict must
    // be the PARTIAL one, never the all-sent one. The wording of each is
    // covered in the card's own suite.
    const result = await screen.findByTestId("chat-email-batch-result");
    expect(result.textContent).toBe("chat.emailBatch.resultPartial");
    expect(result.textContent).not.toBe("chat.emailBatch.resultAllSent");

    const outcomes = screen.getAllByTestId("chat-email-batch-outcome");
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.textContent)).toEqual([
      "chat.emailBatch.draftSent",
      "chat.emailBatch.draftFailed",
      "chat.emailBatch.draftSent",
    ]);
  });

  it("puts the control back, and says so, when the approval could not be delivered", async () => {
    approvalReply = () => ({ ok: false, status: 403, payload: { error: "Approving email needs a signed-in browser session." } });

    await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(screen.getByTestId("chat-email-batch-error")).toBeTruthy());
    // Never a result line: nothing is known to have been sent, and a green tick
    // here would be the false success this card exists to avoid.
    expect(screen.queryByTestId("chat-email-batch-result")).toBeNull();
    expect(screen.getByTestId("chat-email-batch-approve")).toBeEnabled();
  });

  it("does not draw a second card for drafts already on screen", async () => {
    const textarea = await turnThatSentMail();
    await waitFor(() => expect(screen.getByTestId("chat-email-batch")).toBeTruthy());

    // A second turn sends more mail; the queue still holds the first three plus
    // one new one. Only the new one is a fresh decision.
    queued = [...queued, pendingDraft(9, { subject: "A later message" })];
    await send(textarea, "And one more");
    await push(frame("tool", { kind: "tool", phase: "result", id: "t2", name: "clawbox_email_send", status: "ok" }));
    await push(frame("done", { text: "Done." }));
    await push(null);

    await waitFor(() => expect(screen.getAllByTestId("chat-email-batch")).toHaveLength(2));
    const cards = screen.getAllByTestId("chat-email-batch");
    expect(cards[0].querySelectorAll('[data-testid="chat-email-batch-draft"]')).toHaveLength(3);
    expect(cards[1].querySelectorAll('[data-testid="chat-email-batch-draft"]')).toHaveLength(1);
  });
});
