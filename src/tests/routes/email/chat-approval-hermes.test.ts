// The same-bot guard on a HERMES device.
//
// The guard exists because two long-pollers on one bot fight: Telegram answers
// the second `getUpdates` with "Conflict: terminated by other getUpdates
// request", and the owner's ordinary chat starts dropping messages. So the
// approvals bot must never be the bot the harness is already listening on.
//
// On OpenClaw ClawBox holds that credential itself, so comparing against its
// own config store answers the question. On Hermes it does NOT: the harness
// keeps its bot token in ~/.hermes/.env (the path `hermes config env-path`
// prints, and where `hermes config set TELEGRAM_BOT_TOKEN` writes), and
// ClawBox's copy exists only as a side effect of /setup-api/telegram/configure.
// A box paired with `hermes config set`, or restored without ClawBox's
// config.json, has a working bot and no copy — and the guard, asking the wrong
// store, FAILED OPEN and let the owner point the approvals bot straight at it.
//
// These tests use the real config store, the real edition lock and a real
// ~/.hermes/.env; only the Telegram network call is mocked.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email-approval-telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-approval-telegram")>()),
  fetchApprovalBotInfo: vi.fn(),
}));

const SESSION_SECRET = "b".repeat(64);
// Telegram tokens are `<bot id>:<secret>`. These two are the SAME bot with a
// rotated secret, which is why the guard has to compare the id.
const MAIN_BOT_TOKEN = "111111:HermesMainBotSecret_0";
const MAIN_BOT_ROTATED = "111111:HermesMainBotSecret_1";
const OTHER_BOT_TOKEN = "777777:ZZaabbCCddEEffgg_hh-ii";

let root: string;
let hermesHome: string;
let POST: typeof import("@/app/setup-api/email/chat-approval/route").POST;
let auth: typeof import("@/lib/auth");
let telegram: typeof import("@/lib/email-approval-telegram");

function ownerRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/email/chat-approval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`,
    },
    body: JSON.stringify(body),
  });
}

/** What ClawBox has actually stored, read back off disk. */
function storedConfig(): Record<string, unknown> {
  const file = path.join(root, "data", "config.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeHermesEnv(contents: string): void {
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, ".env"), contents, { mode: 0o600 });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-approval-hermes-"));
  hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermes-home-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.HERMES_HOME = hermesHome;
  process.env.SESSION_SECRET = SESSION_SECRET;
  // The edition lock is the source of truth for which harness runs; with no
  // /etc/clawbox/edition.env on a dev box or in CI it falls back to the env.
  process.env.CLAWBOX_EDITION = "hermes";
  vi.resetModules();

  auth = await import("@/lib/auth");
  telegram = await import("@/lib/email-approval-telegram");
  vi.mocked(telegram.fetchApprovalBotInfo).mockResolvedValue({ id: 777777, username: "ClawBoxApprovals" });

  POST = (await import("@/app/setup-api/email/chat-approval/route")).POST;
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.HERMES_HOME;
  delete process.env.SESSION_SECRET;
  delete process.env.CLAWBOX_EDITION;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(hermesHome, { recursive: true, force: true });
});

describe("POST /setup-api/email/chat-approval — the same-bot guard on Hermes", () => {
  it("refuses the bot Hermes is long-polling even with no ClawBox copy of the token", async () => {
    writeHermesEnv(`TELEGRAM_BOT_TOKEN=${MAIN_BOT_TOKEN}\n`);

    const res = await POST(ownerRequest({ botToken: MAIN_BOT_TOKEN }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "same_bot" });
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
    expect(storedConfig().email_approval_bot_token).toBeUndefined();
  });

  // Telegram's /revoke issues a NEW secret for the SAME bot. The two tokens do
  // not compare equal, and the two pollers still collide — the id is the bot.
  it("refuses a rotated token for the same bot, which raw-token equality misses", async () => {
    writeHermesEnv(`TELEGRAM_BOT_TOKEN=${MAIN_BOT_TOKEN}\n`);

    const res = await POST(ownerRequest({ botToken: MAIN_BOT_ROTATED }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: "same_bot" });
    expect(storedConfig().email_approval_bot_token).toBeUndefined();
  });

  // FAIL CLOSED. An unreadable ~/.hermes/.env means we do not know which bot
  // the harness holds, and "we could not check" is not permission to save.
  it("refuses the save when Hermes' own store cannot be read", async () => {
    fs.mkdirSync(path.join(hermesHome, ".env"), { recursive: true });

    const res = await POST(ownerRequest({ botToken: OTHER_BOT_TOKEN }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.kind).toBe("bot_unknown");
    expect(typeof body.error).toBe("string");
    expect(telegram.fetchApprovalBotInfo).not.toHaveBeenCalled();
    expect(storedConfig().email_approval_bot_token).toBeUndefined();
  });

  it("still saves a genuinely different bot", async () => {
    writeHermesEnv(`TELEGRAM_BOT_TOKEN=${MAIN_BOT_TOKEN}\n`);

    const res = await POST(ownerRequest({ botToken: OTHER_BOT_TOKEN }));

    expect(res.status).toBe(200);
    expect(storedConfig().email_approval_bot_token).toBe(OTHER_BOT_TOKEN);
  });

  // A Hermes box with no bot at all has nothing to collide with; the owner may
  // set the approvals bot up first.
  it("saves when Hermes demonstrably has no bot of its own", async () => {
    writeHermesEnv("# nothing configured yet\n");

    const res = await POST(ownerRequest({ botToken: OTHER_BOT_TOKEN }));

    expect(res.status).toBe(200);
    expect(storedConfig().email_approval_bot_token).toBe(OTHER_BOT_TOKEN);
  });
});
