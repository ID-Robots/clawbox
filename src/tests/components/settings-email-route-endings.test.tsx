// Settings → Email, rendering the approval route's own answer.
//
// WHY THIS FILE EXISTS AND `settings-email-handled.test.tsx` DOES NOT COVER IT.
// That file hands the panel a hand-built body for every 404 ending, and a
// hand-built body cannot go out of step with the route. The seam that DID go
// out of step is the 502: the route computes the receipt's ending and sends it
// back (`ending: outcomeKindFor(err)`), and the panel read that ending only to
// decide whether the answer was the decision this click asked for — so an
// `unconfirmed` send, which is neither a success nor a failure, fell through to
// the red "Could not send the message." and to the amber "This message was not
// sent and is no longer in the queue".
//
// One refresh later the handled strip below it said "Could not be confirmed —
// check your Sent folder" about the same draft. Two verdicts on one screen, and
// the definite one is the one an owner acts on — by sending the message a
// second time, which is exactly what the receipt was invented to prevent.
//
// So nothing here is hand-built. The REAL route runs against a real queue on a
// temp root, and whatever it answers is handed to the REAL panel verbatim.

import fs from "fs";
import os from "os";
import path from "path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));
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
let GET: typeof import("@/app/setup-api/email/pending/route").GET;
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

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

/** The panel's fetch, with the approval queue answered by the REAL route. */
function installQueueRoute() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/email/pending")) {
        const method = (init?.method ?? "GET").toUpperCase();
        const request = new Request("http://localhost/setup-api/email/pending", {
          method,
          headers: { "Content-Type": "application/json", cookie },
          ...(method === "POST" ? { body: String(init?.body ?? "{}") } : {}),
        });
        return method === "POST" ? POST(request) : GET(request);
      }
      if (url.startsWith("/setup-api/email/status")) {
        return jsonResponse({
          configured: true,
          address: "b••x@example.com",
          hasPassword: true,
          mode: "send",
          askBeforeSend: true,
          allowedSenders: [],
          pendingCount: store.listPending().length,
          harness: "openclaw",
          inboundSupported: false,
          defaults: { smtpHost: "smtp.example.com", smtpPort: 587, imapHost: "imap.example.com" },
        });
      }
      if (url.startsWith("/setup-api/email/chat-approval")) {
        return jsonResponse({ enabled: false, botConfigured: false, botUsername: null, ownerChats: 1 });
      }
      return jsonResponse({});
    }),
  );
}

function queue(subject: string): string {
  const queued = store.queuePending({ to: ["person@example.com"], subject, body: `The body of ${subject}.` });
  if (!queued.ok) throw new Error("fixture failed to queue");
  return queued.draft.id;
}

/**
 * The status banner the panel just put up, whatever it says.
 *
 * `StatusMessage` is the only thing on this screen that renders an `<output>`,
 * and with the Email section open it is the email one. Anything else appearing
 * there fails loudly rather than being silently read as this banner.
 */
function banner(): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>("output");
  if (found.length !== 1) throw new Error(`expected one status message, found ${found.length}`);
  return found[0];
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-settings-endings-"));
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
  const route = await import("@/app/setup-api/email/pending/route");
  GET = route.GET;
  POST = route.POST;

  const pendingSection = window as Window & { __clawboxPendingSettingsSection?: string };
  pendingSection.__clawboxPendingSettingsSection = "email";
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("approving a draft the box could not confirm", () => {
  it("never paints a send nobody can vouch for as a definite failure", async () => {
    const only = queue("Only message");
    // The connection dropped after the message was handed over. Not an
    // SmtpError, so nothing in this process knows whether it went out — which
    // is exactly the case the owner must not be talked into re-sending.
    mockSend.mockRejectedValue(new Error("socket hang up"));
    installQueueRoute();

    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    await act(async () => {
      screen.getByText("settings.emailApprove").click();
    });

    // The receipt this very request wrote. It is the truth the panel must not
    // contradict.
    await waitFor(() => expect(outcomes.getOutcome(only)).toMatchObject({ kind: "unconfirmed" }));

    const message = await waitFor(() => banner());
    // `polite`, and not the red `assertive` an error is announced with: a
    // definite "Could not send the message." is a claim nothing in this
    // process can support.
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(message.className).not.toContain("text-red-400");
    expect(message.textContent).toContain("settings.emailHandledUnconfirmed");
  });

  it("does not tell the owner the lost draft was not sent", async () => {
    // The draft is handed back because the claim took it out of the queue, and
    // the heading over it is a second verdict on the same message. "This
    // message was not sent and is no longer in the queue" is the sentence that
    // sends it twice.
    queue("Only message");
    mockSend.mockRejectedValue(new Error("socket hang up"));
    installQueueRoute();

    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    await act(async () => {
      screen.getByText("settings.emailApprove").click();
    });

    const lost = await screen.findByTestId("settings-email-lost-draft");
    expect(lost.textContent).not.toContain("settings.emailApproveFailedDraft");
    expect(lost.textContent).toContain("settings.emailApproveUnconfirmedDraft");
    // The message itself is still there to copy from, which is the whole point
    // of handing it back.
    expect(lost.textContent).toContain("Only message");
  });

  it("still says a refusal the mail server spoke was not sent", async () => {
    // The other half of the same judgement. Softening this would be the
    // mirror-image lie, and the red banner is exactly right for it.
    const only = queue("Refused message");
    mockSend.mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused the sign-in."));
    installQueueRoute();

    render(<SettingsApp ui={ui} />);
    await waitFor(() => expect(screen.getByTestId("settings-email-approvals")).toBeTruthy());

    await act(async () => {
      screen.getByText("settings.emailApprove").click();
    });

    await waitFor(() => expect(outcomes.getOutcome(only)).toMatchObject({ kind: "failed" }));
    const message = await waitFor(() => banner());
    expect(message).toHaveAttribute("aria-live", "assertive");
    const lost = await screen.findByTestId("settings-email-lost-draft");
    expect(lost.textContent).toContain("settings.emailApproveFailedDraft");
  });
});
