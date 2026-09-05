// /setup-api/email/chat-approval — the switch that decides whether a tap in a
// chat can send mail.
//
// The authorization tests run against the REAL session verification, exactly as
// pending.test.ts does and for the same reason: this route is the hinge of the
// gate. A caller who could point the device at an approvals bot THEY control
// would be able to approve every draft from then on, so it has to answer to a
// signed-in browser and refuse the MCP bearer the agent holds — no matter how
// valid that bearer is.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  // The tri-state read the approvals-token reader uses: `known: false` says the
  // store could not be read, which is what makes a save gate refuse rather than
  // skip itself. Driven off the same fixture as `get`.
  getKnown: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/lib/email-approval-telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-approval-telegram")>()),
  fetchApprovalBotInfo: vi.fn(),
}));
// The edition lock decides which harness stores count as evidence; with none
// installed but OpenClaw, a stray ~/.hermes/.env is not this box's business.
vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "openclaw"),
  getEdition: vi.fn(() => "openclaw"),
  // `defaulted: false` — this fixture IS the edition lock speaking. Left
  // defaulted, the guard would read both stores as possible and this suite
  // would be asserting the missing-lock path instead of the OpenClaw one.
  getEditionSource: vi.fn(() => ({ edition: "openclaw", defaulted: false })),
}));
vi.mock("@/lib/openclaw-config", () => ({
  readTelegramAllowFrom: vi.fn(async () => ["6001"]),
  // The same-bot guard asks the HARNESS which bot it polls. Empty here, so this
  // suite keeps testing exactly what it tested before: the guard answering from
  // ClawBox's own stored copy.
  readConfigStrict: vi.fn(async () => ({})),
}));
vi.mock("@/lib/hermes-telegram", () => ({
  readHermesApprovedUsers: vi.fn(async () => []),
  readHermesTelegramToken: vi.fn(async () => ({ token: null, known: true })),
}));

const SESSION_SECRET = "a".repeat(64);
const APPROVAL_TOKEN = "777777:ZZaabbCCddEEffgg_hh-ii";
const MAIN_BOT_TOKEN = "111111:MainBotSecretValue_00";

let root: string;
let GET: typeof import("@/app/setup-api/email/chat-approval/route").GET;
let POST: typeof import("@/app/setup-api/email/chat-approval/route").POST;
let DELETE: typeof import("@/app/setup-api/email/chat-approval/route").DELETE;
let configStore: typeof import("@/lib/config-store");
let telegram: typeof import("@/lib/email-approval-telegram");
let openclawConfig: typeof import("@/lib/openclaw-config");
let auth: typeof import("@/lib/auth");

let stored: Record<string, unknown>;

function ownerCookie(): string {
  return `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(init: { cookie?: string; bearer?: string; body?: unknown; method?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  return new Request("http://localhost/setup-api/email/chat-approval", {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-chat-approval-"));
  process.env.CLAWBOX_ROOT = root;
  // The real session verifier, reading its secret the way auth.ts does. The
  // gate has to be the code, not a mock of the code.
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.resetModules();

  auth = await import("@/lib/auth");
  configStore = await import("@/lib/config-store");
  telegram = await import("@/lib/email-approval-telegram");
  openclawConfig = await import("@/lib/openclaw-config");

  stored = {};
  vi.mocked(configStore.get).mockImplementation(async (key: string) => stored[key]);
  vi.mocked(configStore.getKnown).mockImplementation(async (key: string) => ({
    value: stored[key],
    known: true,
  }));
  vi.mocked(configStore.set).mockImplementation(async (key: string, value: unknown) => {
    if (value === undefined) delete stored[key];
    else stored[key] = value;
  });
  vi.mocked(telegram.fetchApprovalBotInfo).mockResolvedValue({ id: 777777, username: "ClawBoxApprovals" });

  const route = await import("@/app/setup-api/email/chat-approval/route");
  GET = route.GET;
  POST = route.POST;
  DELETE = route.DELETE;
});

afterEach(async () => {
  const approval = await import("@/lib/email-approval");
  approval.stopApprovalPoller();
  delete process.env.CLAWBOX_ROOT;
  delete process.env.SESSION_SECRET;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("only the owner may change how email is approved", () => {
  it("refuses a caller with no credential", async () => {
    expect((await GET(request())).status).toBe(403);
  });

  it("refuses the MCP bearer the agent holds, however valid it is", async () => {
    stored["mcp:token"] = "a-perfectly-good-mcp-token";

    const read = await GET(request({ bearer: "a-perfectly-good-mcp-token" }));
    const write = await POST(request({ bearer: "a-perfectly-good-mcp-token", body: { botToken: APPROVAL_TOKEN } }));
    const wipe = await DELETE(request({ bearer: "a-perfectly-good-mcp-token", method: "DELETE" }));

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(wipe.status).toBe(403);
    // Nothing was stored, so the agent cannot point the device at a bot it owns.
    expect(stored.email_approval_bot_token).toBeUndefined();
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
  });

  it("gives the same refusal either way, so a working bearer is not a hint", async () => {
    const anonymous = await (await GET(request())).json();
    const bearer = await (await GET(request({ bearer: "a-perfectly-good-mcp-token" }))).json();
    expect(anonymous).toEqual(bearer);
  });

  it("lets a signed-in browser read the state", async () => {
    const res = await GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, botConfigured: false, ownerChats: 1 });
  });
});

describe("connecting the approvals bot", () => {
  it("checks the token with Telegram before storing it", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: APPROVAL_TOKEN, enabled: true } }));

    expect(res.status).toBe(200);
    expect(telegram.fetchApprovalBotInfo).toHaveBeenCalledWith(APPROVAL_TOKEN);
    expect(stored.email_approval_bot_token).toBe(APPROVAL_TOKEN);
    expect(await res.json()).toMatchObject({ enabled: true, botConfigured: true, botUsername: "ClawBoxApprovals" });
  });

  it("stores nothing when Telegram rejects the token", async () => {
    vi.mocked(telegram.fetchApprovalBotInfo).mockRejectedValue(new telegram.TelegramApiError("Unauthorized", 401));

    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: APPROVAL_TOKEN } }));

    expect(res.status).toBe(400);
    expect(stored.email_approval_bot_token).toBeUndefined();
  });

  it("refuses a value that could not be a bot token, without asking Telegram", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: "../../etc/passwd" } }));

    expect(res.status).toBe(400);
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
  });

  // OpenClaw keeps its OWN copy of the credential — `setTelegramToken()` writes
  // `channels.telegram.botToken` into openclaw.json, and the gateway polls from
  // there. ClawBox's `telegram_bot_token` is a mirror its configure route
  // happens to write, so a box set up through the `openclaw` CLI or restored
  // with ~/.openclaw intact and a fresh data/config.json has the bot and no
  // mirror — and the guard, asking only the mirror, waved it straight through.
  it("REFUSES a bot only OpenClaw's own config knows about", async () => {
    vi.mocked(openclawConfig.readConfigStrict).mockResolvedValue({
      channels: { telegram: { enabled: true, botToken: MAIN_BOT_TOKEN } },
    });

    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: MAIN_BOT_TOKEN } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "same_bot" });
    expect(stored.email_approval_bot_token).toBeUndefined();
  });

  // Telegram's /revoke issues a new secret for the SAME bot. Both tokens drive
  // the same getUpdates stream, so whole-token equality is not identity.
  it("REFUSES a rotated secret for the bot the harness polls", async () => {
    stored.telegram_bot_token = MAIN_BOT_TOKEN;

    const rotated = "111111:MainBotSecretValue_11";
    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: rotated } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "same_bot" });
    expect(stored.email_approval_bot_token).toBeUndefined();
  });

  // The case above still seeds ClawBox's mirror, so it proves the rotation rule
  // and not the native store. This one has NO mirror at all — the state of a box
  // paired with `openclaw config set` — so both halves have to hold at once.
  it("REFUSES a rotated secret against OpenClaw's own store, with no mirror", async () => {
    vi.mocked(openclawConfig.readConfigStrict).mockResolvedValue({
      channels: { telegram: { enabled: true, botToken: MAIN_BOT_TOKEN } },
    });

    const rotated = "111111:MainBotSecretValue_11";
    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: rotated } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "same_bot" });
    expect(stored.telegram_bot_token).toBeUndefined();
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
    expect(stored.email_approval_bot_token).toBeUndefined();
  });

  // FAIL CLOSED. An openclaw.json that exists but cannot be read is not
  // evidence that this is a second bot.
  it("refuses the save when the harness config cannot be read", async () => {
    vi.mocked(openclawConfig.readConfigStrict).mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );

    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: APPROVAL_TOKEN } }));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ kind: "bot_unknown" });
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
    expect(stored.email_approval_bot_token).toBeUndefined();
  });

  it("REFUSES the bot the harness is already long-polling", async () => {
    // The whole design rests on this bot's updates being ClawBox's alone. The
    // main bot's token would put two pollers on one connection and take the
    // owner's normal Telegram chat down with it — and the approval would then
    // be arriving through the same process that runs the agent.
    stored.telegram_bot_token = MAIN_BOT_TOKEN;

    const res = await POST(request({ cookie: ownerCookie(), body: { botToken: MAIN_BOT_TOKEN } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "same_bot" });
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
    expect(stored.email_approval_bot_token).toBeUndefined();
  });

  it("will not switch on without a bot behind the switch", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));

    expect(res.status).toBe(409);
    expect(stored.email_chat_approval).toBeUndefined();
  });

  it("forgets the bot and switches off on DELETE", async () => {
    stored.email_approval_bot_token = APPROVAL_TOKEN;
    stored.email_chat_approval = true;

    const res = await DELETE(request({ cookie: ownerCookie(), method: "DELETE" }));

    expect(res.status).toBe(200);
    expect(stored.email_approval_bot_token).toBeUndefined();
    expect(stored.email_chat_approval).toBe(false);
  });
});
