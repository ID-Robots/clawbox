// The panel that shows the actual email.
//
// Two things are being protected here. The obvious one is that the message
// renders — headers, structure, attachments. The one that matters more is that
// content a stranger wrote cannot become behaviour: no script, no remote
// request until the owner asks for one, and no way for a message to reach out
// of its container.
//
// Every fixture is invented mail from obviously-fake people. This repository is
// public and no real mailbox contributes to its tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { EmailFullView } from "@/lib/chat-email";
import { buildFullMessage } from "@/lib/email-mime";
import type { FullMessage } from "@/lib/chat-email";

/** The real English strings, so a broken key shows up as a broken test. */
const STRINGS: Record<string, string> = {
  "chat.email.openFull": "Open full message",
  "chat.email.title": "Message",
  "chat.email.close": "Close message",
  "chat.email.from": "From",
  "chat.email.to": "To",
  "chat.email.cc": "Cc",
  "chat.email.date": "Date",
  "chat.email.noSubject": "(no subject)",
  "chat.email.loading": "Opening the message…",
  "chat.email.failed": "That message could not be opened.",
  "chat.email.retry": "Try again",
  "chat.email.imagesBlocked":
    "Images were not loaded, so the sender is not told that you opened this.",
  "chat.email.loadImages": "Load images",
  "chat.email.loadingImages": "Loading…",
  "chat.email.imageFrom": "Image from {host}",
  "chat.email.blockedImage": "Image not loaded",
  "chat.email.attachments": "Attachments",
  "chat.email.truncated": "This message was too long to show in full.",
  "chat.email.bodyRegion": "Message body",
};

const t = (key: string, vars?: Record<string, string | number>): string => {
  let value = STRINGS[key] ?? key;
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
};

const CRLF = "\r\n";
const mail = (...lines: string[]): string => lines.join(CRLF);
const META = { uid: 42, unread: false, internalDate: "Mon, 5 May 2025 10:00:00 +0000", truncated: false };

/** Build the payload the device would return for a raw message. */
function payload(raw: string, resolve?: (url: string) => string | undefined): FullMessage {
  return buildFullMessage(raw, META, resolve) as unknown as FullMessage;
}

/** Serve `?view=full`, recording every request the panel makes. */
function installFetch(responder: (url: string) => FullMessage): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ message: responder(String(input)) }),
  }));
  vi.stubGlobal("fetch", mock);
  return mock as unknown as ReturnType<typeof vi.fn>;
}

const PLAIN = mail(
  "From: Jane Doe <jane@example.com>",
  "To: Owner <owner@example.com>",
  "Subject: Wednesday plan",
  "Date: Tue, 6 May 2025 08:15:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Morning — two things.",
  "The second is not urgent.",
  "",
  "See https://example.com/agenda for the list.",
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a plain-text message", () => {
  beforeEach(() => installFetch(() => payload(PLAIN)));

  it("shows the header block with the display name and the address", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    expect(await screen.findByText("Wednesday plan")).toBeTruthy();
    const panel = screen.getByTestId("email-full-view");
    expect(within(panel).getByText("Jane Doe")).toBeTruthy();
    expect(within(panel).getByText("<jane@example.com>")).toBeTruthy();
    expect(within(panel).getByText("<owner@example.com>")).toBeTruthy();
    expect(within(panel).getByText("Tue, 6 May 2025 08:15:00 +0000")).toBeTruthy();
  });

  it("keeps the paragraphs the sender wrote, rather than one run-on block", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.querySelectorAll("p").length).toBeGreaterThanOrEqual(2);
    expect(body.textContent).toContain("Morning — two things.");
    expect(body.textContent).toContain("The second is not urgent.");
  });

  it("turns a bare URL into a link that cannot reach back through the opener", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    const link = body.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/agenda");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("shows a placeholder subject rather than an empty heading", async () => {
    installFetch(() => payload(mail("From: a@example.com", "Content-Type: text/plain", "", "hi")));
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    expect(await screen.findByText("(no subject)")).toBeTruthy();
  });
});

describe("an HTML message", () => {
  const HTML = mail(
    "From: News <news@example.com>",
    "Subject: Weekly",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<h2>Headline</h2>" +
      "<p>Hello <strong>there</strong></p>" +
      "<ul><li>first</li><li>second</li></ul>" +
      '<script>window.stolen = document.cookie</script>' +
      "<style>body{display:none}</style>" +
      '<iframe src="https://evil.example/x"></iframe>' +
      '<a href="javascript:alert(1)">do not click</a>' +
      '<p onclick="steal()" style="position:fixed;inset:0">styled</p>',
  );

  beforeEach(() => installFetch(() => payload(HTML)));

  it("renders the structure the sender used", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.querySelector("h2")?.textContent).toBe("Headline");
    expect(body.querySelector("strong")?.textContent).toBe("there");
    expect(body.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders no script, style or iframe element at all", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("style")).toBeNull();
    expect(body.querySelector("iframe")).toBeNull();
    expect(body.innerHTML).not.toContain("evil.example");
    expect(body.innerHTML).not.toContain("document.cookie");
  });

  it("drops a javascript: link but keeps the words it wrapped", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.textContent).toContain("do not click");
    for (const anchor of Array.from(body.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toContain("javascript:");
    }
  });

  it("carries no message-authored CSS, so nothing can escape the container", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    const styled = Array.from(body.querySelectorAll("p")).find((p) => p.textContent === "styled");
    expect(styled).toBeTruthy();
    expect(styled?.style.position ?? "").toBe("");
    expect(body.innerHTML).not.toContain("position:fixed");
    expect(body.innerHTML).not.toContain("onclick");
  });
});

describe("remote images", () => {
  const TRACKED = mail(
    "From: Shop <shop@example.com>",
    "Subject: Sale",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Deals</p><img src="https://tracker.example/open.gif?u=who-opened-it" alt="banner">',
  );

  it("loads nothing by default and says so", async () => {
    installFetch(() => payload(TRACKED));
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(screen.getByTestId("email-images-blocked")).toBeTruthy();
    // The decisive assertion: no <img> exists, so the browser issues no request
    // and the sender learns nothing.
    expect(body.querySelector("img")).toBeNull();
    expect(screen.getByTestId("email-blocked-image")).toBeTruthy();
  });

  it("never puts the tracking URL in the document", async () => {
    installFetch(() => payload(TRACKED));
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    await screen.findByTestId("email-full-body");
    expect(document.body.innerHTML).not.toContain("who-opened-it");
    expect(document.body.innerHTML).not.toContain("open.gif");
  });

  it("asks the device for the images only once the owner presses the button", async () => {
    const fetchMock = installFetch((url) =>
      url.includes("images=1")
        ? payload(TRACKED, () => "data:image/png;base64,AAAA")
        : payload(TRACKED),
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    await screen.findByTestId("email-load-images");

    // Nothing so far has asked for images.
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes("images=1"))).toBe(true);

    fireEvent.click(screen.getByTestId("email-load-images"));

    await waitFor(() => {
      expect(screen.getByTestId("email-full-body").querySelector("img")).toBeTruthy();
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("images=1"))).toBe(true);
    // The notice goes once there is nothing left being withheld.
    expect(screen.queryByTestId("email-images-blocked")).toBeNull();
  });

  it("shows a picture the message carried itself, with no consent needed", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    installFetch(() =>
      payload(
        mail(
          "From: a@example.com",
          'Content-Type: multipart/related; boundary="rel"',
          "",
          "--rel",
          "Content-Type: text/html",
          "",
          '<img src="cid:logo@example" alt="Logo">',
          "--rel",
          "Content-Type: image/png",
          "Content-Transfer-Encoding: base64",
          "Content-ID: <logo@example>",
          "",
          png,
          "--rel--",
        ),
      ),
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    const img = body.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")?.startsWith("data:image/png;base64,")).toBe(true);
    // Nothing was withheld, so the owner is not asked about anything.
    expect(screen.queryByTestId("email-images-blocked")).toBeNull();
  });
});

describe("long messages and attachments", () => {
  it("scrolls the body inside its own container rather than growing the panel", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `<p>Paragraph number ${i}</p>`).join("");
    installFetch(() =>
      payload(mail("From: a@example.com", "Content-Type: text/html", "", long)),
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.querySelectorAll("p").length).toBeGreaterThan(300);
    expect(body.style.overflowY).toBe("auto");
    // The panel itself is bounded, so the transcript behind it cannot be pushed
    // out of shape by a long email.
    const panel = screen.getByTestId("email-full-view");
    expect(panel.style.maxHeight).toBe("100%");
  });

  it("names the files that arrived", async () => {
    installFetch(() =>
      payload(
        mail(
          "From: Accounts <accounts@example.com>",
          'Content-Type: multipart/mixed; boundary="mix"',
          "",
          "--mix",
          "Content-Type: text/plain",
          "",
          "Invoice attached.",
          "--mix",
          "Content-Type: application/pdf",
          "Content-Transfer-Encoding: base64",
          'Content-Disposition: attachment; filename="invoice-may.pdf"',
          "",
          Buffer.from("x".repeat(2048), "utf8").toString("base64"),
          "--mix--",
        ),
      ),
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const list = await screen.findByTestId("email-attachments");
    expect(within(list).getByText("invoice-may.pdf")).toBeTruthy();
    expect(within(list).getByText("2 KB")).toBeTruthy();
    // Named, not offered: there is no route that serves the bytes, so there is
    // deliberately nothing to click.
    expect(list.querySelector("a")).toBeNull();
    expect(list.querySelector("button")).toBeNull();
  });

  it("says plainly when a message was too long to show whole", async () => {
    installFetch(() =>
      buildFullMessage(
        mail("From: a@example.com", "Content-Type: text/plain", "", "start of it"),
        { ...META, truncated: true },
      ) as unknown as FullMessage,
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    expect(await screen.findByTestId("email-truncated")).toBeTruthy();
  });
});

describe("keyboard and screen readers", () => {
  beforeEach(() => installFetch(() => payload(PLAIN)));

  it("is a labelled modal dialog naming the message it is showing", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const panel = await screen.findByTestId("email-full-view");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const labelId = panel.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe("Wednesday plan");
  });

  it("announces the body as a named region and stops being busy once loaded", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.getAttribute("role")).toBe("region");
    expect(body.getAttribute("aria-label")).toBe("Message body");
    await waitFor(() => expect(body.getAttribute("aria-busy")).toBe("false"));
  });

  it("puts the body in the tab order, so a long message can be scrolled by keyboard", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const body = await screen.findByTestId("email-full-body");
    expect(body.getAttribute("tabindex")).toBe("0");
  });

  it("moves focus into the dialog when it opens", async () => {
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    const panel = await screen.findByTestId("email-full-view");
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<EmailFullView uid={42} onClose={onClose} t={t} />);
    await screen.findByTestId("email-full-view");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("closes from the close button, which has a real name", async () => {
    const onClose = vi.fn();
    render(<EmailFullView uid={42} onClose={onClose} t={t} />);
    const close = await screen.findByTestId("email-full-close");
    expect(close.getAttribute("aria-label")).toBe("Close message");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("when the mailbox will not answer", () => {
  it("says so without repeating whatever the mail server said", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({ error: "IMAP login failed for owner@example.com" }),
      })),
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("That message could not be opened.")).toBeTruthy();
    // A mail-server error can carry the mailbox address; it does not belong on
    // screen and this panel is not where debugging happens.
    expect(document.body.textContent).not.toContain("owner@example.com");
  });

  it("offers a retry that asks again", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ message: payload(PLAIN) }) };
      }),
    );
    render(<EmailFullView uid={42} onClose={() => {}} t={t} />);
    fireEvent.click(await screen.findByText("Try again"));
    expect(await screen.findByText("Wednesday plan")).toBeTruthy();
  });
});
