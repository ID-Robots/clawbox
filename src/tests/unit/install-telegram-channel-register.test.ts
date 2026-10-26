import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The installers' Telegram channel registration, RUN rather than read.
 *
 * Both installers copy ClawBox's `telegram_bot_token` — a MIRROR its configure
 * route happens to write — into OpenClaw's `channels.telegram.botToken`, which
 * is the credential the gateway polls and the one every ClawBox panel now reads
 * (src/lib/telegram-bot-identity.ts). Unconditionally, on every install AND
 * every update: so a box re-pointed at a new bot with `openclaw config set` had
 * the older mirrored bot silently restored under it at the next update, and the
 * device then chatted as a bot the owner had replaced.
 *
 * The block still earns its place — on a fresh ~/.openclaw (a factory reset, a
 * new image) the mirror is the only copy of the token that survived — so the
 * rule is "fill a gap, never overwrite", and the dmPolicy/allowFrom strip beside
 * it runs either way.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();

/** The embedded `node` heredoc named by its closing marker, as source. */
function heredoc(file: string, marker: string, occurrence = 0): string {
  const text = fs.readFileSync(path.join(REPO, file), "utf-8");
  let from = 0;
  for (let i = 0; i <= occurrence; i += 1) {
    const open = text.indexOf(`<<'${marker}'\n`, from);
    if (open < 0) throw new Error(`${file}: no <<'${marker}' heredoc #${occurrence}`);
    from = open + `<<'${marker}'\n`.length;
  }
  const close = text.indexOf(`\n${marker}\n`, from);
  if (close < 0) throw new Error(`${file}: heredoc ${marker} never closes`);
  return text.slice(from, close);
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-install-telegram-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runInstallSh(env: Record<string, string>): void {
  execFileSync(process.execPath, ["-e", heredoc("install.sh", "NODE")], {
    env: { ...process.env, ...env },
  });
}

function runInstallX64(env: Record<string, string>): void {
  execFileSync(process.execPath, ["-e", heredoc("install-x64.sh", "NODE")], {
    env: { ...process.env, ...env },
  });
}

const MIRRORED_BOT = "111111:MirroredBotSecret_val";
const NATIVE_BOT = "333333:NativeBotSecretValue";
/** OpenClaw's other credential shape: a reference to an environment variable. */
const ENV_REF = { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" };

describe("install.sh registers the Telegram channel without clobbering the harness", () => {
  it("fills an empty channel block from ClawBox's mirror", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: {} }), "utf-8");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: MIRRORED_BOT,
    });
  });

  it("creates the file when ~/.openclaw has none yet", () => {
    const cfg = path.join(dir, "fresh", "openclaw.json");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram.botToken).toBe(MIRRORED_BOT);
  });

  it("keeps the bot OpenClaw itself holds, and still strips the legacy keys", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        channels: { telegram: { enabled: true, botToken: NATIVE_BOT, dmPolicy: "open", allowFrom: ["*"] } },
      }),
      "utf-8",
    );

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: NATIVE_BOT,
    });
  });

  // The same bot, in OpenClaw's OTHER credential shape. `botToken` is absent
  // here, so the "OpenClaw's own value wins" guard read an empty string and
  // wrote the mirror as a literal BESIDE the reference - an older bot restored
  // under a re-pointed one, one credential shape further out.
  it("keeps an env-reference credential and writes no literal beside it", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: { telegram: { enabled: true, token: ENV_REF } } }), "utf-8");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      token: ENV_REF,
    });
  });

  // OpenClaw's own schema puts a SecretRef in `botToken` itself. Reading it as
  // "not a string, so no bot" overwrote the reference with the mirror's literal.
  it("keeps a secret reference held in botToken itself", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: { telegram: { enabled: true, botToken: ENV_REF } } }), "utf-8");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: ENV_REF,
    });
  });

  // A multi-account channel keeps its bots under `accounts.<id>` and none at the
  // root (`openclaw channels add` moves it there). A mirror written at the root
  // beside them is a bot nothing asked for, restored under the ones OpenClaw holds.
  it("keeps a multi-account channel's bots and writes no literal at the root beside them", () => {
    const cfg = path.join(dir, "openclaw.json");
    const telegram = {
      enabled: true,
      defaultAccount: "work",
      accounts: { work: { botToken: NATIVE_BOT }, home: { botToken: ENV_REF } },
    };
    fs.writeFileSync(cfg, JSON.stringify({ channels: { telegram } }), "utf-8");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual(telegram);
  });

  // `renameSync` replaces the inode, so the temp file's mode is the one that
  // lands. openclaw.json is 0600 on a box and the service user's umask is 0002,
  // so a plain writeFileSync left the file holding the bot token and the
  // gateway's auth token at 0664, on every install and every update.
  // `token: null` is what the control UI and `openclaw config set --json` write
  // for a CLEARED reference. Read as "OpenClaw holds a bot" it made the
  // installer skip the restore on a factory-reset box - where ClawBox's mirror
  // is the only surviving copy of the token - and report that it kept one,
  // leaving the channel enabled with nothing behind it to poll.
  it.each([
    ["null", null],
    ["an empty string", ""],
  ])("fills the channel when the env reference is unset as %s", (_name, token) => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: { telegram: { enabled: true, token } } }), "utf-8");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      token,
      botToken: MIRRORED_BOT,
    });
  });

  it("re-secures a config file an older build left group- and world-readable", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: {} }), { mode: 0o664 });
    fs.chmodSync(cfg, 0o664);

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect((fs.statSync(cfg).mode & 0o777).toString(8)).toBe("600");
  });

  it("creates a config file that was not there at 0600", () => {
    const cfg = path.join(dir, "fresh-mode", "openclaw.json");

    runInstallSh({ TG_TOKEN: MIRRORED_BOT, CFG: cfg });

    expect((fs.statSync(cfg).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("install-x64.sh registers the Telegram channel the same way", () => {
  function write(openclaw: unknown, clawbox: unknown): { openclawPath: string; clawboxPath: string } {
    const openclawPath = path.join(dir, "openclaw.json");
    const clawboxPath = path.join(dir, "config.json");
    fs.writeFileSync(openclawPath, JSON.stringify(openclaw), "utf-8");
    fs.writeFileSync(clawboxPath, JSON.stringify(clawbox), "utf-8");
    return { openclawPath, clawboxPath };
  }

  it("fills an empty channel block from ClawBox's mirror", () => {
    const { openclawPath, clawboxPath } = write({}, { telegram_bot_token: MIRRORED_BOT });

    runInstallX64({ OPENCLAW_CONFIG: openclawPath, CLAWBOX_CONFIG: clawboxPath });

    expect(JSON.parse(fs.readFileSync(openclawPath, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: MIRRORED_BOT,
    });
  });

  it("keeps the bot OpenClaw itself holds, and still strips the legacy keys", () => {
    const { openclawPath, clawboxPath } = write(
      { channels: { telegram: { enabled: true, botToken: NATIVE_BOT, dmPolicy: "open", allowFrom: ["*"] } } },
      { telegram_bot_token: MIRRORED_BOT },
    );

    runInstallX64({ OPENCLAW_CONFIG: openclawPath, CLAWBOX_CONFIG: clawboxPath });

    expect(JSON.parse(fs.readFileSync(openclawPath, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: NATIVE_BOT,
    });
  });

  it("fills the channel when the env reference is unset as null", () => {
    const { openclawPath, clawboxPath } = write(
      { channels: { telegram: { enabled: true, token: null } } },
      { telegram_bot_token: MIRRORED_BOT },
    );

    runInstallX64({ OPENCLAW_CONFIG: openclawPath, CLAWBOX_CONFIG: clawboxPath });

    expect(JSON.parse(fs.readFileSync(openclawPath, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      token: null,
      botToken: MIRRORED_BOT,
    });
  });

  it("keeps an env-reference credential and writes no literal beside it", () => {
    const { openclawPath, clawboxPath } = write(
      { channels: { telegram: { enabled: true, token: ENV_REF } } },
      { telegram_bot_token: MIRRORED_BOT },
    );

    runInstallX64({ OPENCLAW_CONFIG: openclawPath, CLAWBOX_CONFIG: clawboxPath });

    expect(JSON.parse(fs.readFileSync(openclawPath, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      token: ENV_REF,
    });
  });

  it("keeps a secret reference held in botToken itself", () => {
    const { openclawPath, clawboxPath } = write(
      { channels: { telegram: { enabled: true, botToken: ENV_REF } } },
      { telegram_bot_token: MIRRORED_BOT },
    );

    runInstallX64({ OPENCLAW_CONFIG: openclawPath, CLAWBOX_CONFIG: clawboxPath });

    expect(JSON.parse(fs.readFileSync(openclawPath, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: ENV_REF,
    });
  });

  it("keeps a multi-account channel's bots and writes no literal at the root beside them", () => {
    const telegram = { enabled: true, accounts: { default: { botToken: NATIVE_BOT } } };
    const { openclawPath, clawboxPath } = write({ channels: { telegram } }, { telegram_bot_token: MIRRORED_BOT });

    runInstallX64({ OPENCLAW_CONFIG: openclawPath, CLAWBOX_CONFIG: clawboxPath });

    expect(JSON.parse(fs.readFileSync(openclawPath, "utf-8")).channels.telegram).toEqual(telegram);
  });
});

/**
 * install.sh's post-install smoke calls getMe — and, on a QA box, sends a
 * message — with the token it picks out of openclaw.json. It has to pick the
 * bot src/lib/openclaw-telegram-account.ts picks, or it reports a healthy bot
 * that is not the one this box chats as.
 */
describe("install.sh's Telegram smoke picks the bot the device reports", () => {
  function smokePicker(): string {
    const text = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
    const open = "TG_TOKEN=$(as_clawbox python3 -c '\n";
    const from = text.indexOf(open);
    if (from < 0) throw new Error("install.sh: no Telegram smoke token picker");
    const close = text.indexOf("\n' \"$OPENCLAW_CONFIG\"", from);
    if (close < 0) throw new Error("install.sh: Telegram smoke token picker never closes");
    return text.slice(from + open.length, close);
  }

  function pick(telegram: unknown): string {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: { telegram } }), "utf-8");
    return execFileSync("python3", ["-I", "-c", smokePicker(), cfg], { encoding: "utf-8" }).trim();
  }

  const WORK_BOT = "444444:WorkAccountBotSecret";

  it("keeps the top-level token, and follows the account rule when there is none", () => {
    expect(pick({ botToken: NATIVE_BOT, accounts: { work: { botToken: WORK_BOT } } })).toBe(NATIVE_BOT);
    expect(pick({ accounts: { work: { botToken: WORK_BOT }, default: { botToken: NATIVE_BOT } } })).toBe(NATIVE_BOT);
    expect(pick({ defaultAccount: "Work", accounts: { default: { botToken: NATIVE_BOT }, work: { botToken: WORK_BOT } } })).toBe(WORK_BOT);
    expect(pick({ accounts: { zulu: { botToken: NATIVE_BOT }, alpha: { botToken: "REPLACE_ME" }, mike: { botToken: WORK_BOT } } })).toBe(WORK_BOT);
    expect(pick({ accounts: { work: { enabled: true } } })).toBe("");
  });

  // The device answers "a bot it cannot name" for a reference; the smoke must
  // not verify — or message through — some other account's bot instead.
  it.each([
    ["a SecretRef in the top-level botToken", { botToken: ENV_REF, accounts: { work: { botToken: WORK_BOT } } }],
    ["a ${VAR} top-level botToken", { botToken: "${TELEGRAM_BOT_TOKEN}", accounts: { work: { botToken: WORK_BOT } } }],
    ["a top-level token reference", { token: ENV_REF, accounts: { work: { botToken: WORK_BOT } } }],
    ["a reference in the default account", { defaultAccount: "home", accounts: { home: { botToken: ENV_REF }, work: { botToken: WORK_BOT } } }],
  ])("skips the identity check for %s", (_name, telegram) => {
    expect(pick(telegram)).toBe("@reference");
  });
});
