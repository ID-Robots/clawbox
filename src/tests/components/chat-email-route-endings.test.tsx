// The approval route's own answer, rendered by the real card.
//
// WHY THIS FILE EXISTS AND THE OTHER CARD TESTS DO NOT COVER IT. Every other
// test of an ending builds the row by hand, or reads it from a receipt in the
// GET answer. Both halves of the seam were green and the seam itself was not:
// the batch `catch` wrote an `unconfirmed` RECEIPT and pushed a row that did
// not carry the ending, so the card fell through to "Not sent" in red about a
// message the very same request had just recorded as one nobody can vouch for.
// Settings → Email, reading the receipt, said "could not be confirmed" in amber
// at the same moment. Two surfaces, one draft, opposite verdicts — and the red
// one is the one an owner acts on, by sending the message a second time.
//
// So nothing here is hand-built. The REAL route runs, against a real queue on
// a temp root, and whatever it answers is handed to the REAL chat surface
// verbatim. A row shape the route stops emitting fails this file; a row shape
// the card stops understanding fails it too.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";

vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, sendMail: vi.fn() };
});
// The Telegram side of an approval has its own tests; here it is noise on the
// way to the queue.
vi.mock("@/lib/email-approval", () => ({ retireChatPrompt: vi.fn(async () => undefined) }));

// Handles are taken AFTER vi.resetModules(), never from a static top-level
// import: DATA_DIR is resolved at module load, so a module imported before the
// temp root is set would read another test's queue.
let store: typeof import("@/lib/email-pending");
let outcomes: typeof import("@/lib/email-outcomes");
let smtp: typeof import("@/lib/smtp-client");
let mockSend: ReturnType<typeof vi.mocked<typeof import("@/lib/smtp-client").sendMail>>;
let POST: typeof import("@/app/setup-api/email/pending/route").POST;
let cookie: string;
let root: string;

const SESSION_SECRET = "a".repeat(64);
const CONFIGURED: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.example.com",
  email_smtp_port: 587,
};

/**
 * The chat surface's fetch, with the approval queue answered by the REAL route.
 *
 * GET is the store itself, through a JSON round-trip so the surface sees the
 * wire shape and not live objects. POST is the route handler, called with an
 * owner cookie because that is the only credential it accepts — and its own
 * Response is returned untouched.
 */
function installBoxWithLiveQueue(): HermesBox {
  const box = installHermesBox();
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/email/pending")) {
        if ((init?.method ?? "GET").toUpperCase() === "POST") {
          return POST(
            new Request("http://localhost/setup-api/email/pending", {
              method: "POST",
              headers: { "Content-Type": "application/json", cookie },
              body: String(init?.body ?? "{}"),
            }),
          );
        }
        const snapshot = JSON.parse(
          JSON.stringify({ pending: store.listPending(), outcomes: outcomes.listOutcomes() }),
        );
        return { ok: true, status: 200, json: async () => snapshot };
      }
      return inner(input as RequestInfo, init);
    }),
  );
  return box;
}

/** The card's own colours, as jsdom serialises them. Amber is "look at this". */
const WARN_FG = "rgb(252, 211, 77)";
const ERROR_FG = "rgb(248, 113, 113)";

/** Which ending the card is showing for one draft, or null when it shows none. */
function endingFor(draftId: string): string | null {
  const row = document.querySelector(`[data-draft-id="${draftId}"]`);
  return row?.querySelector('[data-testid="chat-email-batch-outcome"]')?.getAttribute("data-outcome-kind") ?? null;
}

function queue(subject: string): string {
  const queued = store.queuePending({ to: ["person@example.com"], subject, body: `The body of ${subject}.` });
  if (!queued.ok) throw new Error("fixture failed to queue");
  return queued.draft.id;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-route-endings-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.resetModules();
  vi.clearAllMocks();

  const config = await import("@/lib/config-store");
  for (const [key, value] of Object.entries(CONFIGURED)) await config.set(key, value);

  const auth = await import("@/lib/auth");
  cookie = `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`;
  store = await import("@/lib/email-pending");
  outcomes = await import("@/lib/email-outcomes");
  smtp = await import("@/lib/smtp-client");
  mockSend = vi.mocked(smtp.sendMail);
  mockSend.mockResolvedValue({ messageId: "sent@example.com" });
  vi.mocked((await import("@/lib/email-approval")).retireChatPrompt).mockResolvedValue(undefined);
  POST = (await import("@/app/setup-api/email/pending/route")).POST;

  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("a batch send whose answer never came back", () => {
  it("reaches the card as unconfirmed, the same word the receipt got", async () => {
    const first = queue("First message");
    const second = queue("Second message");
    // The connection dropped after the message was handed over. Not an
    // SmtpError, so nothing in this process knows whether it went out — which
    // is exactly the case the owner must not be talked into re-sending.
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const box = installBoxWithLiveQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(screen.getByTestId("chat-email-batch-result")).toBeTruthy());
    // The receipts the very same request wrote. They are the truth the card
    // must not contradict.
    expect(outcomes.getOutcome(first)).toMatchObject({ kind: "unconfirmed" });
    expect(outcomes.getOutcome(second)).toMatchObject({ kind: "unconfirmed" });
    // And the card says the same thing, because the row carried the ending.
    expect(endingFor(first)).toBe("unconfirmed");
    expect(endingFor(second)).toBe("unconfirmed");
  });

  it("never renders a definite failure over a send nobody can vouch for", async () => {
    const only = queue("Only message");
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const box = installBoxWithLiveQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(screen.getByTestId("chat-email-batch-result")).toBeTruthy());
    expect(endingFor(only)).not.toBe("failed");
    // The verdict is amber, never the red that means "nothing went out" — the
    // colour rather than the sentence, because the real chat reaches its
    // translation table through a dynamic import and answers with the key
    // until it lands (the words are pinned in chat-email-batch.test.tsx).
    const verdict = screen.getByTestId("chat-email-batch-result");
    expect(verdict.style.color).toBe(WARN_FG);
    expect(verdict.style.color).not.toBe(ERROR_FG);
  });

  it("still says 'not sent' when the mail server actually refused it", async () => {
    // The other half of the same judgement: a refusal the server SPOKE is a
    // definite failure, and softening that would be the mirror-image lie.
    const only = queue("Refused message");
    mockSend.mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused the sign-in."));

    const box = installBoxWithLiveQueue();
    await mountHermesChat(box);
    await waitFor(() => expect(screen.getByTestId("chat-email-batch-approve")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chat-email-batch-approve"));

    await waitFor(() => expect(screen.getByTestId("chat-email-batch-result")).toBeTruthy());
    expect(outcomes.getOutcome(only)).toMatchObject({ kind: "failed" });
    expect(endingFor(only)).toBe("failed");
  });
});
