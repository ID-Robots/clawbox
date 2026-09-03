// Settings → Email has to say what became of a draft, not just drop it.
//
// THE BUG THIS PINS. The approvals strip re-reads the queue, so a draft
// approved somewhere else does stop being listed — but it vanishes without a
// word. The owner who approved from Telegram and then opened the dashboard saw
// an empty panel and no way to tell "it went out" from "it was deleted" or
// "the box never had it". The queue is the one place he goes to find out, and
// it was the one place that would not say.
//
// So the same store that holds the queue now holds a short-lived receipt for
// every draft that has left it, the route hands both back together, and this
// panel renders the receipt where the draft used to be.

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));

const ui: UISettings = {
  wallpaperId: "default",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 100,
  mascotHidden: false,
  wallpapers: [{ id: "default", name: "Default" }],
  customWallpapers: [],
  onWallpaperChange: vi.fn(),
  onWpFitChange: vi.fn(),
  onWpBgColorChange: vi.fn(),
  onWpOpacityChange: vi.fn(),
  onMascotToggle: vi.fn(),
  onWallpaperUpload: vi.fn(),
  onCustomWallpaperDelete: vi.fn(),
};

const DRAFT = {
  id: "draft-1",
  to: ["someone@example.com"],
  subject: "Waiting for you",
  preview: "The body.",
  body: "The body.",
  createdAt: 1_700_000_000_000,
  fingerprint: "f".repeat(32),
};

let queued: unknown[];
let receipts: unknown[];

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

/** What the route answers a decide POST with. Null means the ordinary success. */
let decideAnswer: { ok: boolean; status: number; body: unknown } | null = null;

beforeEach(() => {
  queued = [DRAFT];
  receipts = [];
  decideAnswer = null;
  const pendingSection = window as Window & { __clawboxPendingSettingsSection?: string };
  pendingSection.__clawboxPendingSettingsSection = "email";

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/email/pending")) {
        if ((init?.method ?? "GET").toUpperCase() === "POST" && decideAnswer) {
          const answer = decideAnswer;
          return Promise.resolve({
            ok: answer.ok,
            status: answer.status,
            json: () => Promise.resolve(answer.body),
          } as Response);
        }
        return jsonResponse({ pending: queued, outcomes: receipts });
      }
      if (url.startsWith("/setup-api/email/status")) {
        return jsonResponse({
          configured: true,
          address: "b••x@example.com",
          hasPassword: true,
          mode: "send",
          askBeforeSend: true,
          allowedSenders: [],
          pendingCount: queued.length,
          harness: "openclaw",
          inboundSupported: false,
          defaults: { smtpHost: "smtp.gmail.com", smtpPort: 587, imapHost: "imap.gmail.com" },
        });
      }
      if (url.startsWith("/setup-api/email/chat-approval")) {
        return jsonResponse({ enabled: false, botConfigured: false, botUsername: null, ownerChats: 1 });
      }
      return jsonResponse({});
    }),
  );
});

/** The receipt row for one draft, if the panel renders one. */
function receiptFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="settings-email-handled"] [data-outcome-id="${id}"]`);
}

describe("what became of a draft that is no longer waiting", () => {
  it("says it was sent, once it has been approved somewhere else", async () => {
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    queued = [];
    receipts = [{ id: "draft-1", kind: "sent", at: 1_700_000_000_500, to: DRAFT.to, subject: DRAFT.subject }];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(screen.queryByTestId("settings-email-approvals")).toBeNull());
    await waitFor(() => expect(receiptFor("draft-1")).toBeTruthy());
    expect(receiptFor("draft-1")?.getAttribute("data-outcome-kind")).toBe("sent");
    // The subject is what identifies it to the person who wrote it.
    expect(receiptFor("draft-1")?.textContent).toContain("Waiting for you");
  });

  it("tells a deletion apart from a send", async () => {
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    queued = [];
    receipts = [{ id: "draft-1", kind: "rejected", at: 1_700_000_000_500, to: DRAFT.to, subject: DRAFT.subject }];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(receiptFor("draft-1")).toBeTruthy());
    expect(receiptFor("draft-1")?.getAttribute("data-outcome-kind")).toBe("rejected");
  });

  it("says nothing at all when nothing has been handled", async () => {
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());
    expect(screen.queryByTestId("settings-email-handled")).toBeNull();
  });
});

describe("a send the box could not confirm", () => {
  it("never says it was not sent", async () => {
    // Settings is where the owner comes to decide whether to send it again.
    // "Not sent" over a dropped connection is the sentence that makes them.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    queued = [];
    receipts = [{ id: "draft-1", kind: "unconfirmed", at: 1_700_000_000_500, to: DRAFT.to, subject: DRAFT.subject }];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(receiptFor("draft-1")).toBeTruthy());
    expect(receiptFor("draft-1")?.getAttribute("data-outcome-kind")).toBe("unconfirmed");
    expect(receiptFor("draft-1")?.textContent).toContain("settings.emailHandledUnconfirmed");
  });
});

describe("approving a draft somebody already decided", () => {
  it("is reported as news, never as this click failing", async () => {
    // The owner tapped *Approve & send* in Telegram and the message went out.
    // This row was still on screen — the queue is re-read on a schedule — so he
    // clicked Approve here too. The route answers 404 "already sent", which is
    // true and is NOT a failure of anything: painting it red put an error over
    // a send that succeeded, next to the green "Sent ✓" the handled strip below
    // was about to show for the very same message.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    decideAnswer = {
      ok: false,
      status: 404,
      body: { error: "That message was already sent.", kind: "gone", ending: "sent", at: 1_700_000_000_500 },
    };
    await act(async () => {
      screen.getByText("settings.emailApprove").click();
    });

    const message = await screen.findByText("That message was already sent.");
    // `polite`, which is what a success is announced with; an error is
    // `assertive` and red.
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(message.className).not.toContain("text-red-400");
  });

  it("does not congratulate him for a send he was trying to stop", async () => {
    // The crossed case, and the worst outcome available on that click. He sees
    // a draft he does NOT want sent and presses Discard; in the seconds before,
    // the same draft was approved on Telegram and went out. Reading the ending
    // without the gesture paints that green — the box congratulating him for
    // the one thing he was trying to prevent.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    decideAnswer = {
      ok: false,
      status: 404,
      body: { error: "That message was already sent.", kind: "gone", ending: "sent" },
    };
    await act(async () => {
      screen.getByText("settings.emailReject").click();
    });

    expect(await screen.findByText("That message was already sent.")).toHaveAttribute("aria-live", "assertive");
  });

  it("does not paint an approve green when the draft had been deleted", async () => {
    // The mirror. The words are honest — "That draft was deleted." — and the
    // colour is what is read first: nothing was sent and nothing will be.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    decideAnswer = {
      ok: false,
      status: 404,
      body: { error: "That draft was deleted.", kind: "gone", ending: "rejected" },
    };
    await act(async () => {
      screen.getByText("settings.emailApprove").click();
    });

    expect(await screen.findByText("That draft was deleted.")).toHaveAttribute("aria-live", "assertive");
  });

  it("reports a discard that a deletion elsewhere had already made true as news", async () => {
    // And the uncrossed reject: he asked for it not to be waiting, and it is
    // not waiting, for the reason he wanted.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    decideAnswer = {
      ok: false,
      status: 404,
      body: { error: "That draft was deleted.", kind: "gone", ending: "rejected" },
    };
    await act(async () => {
      screen.getByText("settings.emailReject").click();
    });

    expect(await screen.findByText("That draft was deleted.")).toHaveAttribute("aria-live", "polite");
  });

  it("still reports a draft that vanished with no word about it as an error", async () => {
    // The guard on the rule above. No receipt means nobody knows what happened,
    // and that is exactly the case the red banner is for.
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    decideAnswer = {
      ok: false,
      status: 404,
      body: { error: "That draft is no longer waiting.", kind: "gone" },
    };
    await act(async () => {
      screen.getByText("settings.emailApprove").click();
    });

    const message = await screen.findByText("That draft is no longer waiting.");
    expect(message).toHaveAttribute("aria-live", "assertive");
  });
});
