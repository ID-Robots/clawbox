import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  // Spread the real module so DATA_DIR (used by the pending store, which the
  // email routes now reach) keeps its value.
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  getKnownMany: vi.fn(),
  setMany: vi.fn(),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-email", () => ({ hermesEmailState: vi.fn() }));
// Mocked rather than left real: the route counts pending drafts, and the real
// store would read whatever data/email-pending.json happens to hold on the
// machine running the suite.
vi.mock("@/lib/email-pending", () => ({ countPending: vi.fn() }));

import { get, getKnownMany } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { countPending } from "@/lib/email-pending";
import { hermesEmailState } from "@/lib/hermes-email";

const mockGet = vi.mocked(get);
const mockGetKnownMany = vi.mocked(getKnownMany);
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
  // The default is a store that WAS read and holds nothing.
  mockGetKnownMany.mockResolvedValue({ values: {}, known: true });
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
    const data = await (await GET()).json();
    expect(data.canRead).toBe(false);
    // …and says nothing about the store, because there was nothing wrong with
    // it. `storeUnreadable` is absent rather than false, so a build that
    // predates the field cannot be read as "the store was fine".
    expect(data.storeUnreadable).toBeUndefined();
  });

  it("says so when `configured: false` only means the store could not be READ", async () => {
    // The ordinary config read answers `{}` to an EACCES, an EIO and a
    // half-written JSON alike, so "no account" and "could not look" arrive here
    // as the same 200. They are not the same answer: the MCP server WITHDRAWS
    // email_list/email_read from a running agent on a definite no, and a
    // root-owned data/config.json after an update would otherwise take a
    // working mailbox away from it (mcp/lib/context.ts probeEmailReadStatus).
    mockGetKnownMany.mockResolvedValue({ values: {}, known: false });
    const data = await (await GET()).json();
    expect(data.configured).toBe(false);
    expect(data.canRead).toBe(false);
    expect(data.storeUnreadable).toBe(true);
  });

  it("says so when the FIRST read failed and a later one succeeded", async () => {
    // Two reads of one file can disagree. A store that was unreadable when the
    // account was resolved and readable a moment later would otherwise answer
    // `configured: false` with a clean bill of health — the first read's failure
    // erased by the second read's success — and the agent would lose the read
    // tools over a transient EACCES. No single snapshot can hold a complete
    // account behind a `configured: false`, so that shape is reported as
    // unreadable too.
    storeWith({});
    mockGetKnownMany.mockResolvedValue({
      known: true,
      values: {
        email_address: "box@example.com",
        email_password: PASSWORD,
        email_smtp_host: "smtp.gmail.com",
      },
    });
    const data = await (await GET()).json();
    expect(data.configured).toBe(false);
    expect(data.storeUnreadable).toBe(true);
  });

  it("says so when the store went unreadable midway, behind a RESOLVED account", async () => {
    // The branch an `configured: false`-only guard misses. getEmailCredentials
    // reads the file once per key through the forgiving reader, and only the
    // first three gate `configured`: a store readable for those and unreadable
    // by the time email_mode is read answers `configured: true` with
    // `canRead: false`, because resolveStoredMode falls back to "send". That is
    // the same definite "no" that costs a running agent its mailbox tools, so
    // the store has to be questioned on this branch too.
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.example.com",
      // email_mode and the rest: the later reads that failed.
    });
    mockGetKnownMany.mockResolvedValue({ values: {}, known: false });
    const data = await (await GET()).json();
    expect(data.configured).toBe(true);
    expect(data.canRead).toBe(false);
    expect(data.storeUnreadable).toBe(true);
  });

  it("says so when a failed mode read is healed by the time the store is re-read", async () => {
    // The mirror of the two-reads-disagree case, on the resolved branch: the
    // lenient per-key reads lose email_mode, resolveStoredMode falls back to
    // "send" and the account still answers configured:true/canRead:false — and
    // if the file is readable again a moment later, "the store is fine" would
    // erase that failure exactly as the earlier version erased the other one,
    // and the agent would lose the read tools over one transient EACCES.
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.example.com",
      // email_mode lost to the failed read.
    });
    mockGetKnownMany.mockResolvedValue({
      known: true,
      values: {
        email_address: "box@example.com",
        email_password: PASSWORD,
        email_smtp_host: "smtp.example.com",
        // The healed store still says the owner wants reading.
        email_mode: "read",
      },
    });
    const data = await (await GET()).json();
    expect(data.configured).toBe(true);
    expect(data.canRead).toBe(false);
    expect(data.storeUnreadable).toBe(true);
  });

  it("says so when the account itself is gone from the strict snapshot", async () => {
    // The symmetric case. The first read resolved a complete, readable account;
    // the strict read finds no credentials but still carries email_mode "read",
    // so comparing the MODE alone agrees — about a mailbox that is not there.
    // The two reads disagree about whether an account exists at all, which is
    // the same fault as the opposite shape, and acting on the stale answer would
    // hold email_list/email_read open over nothing.
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.example.com",
      email_mode: "read",
    });
    mockGetKnownMany.mockResolvedValue({
      known: true,
      values: { email_mode: "read" },
    });
    const data = await (await GET()).json();
    expect(data.configured).toBe(true);
    expect(data.canRead).toBe(true);
    expect(data.storeUnreadable).toBe(true);
  });

  it("stays quiet about the store when a resolved account merely chose send-only", async () => {
    // The other side of that coin: the store is readable and the owner picked a
    // mode that keeps the mailbox shut. A flag here would make every send-only
    // device answer "could not ask", and the watch would never act on a real no.
    storeWith({
      email_address: "box@example.com",
      email_password: PASSWORD,
      email_smtp_host: "smtp.example.com",
      email_mode: "send",
    });
    mockGetKnownMany.mockResolvedValue({
      known: true,
      values: {
        email_address: "box@example.com",
        email_password: PASSWORD,
        email_smtp_host: "smtp.example.com",
        email_mode: "send",
      },
    });
    const data = await (await GET()).json();
    expect(data.configured).toBe(true);
    expect(data.canRead).toBe(false);
    expect(data.storeUnreadable).toBeUndefined();
  });

  it("does not cry unreadable over an account that is genuinely half-filled", async () => {
    // An address and no app password is not a store problem — it is a device
    // that is not set up, and the read tools are correctly absent.
    storeWith({ email_address: "box@example.com" });
    mockGetKnownMany.mockResolvedValue({
      known: true,
      values: { email_address: "box@example.com" },
    });
    const data = await (await GET()).json();
    expect(data.configured).toBe(false);
    expect(data.storeUnreadable).toBeUndefined();
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
