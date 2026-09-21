import { describe, expect, it } from "vitest";
import { deriveImapHost, maskAddress, parseEmailConfigure, resolveImapHost } from "@/lib/email-config";

const VALID = {
  address: "box@example.com",
  password: "abcd efgh ijkl mnop",
};

describe("parseEmailConfigure", () => {
  it("fills in Gmail's submission endpoint when no server is given", () => {
    const result = parseEmailConfigure(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.smtpHost).toBe("smtp.gmail.com");
    expect(result.settings.smtpPort).toBe(587);
    expect(result.settings.smtpSecure).toBe(false);
  });

  it("accepts any other SMTP server and port", () => {
    const result = parseEmailConfigure({ ...VALID, smtpHost: "mail.company.example", smtpPort: 2525 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.smtpHost).toBe("mail.company.example");
    expect(result.settings.smtpPort).toBe(2525);
  });

  it("treats port 465 as implicit TLS without being told", () => {
    const result = parseEmailConfigure({ ...VALID, smtpPort: 465 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.smtpSecure).toBe(true);
  });

  it("accepts a port sent as a string by the form", () => {
    const result = parseEmailConfigure({ ...VALID, smtpPort: "2525" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.smtpPort).toBe(2525);
  });

  it.each([
    [{}, /address is required/i],
    [{ address: "not-an-address", password: "x" }, /email address/i],
    [{ address: VALID.address }, /password is required/i],
    [{ ...VALID, smtpHost: "not a host" }, /server address/i],
    [{ ...VALID, smtpPort: 99_999 }, /between 1 and 65535/i],
    [{ ...VALID, password: "line\nbreak" }, /line breaks/i],
  ])("rejects %j", (body, expected) => {
    const result = parseEmailConfigure(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(expected);
  });

  it("rejects a host that would be read as a command-line flag", () => {
    const result = parseEmailConfigure({ ...VALID, smtpHost: "-oProxyCommand=x" });
    expect(result.ok).toBe(false);
  });

  it("refuses to enable receiving without an allowlist", () => {
    // Hermes' email adapter has no pairing flow, so an empty allowlist would be
    // the only thing between a stranger and the device's agent.
    const result = parseEmailConfigure({ ...VALID, imapHost: "imap.gmail.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/at least one address/i);
  });

  it("enables receiving when an allowlist is given", () => {
    const result = parseEmailConfigure({
      ...VALID,
      imapHost: "imap.gmail.com",
      allowedSenders: "owner@example.com, colleague@example.com",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.imapHost).toBe("imap.gmail.com");
    expect(result.settings.allowedSenders).toEqual(["owner@example.com", "colleague@example.com"]);
  });

  it("drops an allowlist when receiving was not asked for", () => {
    const result = parseEmailConfigure({ ...VALID, allowedSenders: "owner@example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.allowedSenders).toBeUndefined();
  });

  it("rejects an invalid address in the allowlist", () => {
    const result = parseEmailConfigure({
      ...VALID,
      imapHost: "imap.gmail.com",
      allowedSenders: "owner@example.com, nonsense",
    });
    expect(result.ok).toBe(false);
  });
});

describe("maskAddress", () => {
  it("keeps the domain readable and hides the local part", () => {
    expect(maskAddress("postmaster@example.com")).toBe("p••••••r@example.com");
  });

  it("handles a two-character local part", () => {
    expect(maskAddress("ab@example.com")).toBe("a•@example.com");
  });

  it("never returns the original address", () => {
    for (const address of ["a@b.com", "owner@example.com", "very.long.name@sub.example.co.uk"]) {
      expect(maskAddress(address)).not.toBe(address);
    }
  });

  it("does not crash on something that is not an address", () => {
    expect(maskAddress("nonsense")).not.toContain("nonsense");
  });
});

// ── The three modes, and what happens to accounts that predate them ──────────

describe("email modes", () => {
  it("defaults to send-only", () => {
    const result = parseEmailConfigure(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.mode).toBe("send");
  });

  it("keeps no incoming server in send-only mode", () => {
    // Storing where a mailbox lives, for a device that may not open one, would
    // only be misleading.
    const result = parseEmailConfigure({ ...VALID, mode: "send", imapHost: "imap.example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.imapHost).toBeUndefined();
  });

  it("accepts read mode with no allowlist at all", () => {
    // The middle mode answers nobody, so there is nobody to allow.
    const result = parseEmailConfigure({ ...VALID, mode: "read" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.mode).toBe("read");
    expect(result.settings.allowedSenders).toBeUndefined();
  });

  it("still refuses answer mode without an allowlist", () => {
    // Hermes' adapter has no pairing flow; the allowlist is the only gate.
    const result = parseEmailConfigure({ ...VALID, mode: "answer" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/at least one address/i);
  });

  it("drops an allowlist that no mode is using", () => {
    const result = parseEmailConfigure({ ...VALID, mode: "read", allowedSenders: "a@b.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.allowedSenders).toBeUndefined();
  });

  it("rejects a mode it does not know", () => {
    const result = parseEmailConfigure({ ...VALID, mode: "everything" });
    expect(result.ok).toBe(false);
  });

  it("reads a body with no mode the way the old form meant it", () => {
    // MIGRATION, request side. The pre-three-mode form said "inbound" with an
    // IMAP host plus an allowlist, and nothing else. Both shapes must keep
    // meaning exactly what they used to.
    const inbound = parseEmailConfigure({ ...VALID, imapHost: "imap.example.com", allowedSenders: "a@b.com" });
    expect(inbound.ok).toBe(true);
    if (!inbound.ok) return;
    expect(inbound.settings.mode).toBe("answer");

    const outbound = parseEmailConfigure(VALID);
    expect(outbound.ok).toBe(true);
    if (!outbound.ok) return;
    expect(outbound.settings.mode).toBe("send");
  });
});

describe("the send-approval gate", () => {
  it("is ON when the request does not mention it", () => {
    // The safe direction for a missing field is "ask", never "send silently".
    const result = parseEmailConfigure(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.askBeforeSend).toBe(true);
  });

  it("can be turned off explicitly", () => {
    const result = parseEmailConfigure({ ...VALID, askBeforeSend: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.askBeforeSend).toBe(false);
  });

  it("treats anything that is not exactly true as off", () => {
    const result = parseEmailConfigure({ ...VALID, askBeforeSend: "yes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settings.askBeforeSend).toBe(false);
  });
});

describe("deriveImapHost", () => {
  it("turns an SMTP host into its IMAP sibling", () => {
    expect(deriveImapHost("smtp.gmail.com")).toBe("imap.gmail.com");
    expect(deriveImapHost("smtp.fastmail.com")).toBe("imap.fastmail.com");
    expect(deriveImapHost("SMTP.Example.COM")).toBe("imap.Example.COM");
    expect(deriveImapHost("smtps.example.com")).toBe("imap.example.com");
  });

  it("leaves anything else alone rather than guessing", () => {
    // mail.example.com usually serves both. smtp-mail.outlook.com's IMAP host
    // is outlook.office365.com and is not derivable from the string at all —
    // which is what the explicit field in the panel is for.
    expect(deriveImapHost("mail.example.com")).toBe("mail.example.com");
    expect(deriveImapHost("smtp-mail.outlook.com")).toBe("smtp-mail.outlook.com");
    expect(deriveImapHost("")).toBe("");
  });

  it("prefers an explicit host over the derived one", () => {
    expect(resolveImapHost({ smtpHost: "smtp.gmail.com", imapHost: "outlook.office365.com" }))
      .toBe("outlook.office365.com");
    expect(resolveImapHost({ smtpHost: "smtp.gmail.com", imapHost: "   " })).toBe("imap.gmail.com");
    expect(resolveImapHost({ smtpHost: "smtp.gmail.com" })).toBe("imap.gmail.com");
  });
});
