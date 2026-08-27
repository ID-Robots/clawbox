// The bridge between the agent's summary and the real mail.
//
// The agent ends its reply with `EMAIL:<id>` lines. The transcript must show a
// card in place of each one — never the raw directive — and opening a card must
// fetch the message only at that moment. Nothing about the mail may reach the
// stored transcript.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

const SUMMARY = "Jane sent you the Wednesday plan, and Accounts sent an invoice.";

/** A stored turn shaped exactly as the harness stores one. */
const REPLAYED = {
  role: "assistant",
  text: `${SUMMARY}\nEMAIL:4471\nEMAIL:4468`,
  timestamp: 1,
  toolCalls: [{ name: "email_list", detail: "count: 2", status: "ok" }],
};

/** The `?view=full` payload, as the device would build it. */
const FULL = {
  uid: 4471,
  from: { name: "Jane Doe", address: "jane@example.com" },
  to: [{ name: "Owner", address: "owner@example.com" }],
  cc: [],
  subject: "Wednesday plan",
  date: "Tue, 6 May 2025 08:15:00 +0000",
  unread: false,
  format: "text" as const,
  body: [{ type: "element" as const, tag: "p" as const, children: [{ type: "text" as const, text: "Morning." }] }],
  attachments: [],
  blockedImages: 0,
  truncated: false,
};

let emailRequests: string[] = [];

function installFetch(history: unknown[]) {
  emailRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/email/messages")) {
        emailRequests.push(url);
        return { ok: true, status: 200, json: async () => ({ message: FULL }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: history }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("a reply that points at messages", () => {
  it("shows the summary without the directive lines", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await screen.findByText(SUMMARY)).toBeTruthy();
    // The bug this exists to prevent: a bare `EMAIL:4471` sitting in the bubble.
    expect(document.body.textContent).not.toContain("EMAIL:4471");
    expect(document.body.textContent).not.toContain("EMAIL:4468");
  });

  it("puts one openable card under the reply for each message named", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    const cards = await screen.findAllByTestId("chat-email-card");
    expect(cards).toHaveLength(2);
    // A real button, so Enter and Space work and it is in the tab order.
    expect(cards[0].tagName).toBe("BUTTON");
    expect(cards[0].getAttribute("aria-label")).toBeTruthy();
  });

  it("fetches nothing from the mailbox until a card is opened", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("chat-email-card");

    // Merely showing the transcript must not open the owner's mailbox.
    expect(emailRequests).toEqual([]);
  });

  it("opens the full message when a card is pressed, asking for that id", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    fireEvent.click((await screen.findAllByTestId("chat-email-card"))[0]);

    expect(await screen.findByTestId("email-full-view")).toBeTruthy();
    expect(await screen.findByText("Wednesday plan")).toBeTruthy();
    expect(emailRequests).toHaveLength(1);
    expect(emailRequests[0]).toContain("uid=4471");
    expect(emailRequests[0]).toContain("view=full");
    // Blocked by default: the first request never asks for images.
    expect(emailRequests[0]).not.toContain("images=1");
  });

  it("closes again and leaves the transcript as it was", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    fireEvent.click((await screen.findAllByTestId("chat-email-card"))[0]);
    await screen.findByTestId("email-full-view");

    fireEvent.click(screen.getByTestId("email-full-close"));
    await waitFor(() => expect(screen.queryByTestId("email-full-view")).toBeNull());
    expect(screen.getByText(SUMMARY)).toBeTruthy();
  });

  it("keeps no message content in the stored transcript", async () => {
    installFetch([REPLAYED]);
    render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click((await screen.findAllByTestId("chat-email-card"))[0]);
    await screen.findByText("Wednesday plan");

    // The panel holds the mail; the cache holds the agent's prose and an id.
    // Anything else would put the owner's mailbox into browser storage for as
    // long as the history lives.
    const cached = JSON.stringify(window.localStorage);
    expect(cached).not.toContain("jane@example.com");
    expect(cached).not.toContain("Morning.");
  });

  it("adds no card to a reply that never named a message", async () => {
    installFetch([{ role: "assistant", text: "You have no new mail.", timestamp: 1 }]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await screen.findByText("You have no new mail.")).toBeTruthy();
    expect(screen.queryByTestId("chat-email-card")).toBeNull();
  });

  it("does not turn a user's own message into a card", async () => {
    // Only the assistant's replies carry directives; a customer typing the same
    // thing is typing text.
    installFetch([{ role: "user", text: "EMAIL:4471", timestamp: 1 }]);
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await screen.findByText("EMAIL:4471")).toBeTruthy();
    expect(screen.queryByTestId("chat-email-card")).toBeNull();
  });
});
