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

beforeEach(() => {
  queued = [DRAFT];
  receipts = [];
  const pendingSection = window as Window & { __clawboxPendingSettingsSection?: string };
  pendingSection.__clawboxPendingSettingsSection = "email";

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/email/pending")) return jsonResponse({ pending: queued, outcomes: receipts });
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
