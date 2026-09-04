// Which Telegram bot does this box poll — asked of the HARNESS, on both
// editions, and honest about the difference between "no bot" and "we could not
// look".
//
// Driven through the real modules wherever a real file will do: a real
// ~/.hermes/.env under HERMES_HOME, a real openclaw.json under OPENCLAW_HOME
// and the real edition lock through CLAWBOX_EDITION. Only ClawBox's own config
// store is mocked, because it resolves its path at import time.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));

import { get } from "@/lib/config-store";

const mockGet = vi.mocked(get);

const OPENCLAW_BOT = "111111:OpenClawGatewayBot_0";
const HERMES_BOT = "222222:HermesGatewayBot_00";
const MIRROR_BOT = "333333:ClawBoxMirrorBot_00";

let hermesHome: string;
let openclawHome: string;
let identity: typeof import("@/lib/telegram-bot-identity");

function writeHermesToken(value: string | null): void {
  fs.writeFileSync(
    path.join(hermesHome, ".env"),
    value === null ? "# nothing configured yet\n" : `TELEGRAM_BOT_TOKEN=${value}\n`,
    { mode: 0o600 },
  );
}

function writeOpenClawToken(value: string | null): void {
  const config = value === null ? {} : { channels: { telegram: { enabled: true, botToken: value } } };
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify(config), "utf-8");
}

function writeOpenClawConfig(config: unknown): void {
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), JSON.stringify(config), "utf-8");
}

/** Hermes' config.yaml — the FALLBACK half of its own env bridge. */
function writeHermesConfigYaml(contents: string): void {
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), contents, { mode: 0o600 });
}

/** Break a store so it exists and cannot be read (EISDIR on the read). */
function makeUnreadable(file: string): void {
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
}

beforeEach(async () => {
  hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-bot-identity-hermes-"));
  openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-bot-identity-openclaw-"));
  process.env.HERMES_HOME = hermesHome;
  process.env.OPENCLAW_HOME = openclawHome;
  process.env.CLAWBOX_EDITION = "openclaw";
  vi.resetModules();
  vi.clearAllMocks();
  mockGet.mockResolvedValue(undefined);
  writeHermesToken(null);
  writeOpenClawToken(null);
  identity = await import("@/lib/telegram-bot-identity");
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  delete process.env.OPENCLAW_HOME;
  delete process.env.CLAWBOX_EDITION;
  fs.rmSync(hermesHome, { recursive: true, force: true });
  fs.rmSync(openclawHome, { recursive: true, force: true });
});

describe("telegramBotId", () => {
  it("reads the bot id off a token, ignoring surrounding whitespace", () => {
    expect(identity.telegramBotId(" 123456:AbC-def_0 ")).toBe("123456");
  });

  it("is the same id for a rotated secret, which is the point", () => {
    expect(identity.telegramBotId("123456:secretOne")).toBe(identity.telegramBotId("123456:secretTwo"));
  });

  it("refuses anything that is not a token", () => {
    for (const value of [null, undefined, 42, "", "token123", "abc:def", "../../etc/passwd", ":secret"]) {
      expect(identity.telegramBotId(value)).toBeNull();
    }
  });

  it("refuses a value long enough to have been pasted over the real one", () => {
    expect(identity.telegramBotId(`123456:${"a".repeat(201)}`)).toBeNull();
  });

  // LOAD-BEARING INVARIANT, and until now unasserted. The approvals route
  // proves the submitted value with `safeBotToken` and then compares it by id;
  // if `telegramBotId` rejected something `safeBotToken` accepted, `approvalBotId`
  // would be null, the same-bot comparison would be SKIPPED entirely, and — with
  // `known: true` — the save would go straight through. The two patterns live in
  // two modules on purpose (each rebuilds its own token from its own match, which
  // is what CodeQL reads as a sanitizer), so what has to be pinned is that they
  // accept the same language.
  it("accepts exactly what the approvals route's own token check accepts", async () => {
    const { safeBotToken } = await import("@/lib/email-approval-telegram");
    const corpus = [
      "123456:AbC-def_0",
      " 123456:AbC-def_0 ",
      `123456:${"a".repeat(200)}`,
      `123456:${"a".repeat(201)}`,
      `${"9".repeat(20)}:secret`,
      `${"9".repeat(21)}:secret`,
      "123456:has space",
      "123:abc/../../evil?x=",
      "123456:sec.ret",
      "abc:def",
      ":secret",
      "123456:",
      "token123",
      "",
    ];
    for (const value of corpus) {
      expect([value, safeBotToken(value) !== null]).toEqual([value, identity.telegramBotId(value) !== null]);
    }
  });
});

describe("readActiveTelegramBot", () => {
  it("prefers OpenClaw's own channel token over ClawBox's mirror", async () => {
    writeOpenClawToken(OPENCLAW_BOT);
    mockGet.mockResolvedValue(MIRROR_BOT);

    expect(await identity.readActiveTelegramBot("openclaw")).toEqual({ token: OPENCLAW_BOT, known: true });
  });

  it("prefers Hermes' own env token over ClawBox's mirror", async () => {
    writeHermesToken(HERMES_BOT);
    mockGet.mockResolvedValue(MIRROR_BOT);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: HERMES_BOT, known: true });
  });

  // The mirror is the only trace of a bot on a box whose harness store is fine
  // but empty — an OpenClaw box configured before the channel block existed.
  it("falls back to the mirror when the harness store holds nothing", async () => {
    mockGet.mockResolvedValue(MIRROR_BOT);

    expect(await identity.readActiveTelegramBot("openclaw")).toEqual({ token: MIRROR_BOT, known: true });
  });

  // Reporting a working bot as gone is the false failure this module exists to
  // remove, so an unreadable store still degrades to the mirror — but says so.
  it("degrades to the mirror when the harness store cannot be read, and says known:false", async () => {
    fs.rmSync(path.join(hermesHome, ".env"));
    fs.mkdirSync(path.join(hermesHome, ".env"));
    mockGet.mockResolvedValue(MIRROR_BOT);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: MIRROR_BOT, known: false });
  });

  it("reports no bot, confidently, when neither store has one", async () => {
    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: null, known: true });
  });

  // Both harness stores are open to more than ClawBox's validating writer:
  // ~/.hermes/.env comes from Hermes' own template of key hints. A value that
  // cannot address a bot must not end the setup wizard.
  it("ignores a harness value that could not be a bot token", async () => {
    writeHermesToken("changeme");

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: null, known: true });
  });

  // Hermes resolves this credential through its env bridge, not through one
  // file: .env into the environment first, then config.yaml's TOP-LEVEL scalars
  // for the keys .env does not define (gateway/run.py, hermes_cli/send_cmd.py).
  // A box provisioned that way polls a real bot that a .env-only read reported
  // as absent — with `known: true` over it, which is what fails a guard open.
  it("reads the bot out of Hermes' config.yaml when .env defines none", async () => {
    writeHermesConfigYaml(`model: openrouter/some-model\nTELEGRAM_BOT_TOKEN: ${HERMES_BOT}\n`);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: HERMES_BOT, known: true });
  });

  // .env is loaded with override and the config.yaml bridge skips keys already
  // in the environment, so a config.yaml copy is a fallback, never an override.
  it("prefers .env over a shadowed config.yaml copy, as the bridge does", async () => {
    writeHermesToken(HERMES_BOT);
    writeHermesConfigYaml(`TELEGRAM_BOT_TOKEN: ${MIRROR_BOT}\n`);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: HERMES_BOT, known: true });
  });

  // The bridge reads TOP-LEVEL scalars only, so a same-named key nested inside
  // some other block is not a credential this box would ever poll with.
  it("does not mistake a nested key for the top-level scalar the bridge reads", async () => {
    writeHermesConfigYaml(`skills:\n  config:\n    TELEGRAM_BOT_TOKEN: ${HERMES_BOT}\n`);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: null, known: true });
  });

  it("reads a quoted top-level value", async () => {
    writeHermesConfigYaml(`TELEGRAM_BOT_TOKEN: "${HERMES_BOT}"\n`);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: HERMES_BOT, known: true });
  });

  // A shape the line reader does not model — here a top-level sequence — is not
  // evidence about THIS key. Answering "unknown" over it would leave both
  // Telegram save gates permanently 503 on a box whose config.yaml is merely
  // unusual, which is the false failure this module exists to remove.
  it("stays known for a config.yaml it cannot parse that does not name the key", async () => {
    writeHermesConfigYaml("- one\n- two\n");

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: null, known: true });
  });

  it("says known:false when config.yaml names the key and cannot be parsed", async () => {
    writeHermesConfigYaml(`- one\nTELEGRAM_BOT_TOKEN: ${HERMES_BOT}\n`);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: null, known: false });
  });

  it("says known:false when config.yaml could hold the fallback and cannot be read", async () => {
    makeUnreadable(path.join(hermesHome, "config.yaml"));
    mockGet.mockResolvedValue(MIRROR_BOT);

    expect(await identity.readActiveTelegramBot("hermes")).toEqual({ token: MIRROR_BOT, known: false });
  });

  // A channel can carry an env REFERENCE instead of a literal (the form Discord
  // uses). We cannot resolve it, and saying "no bot" over one is the confident
  // wrong answer this module exists to stop.
  it("says known:false for an OpenClaw channel whose credential is a reference", async () => {
    writeOpenClawConfig({
      channels: {
        telegram: { enabled: true, token: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" } },
      },
    });

    expect(await identity.readActiveTelegramBot("openclaw")).toEqual({ token: null, known: false });
  });
});

describe("readTelegramBotsInUse", () => {
  it("collects every bot any INSTALLED harness on this box could be polling", async () => {
    process.env.CLAWBOX_EDITION = "dual";
    writeOpenClawToken(OPENCLAW_BOT);
    writeHermesToken(HERMES_BOT);
    mockGet.mockResolvedValue(MIRROR_BOT);

    const inUse = await identity.readTelegramBotsInUse();

    expect(inUse.known).toBe(true);
    expect(inUse.ids.sort()).toEqual(["111111", "222222", "333333"]);
  });

  // The dual SKU installs both harnesses and the active one is a runtime
  // toggle, so the INACTIVE harness's bot is a collision waiting for the next
  // switch. Asking only the active harness would let it through.
  it("includes the inactive harness's bot on a dual box", async () => {
    process.env.CLAWBOX_EDITION = "dual";
    writeOpenClawToken(OPENCLAW_BOT);
    writeHermesToken(HERMES_BOT);

    const inUse = await identity.readTelegramBotsInUse();

    expect(inUse.ids).toContain("111111");
    expect(inUse.ids).toContain("222222");
  });

  it("does not count one bot twice when the mirror agrees with the harness", async () => {
    writeOpenClawToken(OPENCLAW_BOT);
    mockGet.mockResolvedValue(OPENCLAW_BOT);

    expect((await identity.readTelegramBotsInUse()).ids).toEqual(["111111"]);
  });

  // A store that exists but cannot be read is not evidence of anything, and the
  // approval guard refuses on exactly this flag.
  it("reports known:false when THIS edition's harness store cannot be read", async () => {
    makeUnreadable(path.join(openclawHome, "openclaw.json"));

    expect((await identity.readTelegramBotsInUse()).known).toBe(false);
  });

  // ...and the mirror image: the edition lock says which harnesses are
  // INSTALLED, so a stray root-owned ~/.hermes/.env on an OpenClaw box — from a
  // dual base image, or a provisioning step run as root — is not a store this
  // device polls. Counting it made `known` false permanently, and every
  // approvals-bot save answer 503 on the flagship SKU with no way back.
  it("ignores an unreadable store belonging to a harness this box does not run", async () => {
    makeUnreadable(path.join(hermesHome, ".env"));
    writeOpenClawToken(OPENCLAW_BOT);

    expect(await identity.readTelegramBotsInUse()).toEqual({ ids: ["111111"], known: true });
  });

  it("still consults both stores on a dual box, where both harnesses ARE installed", async () => {
    process.env.CLAWBOX_EDITION = "dual";
    makeUnreadable(path.join(hermesHome, ".env"));

    expect((await identity.readTelegramBotsInUse()).known).toBe(false);
  });

  // A single-harness box simply has no second store; absence is a clean answer
  // and must not be confused with a fault.
  it("stays known when the other harness is not installed at all", async () => {
    fs.rmSync(path.join(hermesHome, ".env"));
    fs.rmSync(path.join(openclawHome, "openclaw.json"));
    mockGet.mockResolvedValue(MIRROR_BOT);

    expect(await identity.readTelegramBotsInUse()).toEqual({ ids: ["333333"], known: true });
  });
});
