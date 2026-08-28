// Settings → Email must stop listing a draft that has already been sent.
//
// THE BUG THIS PINS. The approvals strip was fetched on mount and after this
// panel's own Approve/Reject buttons, and nowhere else. Any approval made
// somewhere ELSE — the chat batch card, a second browser tab, and now a tap in
// Telegram — left the strip showing a draft that no longer exists. The owner
// reads that as "this has not gone out", and acts on it.
//
// So the panel has to re-read the server when it could have missed something:
// when the tab comes back to the foreground, and on a slow tick while it is
// being looked at.

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

/** What the server currently says is waiting. Flipped mid-test. */
let queued: unknown[];

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  queued = [DRAFT];
  const pendingSection = window as Window & { __clawboxPendingSettingsSection?: string };
  pendingSection.__clawboxPendingSettingsSection = "email";

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/email/pending")) return jsonResponse({ pending: queued });
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

describe("the approvals strip", () => {
  it("shows what the server says is waiting", async () => {
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());
    expect(screen.getByText("Waiting for you")).toBeTruthy();
  });

  it("clears a draft that was approved somewhere else, once the tab comes back", async () => {
    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    // Approved from Telegram while this tab sat in the background.
    queued = [];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(screen.queryByTestId("settings-email-approvals")).toBeNull());
  });

  it("clears it on its own while the panel is being looked at", async () => {
    // The owner is not going to click anything: they approved in Telegram and
    // are watching this page. Nothing but a tick can clear it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<SettingsApp ui={ui} />);
      await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

      queued = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      await waitFor(() => expect(screen.queryByTestId("settings-email-approvals")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});
