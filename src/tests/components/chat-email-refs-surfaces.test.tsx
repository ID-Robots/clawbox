// `EMAIL:4471` is a card on one chat surface and a line of gibberish on every
// other one.
//
// The directive is ClawBox's own convention: `email_list` / `email_read` ask the
// agent to end its reply with one `EMAIL:<uid>` line per message, and the mascot
// chat lifts them out and shows an "open full message" card in their place
// (chat-email-refs.ts). Nothing else knows what the line means, so wherever that
// lifting does not happen the owner is shown a bare internal id — and the
// standalone full-screen chat at /app/clawbox never learned to do it.
//
// The test belongs on the surfaces and not on the helper, for the reason the
// inter-session envelope suite gives: the two chats have separate history and
// streaming paths and can drift. They had. (The mascot popup's own strip and
// cards are pinned in chat-email-card.test.tsx.)
//
// The directive also leaks out of ClawBox entirely, into a Telegram, Discord or
// WhatsApp reply, and no client-side strip can reach that — the channel is
// inside the harness and the reply never passes through this code. That half is
// asked for where the instruction is written (mcp/tools/email.ts) and
// guaranteed only by the harness's own outbound hook, which is TASK-697. This
// suite is the half ClawBox owns, and it is also what rescues the transcripts
// already on customers' boxes, which carry the lines whatever the tool says
// next.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

const SUMMARY = "Jane sent the Wednesday plan, and Accounts sent an invoice.";
const REPLY = `${SUMMARY}\nEMAIL:4471\nEMAIL:4468`;

/**
 * What `chat.history` answers with, and how each surface's interrupted-turn
 * cases keep themselves honest. The MASCOT ones empty it, so the only card that
 * can appear is the one the abort produced. The full-screen ones leave the
 * replayed turn in place and discriminate on the COUNT instead — four cards, of
 * which the replay accounts for two; two summaries, one of them the replay's.
 */
let history: unknown[] = [];

const REPLAYED_TURN = [
  { role: "user", content: "read my last two emails", timestamp: 1_787_236_200_000 },
  { role: "assistant", content: [{ type: "text", text: REPLY }], timestamp: 1_787_236_209_000 },
];

function historyPayload() {
  return { messages: history };
}

type Frame = Record<string, unknown>;

/**
 * The gateway socket both surfaces speak to, scripted to answer the handshake
 * and one `chat.history`, and to push a live turn on demand.
 *
 * Copied in shape from chat-inter-session-envelope.test.tsx, for the same
 * reason it exists there: asserting on the helper proves nothing about whether
 * a surface calls it, and "whether this surface calls it" is the whole defect.
 */
class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    instances.push(this);
    setTimeout(
      () => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
      0,
    );
  }

  send(raw: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, historyPayload());
      return;
    }
    this.respond(id, {});
  }

  close() {
    this.readyState = FakeGatewayWs.CLOSED;
  }

  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  pushChat(state: string, message: unknown) {
    this.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:main", state, message },
    });
  }
}

const instances: FakeGatewayWs[] = [];

async function socket() {
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return instances[instances.length - 1];
}

/** What the device answers a card that is actually opened with. */
const FULL_MESSAGE = {
  uid: 4471,
  from: { name: "Jane Doe", address: "jane@example.com" },
  to: [],
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

/** How many times the mailbox has been asked for a message. */
function mailboxReads(): number {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.filter((call) => String(call[0]).includes("/setup-api/email/messages")).length;
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      // Everything else, including the mailbox — which nothing here should be
      // asking for. `mailboxReads()` is what proves it rather than this stub.
      return { ok: true, json: async () => ({ message: FULL_MESSAGE }) };
    }),
  );
}

/** How many times `needle` appears in `haystack`, treating null as empty. */
function occurrences(haystack: string | null, needle: string): number {
  return (haystack ?? "").split(needle).length - 1;
}

/**
 * The summary is on screen, the ids are not, and each one became a card.
 *
 * Both halves matter. Deleting the line alone would take the message away from
 * the owner as well as the noise — the card is the thing the directive is FOR,
 * and the reason the answer is not simply to stop asking for it.
 */
function expectDirectiveRendered(cards: number) {
  const rendered = document.body.textContent ?? "";
  expect(rendered).toContain(SUMMARY);
  expect(rendered).not.toContain("EMAIL:4471");
  expect(rendered).not.toContain("EMAIL:4468");
  // Not merely the colon form: no bare uid is left stranded in the prose
  // either, which is what a naive `replace("EMAIL:", "")` would leave behind.
  expect(rendered).not.toMatch(/\b4471\b/);
  // One openable card per message named, in the directive's place.
  expect(screen.getAllByTestId("chat-email-card")).toHaveLength(cards);
}

beforeEach(() => {
  history = REPLAYED_TURN;
  instances.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom has no layout engine; the transcript's auto-scroll has nothing to call.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("the full-screen chat and the EMAIL: directive", () => {
  it("shows a card, never the id, for a turn loaded from history", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));

    expectDirectiveRendered(2);
  });

  it("asks the mailbox for nothing until a card is opened", async () => {
    // The reason the card holds a uid and nothing else. A card that fetched its
    // own subject on mount would put the owner's mail into a component that
    // lives in the transcript list — and would pass every other test here.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));
    expect(mailboxReads()).toBe(0);

    fireEvent.click(screen.getAllByTestId("chat-email-card")[0]);

    await waitFor(() => expect(mailboxReads()).toBe(1));
    // And what came back stayed in the panel: the transcript still holds the
    // agent's prose and nothing from the message. Asserted by comparing the
    // whole document against the panel rather than by walking up from the card
    // — a DOM walk that lost its way returned null and the assertion passed on
    // an empty string.
    await screen.findByText("Wednesday plan");
    const panel = screen.getByTestId("email-full-view");
    expect(occurrences(panel.textContent, "jane@example.com")).toBe(1);
    expect(occurrences(document.body.textContent, "jane@example.com")).toBe(1);
  });

  it("keeps the id out of the bubble while the answer is still arriving", async () => {
    // The directive lands in the last chunk before the turn finalises, so
    // without this the bare id sits in the bubble for that moment and then
    // turns into a card — on the surface where the owner is watching the words
    // appear. The mascot chat has stripped its deltas since the card existed;
    // this one never did.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));
    const ws = await socket();

    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
      await Promise.resolve();
    });

    // TWICE: the replayed turn's copy and the streaming bubble's. Absence of
    // the ids alone would be satisfied by a bubble that rendered nothing at
    // all, which is the other way to pass this without the strip.
    const rendered = document.body.textContent ?? "";
    expect(occurrences(rendered, SUMMARY)).toBe(2);
    expect(rendered).not.toContain("EMAIL:4471");
    expect(rendered).not.toContain("EMAIL:4468");
  });

  it("keeps the cards for a turn the owner interrupted", async () => {
    // An aborted turn keeps whatever had streamed so far, so the strip is done
    // at RENDER and not on the way into state: stripping first would have left
    // the interrupted turn holding text with its directives already gone, and
    // the messages it named unopenable for good.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));
    const ws = await socket();

    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
      await Promise.resolve();
    });
    await act(async () => {
      ws.pushChat("aborted", { role: "assistant", content: [{ type: "text", text: "" }] });
      await Promise.resolve();
    });

    // The history turn's two, and the interrupted turn's two.
    expectDirectiveRendered(4);
  });

  it("keeps a half-written directive out of a turn the owner interrupted", async () => {
    // Stop between `EMAIL` and its digits: the buffer is stored as it stands
    // and the render keeps an unusable directive as TEXT, so the bare line sat
    // in the transcript for good — after the bubble had hidden it all turn.
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));
    const ws = await socket();

    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: `${SUMMARY}\nEMAIL:` }] });
      await Promise.resolve();
    });
    await act(async () => {
      ws.pushChat("aborted", { role: "assistant", content: [{ type: "text", text: "" }] });
      await Promise.resolve();
    });

    // The answer it managed to write is kept; the id it never finished is not.
    const rendered = document.body.textContent ?? "";
    expect(occurrences(rendered, SUMMARY)).toBe(2);
    expect(rendered).not.toContain("EMAIL");
  });

  it("shows a card, never the id, for a live turn pushed as final", async () => {
    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));
    const ws = await socket();

    await act(async () => {
      ws.pushChat("final", { role: "assistant", content: [{ type: "text", text: REPLY }] });
      await Promise.resolve();
    });

    // Four: the replayed turn's two cards, and the pushed turn's two. The live
    // path is a different code path from the history one on this surface —
    // that is exactly why it is asserted separately.
    expectDirectiveRendered(4);
  });
});

describe("the mascot chat, which had the same hole one step further in", () => {
  it("keeps the cards for a turn the owner interrupted", async () => {
    // It stripped the directive on the way into `streaming`, and an aborted
    // turn is appended FROM that buffer — so the interrupted reply arrived in
    // the transcript with its directives already gone and the messages it
    // named unopenable. The strip moved to the render here too, so the two
    // surfaces agree about what survives an interrupt.
    history = [];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    const ws = instances[instances.length - 1];

    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
      await Promise.resolve();
    });
    await act(async () => {
      ws.pushChat("aborted", { role: "assistant", content: [{ type: "text", text: "" }] });
      await Promise.resolve();
    });

    // Nothing was replayed, so a card here can only have come from the turn
    // that was interrupted.
    await waitFor(() => expect(screen.getAllByTestId("chat-email-card")).toHaveLength(2), {
      timeout: 5_000,
    });
    const rendered = document.body.textContent ?? "";
    expect(rendered).toContain(SUMMARY);
    expect(rendered).not.toContain("EMAIL:4471");
  });

  it("keeps a half-written directive out of a turn the owner interrupted", async () => {
    // The same Stop, on the surface that already had the strip: it stripped on
    // the way into `streaming`, but `splitEmailRefs` keeps an unusable line, so
    // the half-written one was stored here too.
    history = [];
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    const ws = instances[instances.length - 1];

    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: `${SUMMARY}\nEMAIL:` }] });
      await Promise.resolve();
    });
    await act(async () => {
      ws.pushChat("aborted", { role: "assistant", content: [{ type: "text", text: "" }] });
      await Promise.resolve();
    });

    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));
    expect(document.body.textContent ?? "").not.toContain("EMAIL");
    // Nothing was replayed, so there is no card to confuse this with either.
    expect(screen.queryAllByTestId("chat-email-card")).toHaveLength(0);
  });
});

// ── The other end of a Control UI card ───────────────────────────────────────
//
// The gateway's own Control UI chat is a third `webchat` surface and rendered
// the directive as a bare id (TASK-700). Nothing in the harness can tell the
// three webchat clients apart, so the card is drawn by a script ClawBox injects
// into the page it already serves — and that card can only be a LINK. This is
// where the link lands: the same chat, showing the same message, through the
// same panel a card here opens. One behaviour, not a third.
describe("opening one message by link", () => {
  const path = window.location.pathname;

  afterEach(() => {
    window.history.replaceState({}, "", path);
  });

  it("opens the message the link names, without asking for it twice", async () => {
    window.history.replaceState({}, "", "/app/clawbox?email=4471");

    render(<ChatApp />);

    await screen.findByTestId("email-full-view");
    await screen.findByText("Wednesday plan");
    expect(mailboxReads()).toBe(1);
  });

  it("opens nothing at all when the link names no usable id", async () => {
    window.history.replaceState({}, "", "/app/clawbox?email=0");

    render(<ChatApp />);
    await waitFor(() => expect(document.body.textContent).toContain(SUMMARY));

    expect(screen.queryByTestId("email-full-view")).toBeNull();
    expect(mailboxReads()).toBe(0);
  });
});
