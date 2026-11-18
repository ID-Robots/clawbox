// The send-approval card for an e-mail draft the assistant prepared.
//
// An `EMAIL_DRAFT:<id>` line in a reply becomes this card — never raw text. The
// card shows the draft the SERVER read from the mailbox (not the reply), and
// its three answers: Send hands the server's one-time approval back on the
// decide route, Keep as draft does the same with "keep", and "Tell me what to
// change" closes the card and sends the words to the assistant as the person's
// next chat message, naming the draft.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { EmailDraftCard, BODY_CLAMP_CHARS, CARD_ROUTE, DECIDE_ROUTE } from "@/lib/chat-email-draft";
import { ChatMessageRow, NO_AUDIO_NOTES } from "@/components/ChatMessageRow";
import { CHAT_MESSAGE_EVENT, type ChatMessageDetail } from "@/lib/ui-events";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(" ")}` : key;

const DRAFT = {
  id: "AAMk-1=",
  to: ["Ivan Ivanov <ivan@example.com>"],
  cc: ["ops@example.com"],
  bcc: [],
  subject: "Offer for Acme",
  body: "Hello Ivan,\nthe offer is attached.",
  bodyTruncated: false,
  attachments: [{ name: "offer.pdf", size: 20480 }],
};

/**
 * `lost`: the request fails with no answer at all, as when the connection
 * drops. `wait`: the answer is held until it settles.
 */
type Answer = { status: number; body: Record<string, unknown>; lost?: true; wait?: Promise<void> };
let cardAnswers: Answer[];
let decideAnswers: Answer[];
let calls: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  calls = [];
  cardAnswers = [{ status: 200, body: { state: "open", token: "tok-1", expiresAt: Date.now() + 60_000, draft: DRAFT } }];
  decideAnswers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      const queue = url === CARD_ROUTE ? cardAnswers : url === DECIDE_ROUTE ? decideAnswers : [];
      const next = queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 404, body: {} };
      if (next.wait) await next.wait;
      if (next.lost) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EmailDraftCard", () => {
  it("shows the draft the server read: recipients, subject, body, attachments", async () => {
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.loading");
    await screen.findByTestId("chat-email-draft-send");
    expect(screen.getByTestId("chat-email-draft-to").textContent).toContain("Ivan Ivanov <ivan@example.com>");
    expect(screen.getByTestId("chat-email-draft-cc").textContent).toContain("ops@example.com");
    expect(screen.queryByTestId("chat-email-draft-bcc")).toBeNull();
    expect(screen.getByTestId("chat-email-draft-subject").textContent).toContain("Offer for Acme");
    expect(screen.getByTestId("chat-email-draft-body").textContent).toBe(DRAFT.body);
    expect(screen.getByTestId("chat-email-draft-attachments").textContent).toContain("offer.pdf (20 KB)");
    expect(calls).toEqual([{ url: CARD_ROUTE, body: { draftId: "AAMk-1=" } }]);
  });

  it("always shows hidden recipients", async () => {
    cardAnswers = [{ status: 200, body: { state: "open", token: "t", expiresAt: 1, draft: { ...DRAFT, bcc: ["hidden@example.net"] } } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    expect((await screen.findByTestId("chat-email-draft-bcc")).textContent).toContain("hidden@example.net");
  });

  it("Send hands the approval back and says it went — and pressing twice is one request", async () => {
    let release!: () => void;
    // The decide answer is HELD, so the second press lands while the first
    // request is still running: that is when a card could send twice.
    decideAnswers = [{ status: 200, body: { state: "sent" }, wait: new Promise<void>((resolve) => { release = resolve; }) }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    const send = await screen.findByTestId("chat-email-draft-send");
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.sending"));
    fireEvent.click(send);
    expect(calls.filter((c) => c.url === DECIDE_ROUTE)).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("sent"));
    expect(calls[1]).toEqual({ url: DECIDE_ROUTE, body: { token: "tok-1", action: "send" } });
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.sent");
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
    expect(calls.filter((c) => c.url === DECIDE_ROUTE)).toHaveLength(1);
  });

  it("says a Send went through that ClawBox could not record", async () => {
    decideAnswers = [{ status: 200, body: { state: "sent", recorded: false, warning: "sent, not recorded" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("sent"));
    // Sent, and the card says the record of it is missing rather than only "Sent."
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.sentNotRecorded");
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
  });

  it("Keep as draft sends nothing and says where the draft is", async () => {
    decideAnswers = [{ status: 200, body: { state: "kept" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-keep"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("kept"));
    expect(calls[1].body).toEqual({ token: "tok-1", action: "keep" });
    // And it can be looked at again later.
    cardAnswers = [{ status: 200, body: { state: "open", token: "tok-2", expiresAt: 1, draft: DRAFT } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await screen.findByTestId("chat-email-draft-send");
    expect(calls[2]).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=", reopen: true } });
  });

  it("Tell me what to change sends the words to the assistant, naming the draft", async () => {
    decideAnswers = [{ status: 200, body: { state: "revised" } }];
    const sent: string[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<ChatMessageDetail>).detail.text);
    window.addEventListener(CHAT_MESSAGE_EVENT, listener);
    try {
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      const input = await screen.findByTestId("chat-email-draft-change");
      // Nothing to say, nothing sent.
      fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
      expect(calls).toHaveLength(1);
      fireEvent.change(input, { target: { value: "  Make it shorter and add a thank-you.  " } });
      fireEvent.submit(input.closest("form")!);
      await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("revised"));
      expect(calls[1].body).toEqual({ token: "tok-1", action: "revise" });
      expect(sent).toEqual([
        "chat.emailDraft.reviseMessage subject=Offer for Acme id=AAMk-1= text=Make it shorter and add a thank-you.",
      ]);
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, listener);
    }
  });

  it("says why the server refused, and offers the current version after a change", async () => {
    decideAnswers = [{ status: 409, body: { kind: "changed" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.changed"));
    cardAnswers = [{ status: 200, body: { state: "open", token: "tok-2", expiresAt: 1, draft: { ...DRAFT, body: "New body" } } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-body").textContent).toBe("New body"));
  });

  it("says a Send for a draft too long to show whole is refused, and offers the current look", async () => {
    // The server's own refusal, for a card whose preview was cut (the card itself offers no Send for it).
    decideAnswers = [{ status: 409, body: { kind: "too_long" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.tooLong"));
    expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("too_long");
    expect(screen.getByTestId("chat-email-draft-reload")).toBeTruthy();
  });

  it("does not pass a change request on for a card that already went out or is someone else's", async () => {
    const sent: string[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<ChatMessageDetail>).detail.text);
    window.addEventListener(CHAT_MESSAGE_EVENT, listener);
    try {
      decideAnswers = [{ status: 409, body: { kind: "reused", state: "sent" } }];
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      const input = await screen.findByTestId("chat-email-draft-change");
      fireEvent.change(input, { target: { value: "shorter" } });
      fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
      await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.alreadySent"));
      expect(sent).toEqual([]);
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, listener);
    }
  });

  it("keeps the change request when the card could not be closed, and sends nothing to the assistant", async () => {
    const sent: string[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<ChatMessageDetail>).detail.text);
    window.addEventListener(CHAT_MESSAGE_EVENT, listener);
    try {
      decideAnswers = [{ status: 503, body: { kind: "unavailable" } }];
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      const input = await screen.findByTestId("chat-email-draft-change");
      fireEvent.change(input, { target: { value: "shorter" } });
      fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
      await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.unavailable"));
      expect(sent).toEqual([]);
      expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).not.toBe("revised");
      // Still on the card, read-only, with nothing to press until it reopens.
      const kept = screen.getByTestId("chat-email-draft-change") as HTMLInputElement;
      expect(kept.value).toBe("shorter");
      expect(kept.readOnly).toBe(true);
      expect(screen.queryByTestId("chat-email-draft-change-submit")).toBeNull();
      fireEvent.change(kept, { target: { value: "longer" } });
      fireEvent.submit(kept.closest("form")!);
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.filter((c) => c.url === DECIDE_ROUTE)).toHaveLength(1);
      // A look that finds the card open gives the words back to edit and send.
      cardAnswers = [{ status: 200, body: { state: "open", token: "tok-2", expiresAt: 1, draft: DRAFT } }];
      fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
      await screen.findByTestId("chat-email-draft-send");
      const reopened = screen.getByTestId("chat-email-draft-change") as HTMLInputElement;
      expect(reopened.value).toBe("shorter");
      expect(reopened.readOnly).toBe(false);
      expect(sent).toEqual([]);
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, listener);
    }
  });

  it("keeps the change request on a card the server refused for good, read-only", async () => {
    decideAnswers = [{ status: 409, body: { kind: "reused", state: "kept" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.change(await screen.findByTestId("chat-email-draft-change"), { target: { value: "add the price list" } });
    fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.reused"));
    const kept = screen.getByTestId("chat-email-draft-change") as HTMLInputElement;
    expect(kept.value).toBe("add the price list");
    expect(kept.readOnly).toBe(true);
  });

  it("a change request whose answer was lost goes to the assistant once a look finds the card closed as revised", async () => {
    const sent: string[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<ChatMessageDetail>).detail.text);
    window.addEventListener(CHAT_MESSAGE_EVENT, listener);
    try {
      decideAnswers = [{ status: 0, body: {}, lost: true }];
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      fireEvent.change(await screen.findByTestId("chat-email-draft-change"), { target: { value: "shorter" } });
      fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
      await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.network"));
      expect(sent).toEqual([]);
      expect((screen.getByTestId("chat-email-draft-change") as HTMLInputElement).value).toBe("shorter");
      cardAnswers = [{ status: 200, body: { state: "revised", decidedAt: 1, draft: DRAFT } }];
      fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
      await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("revised"));
      expect(sent).toEqual(["chat.emailDraft.reviseMessage subject=Offer for Acme id=AAMk-1= text=shorter"]);
      expect(screen.queryByTestId("chat-email-draft-change")).toBeNull();
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, listener);
    }
  });

  it("never says nothing was sent when a Send's answer was lost: unknown, then what ClawBox recorded", async () => {
    let answerLook!: () => void;
    decideAnswers = [{ status: 0, body: {}, lost: true }];
    cardAnswers = [
      { status: 200, body: { state: "open", token: "tok-1", expiresAt: 1, draft: DRAFT } },
      { status: 200, body: { state: "sent", decidedAt: 1 }, wait: new Promise<void>((resolve) => { answerLook = resolve; }) },
    ];
    const statuses: string[] = [];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    const status = await screen.findByTestId("chat-email-draft-status");
    const observer = new MutationObserver(() => statuses.push(status.textContent ?? ""));
    observer.observe(status, { childList: true, characterData: true, subtree: true });
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    // While ClawBox is asked: unknown, never "nothing was sent".
    await waitFor(() => expect(status.textContent).toBe("chat.emailDraft.sendUnknownChecking"));
    expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("send_unknown_checking");
    expect(screen.queryByTestId("chat-email-draft-reload")).toBeNull();
    answerLook();
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("sent"));
    observer.disconnect();
    expect(statuses.some((text) => /nothing|network|unavailable/i.test(text))).toBe(false);
    // The check is a plain look, never a reopen.
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=" } });
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.sent");
  });

  it("reads a Send answered by something other than ClawBox (a proxy's error page) as unknown too", async () => {
    decideAnswers = [{ status: 502, body: {} }];
    cardAnswers = [
      { status: 200, body: { state: "open", token: "tok-1", expiresAt: 1, draft: DRAFT } },
      { status: 200, body: { state: "uncertain", decidedAt: 1 } },
    ];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("uncertain"));
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.sendUncertain");
    expect(screen.getByTestId("chat-email-draft-reload").textContent).toBe("chat.emailDraft.reviewAgain");
  });

  it("stays unknown while ClawBox cannot be asked, and Check again asks it", async () => {
    decideAnswers = [{ status: 0, body: {}, lost: true }];
    cardAnswers = [
      { status: 200, body: { state: "open", token: "tok-1", expiresAt: 1, draft: DRAFT } },
      { status: 0, body: {}, lost: true },
      { status: 200, body: { state: "open", token: "tok-1", expiresAt: 1, draft: DRAFT } },
    ];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("send_unknown"));
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.sendUnknown");
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
    // The draft is still shown while its fate is unknown.
    expect(screen.getByTestId("chat-email-draft-body").textContent).toBe(DRAFT.body);
    const check = screen.getByTestId("chat-email-draft-reload");
    expect(check.textContent).toBe("chat.emailDraft.checkAgain");
    fireEvent.click(check);
    // ClawBox never claimed that Send: the card is offered again, and says why.
    await screen.findByTestId("chat-email-draft-send");
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.sendNotRecorded");
    expect(calls.filter((c) => c.url === CARD_ROUTE).map((c) => c.body)).toEqual([
      { draftId: "AAMk-1=" }, { draftId: "AAMk-1=" }, { draftId: "AAMk-1=" },
    ]);
  });

  it("a lost Send for a draft that is no longer in the mailbox says it was sent or deleted", async () => {
    decideAnswers = [{ status: 0, body: {}, lost: true }];
    cardAnswers = [
      { status: 200, body: { state: "open", token: "tok-1", expiresAt: 1, draft: DRAFT } },
      { status: 404, body: { kind: "gone" } },
    ];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.gone"));
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
  });

  it("a Send the server answered as uncertain settles as uncertain, with Review again", async () => {
    decideAnswers = [{ status: 502, body: { kind: "send_uncertain", uncertainty: 41 } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("uncertain"));
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.sendUncertain");
    cardAnswers = [{ status: 200, body: { state: "open", token: "tok-3", expiresAt: 1, draft: DRAFT } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await screen.findByTestId("chat-email-draft-send");
    // Review again names the warning this card showed.
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=", reopen: true, acknowledged: 41 } });
  });

  it("another card's lost Send, as a refusal, is the warning the Review again names", async () => {
    decideAnswers = [{ status: 409, body: { kind: "reused", state: "uncertain", uncertainty: 52 } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("uncertain"));
    cardAnswers = [{ status: 200, body: { state: "open", token: "tok-4", expiresAt: 1, draft: DRAFT } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await screen.findByTestId("chat-email-draft-send");
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=", reopen: true, acknowledged: 52 } });
  });

  it("Review again from Kept shows a Send lost meanwhile before offering Send, then names it", async () => {
    decideAnswers = [{ status: 200, body: { state: "kept" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-keep"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("kept"));
    // Another tab's Send lost its answer meanwhile: the server answers the
    // Kept card's Review again (which names no warning) with that warning.
    cardAnswers = [{ status: 200, body: { state: "uncertain", decidedAt: 63, uncertainty: 63 } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("uncertain"));
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=", reopen: true } });
    expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.sendUncertain");
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
    // Shown it, the person's Review again names it.
    cardAnswers = [{ status: 200, body: { state: "open", token: "tok-5", expiresAt: 1, draft: DRAFT } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await screen.findByTestId("chat-email-draft-send");
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=", reopen: true, acknowledged: 63 } });
  });

  for (const [state, shown, button] of [
    ["sending", "chat.emailDraft.sending", "chat.emailDraft.reload"],
    ["uncertain", "chat.emailDraft.error.sendUncertain", "chat.emailDraft.reviewAgain"],
    ["sent", "chat.emailDraft.error.alreadySent", null],
  ] as const) {
    it(`shows another card's Send of the same draft as the server reports it: ${state}`, async () => {
      decideAnswers = [{ status: 409, body: { kind: "reused", state } }];
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
      await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe(shown));
      expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
      if (button) expect(screen.getByTestId("chat-email-draft-reload").textContent).toBe(button);
      else expect(screen.queryByTestId("chat-email-draft-reload")).toBeNull();
    });
  }

  it("shows the sender, where replies go, and a warning for hidden characters", async () => {
    cardAnswers = [{ status: 200, body: { state: "open", token: "t", expiresAt: 1, draft: {
      ...DRAFT, from: "Owner <owner@example.com>", replyTo: ["replies@example.net"], subject: "Invoice [U+202E]fdp.exe", hiddenCharacters: true,
    } } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    expect((await screen.findByTestId("chat-email-draft-from")).textContent).toContain("owner@example.com");
    expect(screen.getByTestId("chat-email-draft-reply-to").textContent).toContain("replies@example.net");
    expect(screen.getByTestId("chat-email-draft-hidden-chars").textContent).toBe("chat.emailDraft.hiddenChars");
    expect(screen.getByTestId("chat-email-draft-subject").textContent).toContain("[U+202E]");
  });

  it("offers no Send when the subject or an attachment name could not be shown whole", async () => {
    cardAnswers = [{ status: 200, body: { state: "open", token: "t", expiresAt: 1, draft: { ...DRAFT, headerTruncated: true } } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    const send = await screen.findByTestId("chat-email-draft-send");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("chat-email-draft-too-long")).toBeTruthy();
    fireEvent.click(send);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url === DECIDE_ROUTE)).toEqual([]);
  });

  it("a 200 that does not say the draft was sent is not taken as sent: ClawBox is asked", async () => {
    decideAnswers = [{ status: 200, body: {} }];
    cardAnswers = [
      { status: 200, body: { state: "open", token: "tok-1", expiresAt: 1, draft: DRAFT } },
      { status: 200, body: { state: "sending", decidedAt: 1 } },
    ];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("sending"));
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=" } });
  });

  it("a 200 that does not say the card was revised sends nothing to the assistant", async () => {
    const sent: string[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<ChatMessageDetail>).detail.text);
    window.addEventListener(CHAT_MESSAGE_EVENT, listener);
    try {
      decideAnswers = [{ status: 200, body: {} }];
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      fireEvent.change(await screen.findByTestId("chat-email-draft-change"), { target: { value: "shorter" } });
      fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
      await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("unavailable"));
      expect(sent).toEqual([]);
      expect((screen.getByTestId("chat-email-draft-change") as HTMLInputElement).value).toBe("shorter");
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, listener);
    }
  });

  it("a change request the server closed reaches the assistant even if the card left the screen meanwhile", async () => {
    const sent: string[] = [];
    const listener = (e: Event) => sent.push((e as CustomEvent<ChatMessageDetail>).detail.text);
    window.addEventListener(CHAT_MESSAGE_EVENT, listener);
    try {
      let answer!: () => void;
      decideAnswers = [{ status: 200, body: { state: "revised" }, wait: new Promise<void>((resolve) => { answer = resolve; }) }];
      const { unmount } = render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      fireEvent.change(await screen.findByTestId("chat-email-draft-change"), { target: { value: "shorter" } });
      fireEvent.click(screen.getByTestId("chat-email-draft-change-submit"));
      await waitFor(() => expect(calls.filter((c) => c.url === DECIDE_ROUTE)).toHaveLength(1));
      unmount();
      answer();
      await waitFor(() => expect(sent).toEqual(["chat.emailDraft.reviseMessage subject=Offer for Acme id=AAMk-1= text=shorter"]));
    } finally {
      window.removeEventListener(CHAT_MESSAGE_EVENT, listener);
    }
  });

  it("offers no Send for a body it could not show whole", async () => {
    cardAnswers = [{ status: 200, body: { state: "open", token: "t", expiresAt: 1, draft: { ...DRAFT, bodyTruncated: true } } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    const send = await screen.findByTestId("chat-email-draft-send");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("chat-email-draft-too-long")).toBeTruthy();
    fireEvent.click(send);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url === DECIDE_ROUTE)).toEqual([]);
  });

  it("a Send whose answer was lost is not offered again without the person asking", async () => {
    cardAnswers = [{ status: 200, body: { state: "uncertain", decidedAt: 7, uncertainty: 7 } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.sendUncertain"));
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
    cardAnswers = [{ status: 200, body: { state: "open", token: "tok-9", expiresAt: 1, draft: DRAFT } }];
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await screen.findByTestId("chat-email-draft-send");
    expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=", reopen: true, acknowledged: 7 } });
  });

  it("after a refusal, Show the current version is a plain look, never a reopen", async () => {
    decideAnswers = [{ status: 410, body: { kind: "expired" } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    fireEvent.click(await screen.findByTestId("chat-email-draft-send"));
    await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe("chat.emailDraft.error.expired"));
    fireEvent.click(screen.getByTestId("chat-email-draft-reload"));
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: CARD_ROUTE, body: { draftId: "AAMk-1=" } }));
  });

  for (const [kind, key] of [
    ["disabled", "chat.emailDraft.error.disabled"],
    ["gone", "chat.emailDraft.error.gone"],
    ["backend_unreachable", "chat.emailDraft.error.backend"],
  ] as const) {
    it(`explains a card that cannot be made: ${kind}`, async () => {
      cardAnswers = [{ status: kind === "gone" ? 404 : kind === "disabled" ? 409 : 502, body: { kind } }];
      render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
      await waitFor(() => expect(screen.getByTestId("chat-email-draft-status").textContent).toBe(key));
      expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
    });
  }

  it("shows a settled card as settled when the chat is opened again", async () => {
    cardAnswers = [{ status: 200, body: { state: "sent", decidedAt: 1 } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    await waitFor(() => expect(screen.getByTestId("chat-email-draft").getAttribute("data-state")).toBe("sent"));
    expect(screen.queryByTestId("chat-email-draft-send")).toBeNull();
    expect(screen.queryByTestId("chat-email-draft-reload")).toBeNull();
  });

  it("folds a long body behind Show all", async () => {
    const long = "word ".repeat(BODY_CLAMP_CHARS);
    cardAnswers = [{ status: 200, body: { state: "open", token: "t", expiresAt: 1, draft: { ...DRAFT, body: long } } }];
    render(<EmailDraftCard draftId="AAMk-1=" t={t} />);
    const body = await screen.findByTestId("chat-email-draft-body");
    expect(body.textContent!.length).toBeLessThan(long.length);
    fireEvent.click(screen.getByTestId("chat-email-draft-expand"));
    expect(screen.getByTestId("chat-email-draft-body").textContent).toBe(long);
  });
});

describe("in the chat", () => {
  it("replaces the directive line with the card, under the assistant's words", async () => {
    render(
      <ChatMessageRow
        msg={{ role: "assistant", text: "I drafted the offer to Ivan.\n\nEMAIL_DRAFT:AAMk-1=", timestamp: 1 } as never}
        longKey="k"
        expanded={false}
        onToggleExpand={() => {}}
        served={null}
        t={t}
        onPreview={() => {}}
        onOpenEmail={() => {}}
        cloudSpoken={NO_AUDIO_NOTES}
        autoplayBlocked={NO_AUDIO_NOTES}
      />,
    );
    expect(await screen.findByTestId("chat-email-draft")).toBeTruthy();
    expect(document.body.textContent).toContain("I drafted the offer to Ivan.");
    expect(document.body.textContent).not.toContain("EMAIL_DRAFT");
  });

  it("leaves the user's own words alone", () => {
    render(
      <ChatMessageRow
        msg={{ role: "user", text: "EMAIL_DRAFT:abc", timestamp: 1 } as never}
        longKey="k"
        expanded={false}
        onToggleExpand={() => {}}
        served={null}
        t={t}
        onPreview={() => {}}
        onOpenEmail={() => {}}
        cloudSpoken={NO_AUDIO_NOTES}
        autoplayBlocked={NO_AUDIO_NOTES}
      />,
    );
    expect(screen.queryByTestId("chat-email-draft")).toBeNull();
    expect(calls).toEqual([]);
  });
});
