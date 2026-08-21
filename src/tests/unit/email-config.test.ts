import { describe, expect, it } from "vitest";
import { maskAddress, parseEmailConfigure } from "@/lib/email-config";

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
    expect(maskAddress("krasimir@example.com")).toBe("k••••••r@example.com");
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
