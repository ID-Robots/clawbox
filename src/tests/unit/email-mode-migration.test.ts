// What happens to an account that was configured BEFORE the three modes and the
// approval gate existed.
//
// This is the test that protects other people's devices from this change. An
// upgrade must not start reading a mailbox nobody said could be read, and it
// must not start holding back mail that used to go straight out. Both would be
// the device quietly doing something different after an update it did not ask
// for.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), setMany: vi.fn() }));

import { get, setMany } from "@/lib/config-store";
import { getEmailCredentials, publicEmailStatus, saveEmailSettings } from "@/lib/email-config";

const mockGet = vi.mocked(get);
const mockSetMany = vi.mocked(setMany);

/** The keys an account saved by the pre-modes build would have. */
const LEGACY_SEND_ONLY: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};

const LEGACY_INBOUND: Record<string, unknown> = {
  ...LEGACY_SEND_ONLY,
  email_imap_host: "imap.gmail.com",
  email_allowed_senders: ["owner@example.com"],
};

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an account saved before modes existed", () => {
  it("is send-only when it had no inbound wiring", async () => {
    storeWith(LEGACY_SEND_ONLY);
    const settings = await getEmailCredentials();
    expect(settings?.mode).toBe("send");
  });

  it("is answer mode when it was actually answering", async () => {
    // An IMAP host plus an allowlist is Hermes' adapter running. Calling that
    // anything else would switch a working feature off on upgrade.
    storeWith(LEGACY_INBOUND);
    const settings = await getEmailCredentials();
    expect(settings?.mode).toBe("answer");
  });

  it("is never silently promoted to read mode", async () => {
    // The whole point: nobody's mailbox starts being readable because they
    // installed an update.
    storeWith(LEGACY_SEND_ONLY);
    const settings = await getEmailCredentials();
    expect(settings?.mode).not.toBe("read");
    expect(settings?.mode).not.toBe("answer");
  });

  it("keeps sending without asking, because it always did", async () => {
    // Default ON is for NEW setups. Turning the gate on under an existing
    // account would silently stop mail its owner relies on.
    storeWith(LEGACY_SEND_ONLY);
    const settings = await getEmailCredentials();
    expect(settings?.askBeforeSend).toBe(false);
  });
});

describe("an explicit choice always wins over the migration", () => {
  it("honours a stored mode", async () => {
    storeWith({ ...LEGACY_INBOUND, email_mode: "read" });
    const settings = await getEmailCredentials();
    expect(settings?.mode).toBe("read");
  });

  it("honours a stored gate in both directions", async () => {
    storeWith({ ...LEGACY_SEND_ONLY, email_ask_before_send: true });
    expect((await getEmailCredentials())?.askBeforeSend).toBe(true);

    storeWith({ ...LEGACY_SEND_ONLY, email_ask_before_send: false });
    expect((await getEmailCredentials())?.askBeforeSend).toBe(false);
  });

  it("ignores a stored mode that is not one of the three", async () => {
    storeWith({ ...LEGACY_SEND_ONLY, email_mode: "everything" });
    expect((await getEmailCredentials())?.mode).toBe("send");
  });
});

describe("saving pins both values", () => {
  it("writes the mode and the gate explicitly, so no migration re-runs", async () => {
    await saveEmailSettings({
      address: "box@example.com",
      password: "pw",
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      smtpSecure: false,
      mode: "read",
      askBeforeSend: true,
    });
    expect(mockSetMany).toHaveBeenCalledWith(
      expect.objectContaining({ email_mode: "read", email_ask_before_send: true }),
    );
  });
});

describe("what the panel is told", () => {
  it("offers the gate ON to a device with no account yet", async () => {
    storeWith({});
    const status = await publicEmailStatus();
    expect(status.configured).toBe(false);
    expect(status.askBeforeSend).toBe(true);
    expect(status.mode).toBe("send");
  });

  it("shows the derived incoming server once reading is on", async () => {
    // The panel shows what would actually be dialled, while the form keeps only
    // the explicit override — so a blank field does not look like a broken one.
    storeWith({ ...LEGACY_SEND_ONLY, email_mode: "read" });
    const status = await publicEmailStatus();
    expect(status.imapHost).toBe("imap.gmail.com");
    expect(status.imapHostExplicit).toBeNull();
  });

  it("reports no incoming server at all in send-only mode", async () => {
    storeWith(LEGACY_SEND_ONLY);
    const status = await publicEmailStatus();
    expect(status.imapHost).toBeNull();
    expect(status.inbound).toBe(false);
  });

  it("still never returns the password", async () => {
    storeWith(LEGACY_INBOUND);
    const status = await publicEmailStatus();
    expect(JSON.stringify(status)).not.toContain("abcd efgh ijkl mnop");
    expect(status.hasPassword).toBe(true);
  });
});
