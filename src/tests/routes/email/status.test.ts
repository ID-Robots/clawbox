import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  // Spread the real module so DATA_DIR (used by the pending store, which the
  // email routes now reach) keeps its value.
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  setMany: vi.fn(),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-email", () => ({ hermesEmailState: vi.fn() }));
// Mocked rather than left real: the route counts pending drafts, and the real
// store would read whatever data/email-pending.json happens to hold on the
// machine running the suite.
vi.mock("@/lib/email-pending", () => ({ countPending: vi.fn() }));

import { get } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { countPending } from "@/lib/email-pending";
import { hermesEmailState } from "@/lib/hermes-email";

const mockGet = vi.mocked(get);
const mockHarness = vi.mocked(getActiveHarness);
const mockHermesState = vi.mocked(hermesEmailState);
const mockCount = vi.mocked(countPending);

let GET: typeof import("@/app/setup-api/email/status/route").GET;

const PASSWORD = "abcd efgh ijkl mnop";

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  mockHarness.mockResolvedValue("openclaw");
  mockCount.mockReturnValue(0);
  storeWith({});
  GET = (await import("@/app/setup-api/email/status/route")).GET;
});

describe("GET /setup-api/email/status", () => {
  it("answers whether the agent may read, so the MCP server need not re-derive it", async () => {
    // mcp/lib/context.ts registers email_list and email_read on this flag. If
    // it re-derived the rule from `mode`, a fourth mode would have to be
    // remembered in two repositories' worth of code.
    const modes: [string, boolean][] = [
      ["send", false],
      ["read", true],
      ["answer", true],
    ];
    for (const [mode, expected] of modes) {
      storeWith({
        email_address: "box@example.com",
        email_password: PASSWORD,
        email_smtp_host: "smtp.gmail.com",
        email_smtp_port: 587,
        email_mode: mode,
        email_allowed_senders: mode === "answer" ? ["a@b.com"] : [],
      });
      const data = await (await GET()).json();
      expect(data.mode).toBe(mode);
      expect(data.canRead).toBe(expected);
    }
  });

  it("answers canRead false on a device with no account", async () => {
    expect((await (await GET()).json()).canRead).toBe(false);
  });

  it("carries the pending-draft count and the defaults the panel fills in with", async () => {
    // The badge on the nav item comes from here, before the panel has ever
    // opened the pending route.
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.gmail.com",
      email_smtp_port: 587,
    });
    mockCount.mockReturnValue(3);
    const data = await (await GET()).json();
    expect(data.pendingCount).toBe(3);
    expect(data.defaults.smtpHost).toBe("smtp.gmail.com");
    expect(data.defaults.smtpPort).toBe(587);
    expect(data.defaults.imapHost).toBe("imap.gmail.com");
  });

  it("counts nothing on a device with no account, without reading the queue", async () => {
    const data = await (await GET()).json();
    expect(data.pendingCount).toBe(0);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("reports not configured on a fresh device", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.configured).toBe(false);
    expect(data.address).toBeNull();
    expect(data.hasPassword).toBe(false);
  });

  it("masks the address and never returns the password", async () => {
    storeWith({
      email_address: "owner@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.gmail.com",
      email_smtp_port: 587,
    });
    const res = await GET();
    const body = await res.text();

    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain("owner@example.com");
    const data = JSON.parse(body);
    expect(data.configured).toBe(true);
    expect(data.hasPassword).toBe(true);
    expect(data.address).toBe("o•••r@example.com");
    // The domain stays readable — that is what identifies the account.
    expect(data.address).toContain("@example.com");
  });

  it("reports inbound as unsupported on OpenClaw", async () => {
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.gmail.com",
    });
    const res = await GET();
    const data = await res.json();
    expect(data.inboundSupported).toBe(false);
    expect(data.inbound).toBe(false);
    expect(mockHermesState).not.toHaveBeenCalled();
  });

  it("asks Hermes what it actually has, not what ClawBox stored", async () => {
    mockHarness.mockResolvedValue("hermes");
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.gmail.com",
    });
    mockHermesState.mockResolvedValue({
      address: "box@example.com",
      imapHost: "imap.gmail.com",
      allowedSenders: ["owner@example.com"],
      hasPassword: true,
    });
    const res = await GET();
    const data = await res.json();
    expect(data.inboundSupported).toBe(true);
    expect(data.inbound).toBe(true);
    expect(data.allowedSenders).toEqual(["owner@example.com"]);
  });

  it("does not claim the feature is gone when Hermes cannot be read", async () => {
    mockHarness.mockResolvedValue("hermes");
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.gmail.com",
    });
    mockHermesState.mockRejectedValue(new Error("EACCES"));
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.configured).toBe(true);
    expect(data.inboundUnknown).toBe(true);
  });
});
