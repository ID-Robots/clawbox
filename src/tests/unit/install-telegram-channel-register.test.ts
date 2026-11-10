import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
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

const MIRRORED_BOT = "111111:MirroredBotSecret_val";
const SAVED_MIRROR = JSON.stringify({ telegram_bot_token: MIRRORED_BOT });

/**
 * install.sh's registration script, given what the step gives it: two PATHS.
 * It reads the token out of ClawBox's config itself (`saved`, written as-is;
 * null leaves the file absent).
 */
function runInstallSh(cfg: string, saved: string | null = SAVED_MIRROR): { status: number | null; stderr: string } {
  const clawboxCfg = path.join(dir, "clawbox-config.json");
  if (saved !== null) fs.writeFileSync(clawboxCfg, saved, "utf-8");
  const res = spawnSync(process.execPath, ["-e", heredoc("install.sh", "NODE")], {
    env: { ...process.env, CLAWBOX_CFG: clawboxCfg, CFG: cfg },
    encoding: "utf-8",
  });
  return { status: res.status, stderr: res.stderr };
}

function runInstallX64(env: Record<string, string>): void {
  execFileSync(process.execPath, ["-e", heredoc("install-x64.sh", "NODE")], {
    env: { ...process.env, ...env },
  });
}

const NATIVE_BOT = "333333:NativeBotSecretValue";
/** OpenClaw's other credential shape: a reference to an environment variable. */
const ENV_REF = { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" };

describe("install.sh registers the Telegram channel without clobbering the harness", () => {
  it("fills an empty channel block from ClawBox's mirror", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: {} }), "utf-8");

    expect(runInstallSh(cfg).status).toBe(0);

    expect(JSON.parse(fs.readFileSync(cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: MIRRORED_BOT,
    });
  });

  it("creates the file when ~/.openclaw has none yet", () => {
    const cfg = path.join(dir, "fresh", "openclaw.json");

    expect(runInstallSh(cfg).status).toBe(0);

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

    expect(runInstallSh(cfg).status).toBe(0);

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

    expect(runInstallSh(cfg).status).toBe(0);

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

    expect(runInstallSh(cfg).status).toBe(0);

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

    expect(runInstallSh(cfg).status).toBe(0);

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

    expect(runInstallSh(cfg).status).toBe(0);

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

    expect(runInstallSh(cfg).status).toBe(0);

    expect((fs.statSync(cfg).mode & 0o777).toString(8)).toBe("600");
  });

  it("creates a config file that was not there at 0600", () => {
    const cfg = path.join(dir, "fresh-mode", "openclaw.json");

    expect(runInstallSh(cfg).status).toBe(0);

    expect((fs.statSync(cfg).mode & 0o777).toString(8)).toBe("600");
  });

  // The step used to read ClawBox's config as root and skip on any failure;
  // the script reads it now, and keeps that tolerance: a broken mirror must not
  // abort the step mid-update (errexit), nor touch OpenClaw's file.
  it.each([
    ["absent", null],
    ["not JSON", `{"telegram_bot_token":"${MIRRORED_BOT}"`],
    ["JSON null", "null"],
    ["without a token", "{}"],
    ["holding an empty token", JSON.stringify({ telegram_bot_token: "" })],
    ["holding a token that is not a string", JSON.stringify({ telegram_bot_token: 12345 })],
  ])("registers nothing when ClawBox's config is %s", (_name, saved) => {
    const cfg = path.join(dir, "openclaw.json");
    const before = JSON.stringify({ channels: { telegram: { enabled: true, dmPolicy: "open" } } });
    fs.writeFileSync(cfg, before, "utf-8");
    const absent = path.join(dir, "absent", "openclaw.json");

    const run = runInstallSh(cfg, saved);
    const runAbsent = runInstallSh(absent, saved);

    expect(run.status).toBe(0);
    expect(fs.readFileSync(cfg, "utf-8")).toBe(before);
    expect(runAbsent.status).toBe(0);
    expect(fs.existsSync(absent)).toBe(false);
    expect(run.stderr).toMatch(/^ {2}Telegram registration skipped: .+\n$/);
  });

  // A parse error is named by its class, never by its message.
  it("prints no part of the token when ClawBox's config does not parse", () => {
    const run = runInstallSh(path.join(dir, "openclaw.json"), `{"telegram_bot_token":'${MIRRORED_BOT}'}`);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("  Telegram registration skipped: could not read ClawBox's config (SyntaxError)\n");
    expect(run.stderr).not.toContain(MIRRORED_BOT.split(":")[0]);
  });

  // root reads a 0000 file anyway, so this case only means something unprivileged.
  it.skipIf(process.getuid?.() === 0)("registers nothing when ClawBox's config is unreadable", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(path.join(dir, "clawbox-config.json"), SAVED_MIRROR, { mode: 0o000 });

    const run = runInstallSh(cfg, null);

    expect(run.status).toBe(0);
    expect(fs.existsSync(cfg)).toBe(false);
    expect(run.stderr).toBe("  Telegram registration skipped: could not read ClawBox's config (EACCES)\n");
  });

  it("still refuses to overwrite an OpenClaw config it cannot parse", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, "{ not json", "utf-8");

    expect(runInstallSh(cfg).status).not.toBe(0);

    expect(fs.readFileSync(cfg, "utf-8")).toBe("{ not json");
  });

  // OpenClaw reads its config as JSON5, so a hand edit with a single-quoted
  // token is valid to the core and still stops this step: by class and file.
  it("stops on an OpenClaw config it cannot parse without printing any of it", () => {
    const cfg = path.join(dir, "openclaw.json");
    const text = `{"channels":{"telegram":{"botToken":'${NATIVE_BOT}'}}}`;
    fs.writeFileSync(cfg, text, "utf-8");

    const run = runInstallSh(cfg);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`  ERROR: Telegram registration stopped: could not read ${cfg} (SyntaxError)\n`);
    expect(run.stderr).not.toContain(NATIVE_BOT.split(":")[0]);
    expect(fs.readFileSync(cfg, "utf-8")).toBe(text);
  });

  // Every update re-runs the step while the gateway is live. A rewrite that
  // changes nothing still replaces the inode, bumps the mtime and drops the
  // trailing newline OpenClaw writes.
  it("leaves a config that already holds the channel exactly as it is", () => {
    const cfg = path.join(dir, "openclaw.json");
    const text = `${JSON.stringify({ channels: { telegram: { enabled: true, botToken: MIRRORED_BOT } } }, null, 2)}\n`;
    fs.writeFileSync(cfg, text, { mode: 0o600 });
    fs.utimesSync(cfg, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const { ino, mtimeMs } = fs.statSync(cfg);
    // A crashed run's temp holds a whole config; the rewrite path always removed it.
    fs.writeFileSync(`${cfg}.tmp`, text, { mode: 0o664 });

    const run = runInstallSh(cfg);

    expect(run.status).toBe(0);
    expect(fs.readFileSync(cfg, "utf-8")).toBe(text);
    expect(fs.statSync(cfg)).toMatchObject({ ino, mtimeMs });
    expect(fs.existsSync(`${cfg}.tmp`)).toBe(false);
    expect(run.stderr).toBe("  Telegram channel already registered; openclaw.json unchanged\n");
  });

  // A channel cannot be added to an array or a string: the step says so and
  // writes nothing, instead of reporting a registration that did not happen.
  it.each([
    ["an array", "[]"],
    ["an array of channels", JSON.stringify({ channels: [] })],
    ["a string of channels", JSON.stringify({ channels: "x" })],
    ["a number", "5"],
    ["JSON null", "null"],
  ])("reports a skip, and writes nothing, for a config that is %s", (_name, text) => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, text, "utf-8");
    const { ino } = fs.statSync(cfg);

    const run = runInstallSh(cfg);

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("  Telegram registration skipped: openclaw.json holds no channels object\n");
    expect(fs.readFileSync(cfg, "utf-8")).toBe(text);
    expect(fs.statSync(cfg).ino).toBe(ino);
  });

  it("re-secures an unchanged config without rewriting it", () => {
    const cfg = path.join(dir, "openclaw.json");
    fs.writeFileSync(cfg, JSON.stringify({ channels: { telegram: { enabled: true, botToken: NATIVE_BOT } } }), {
      mode: 0o664,
    });
    fs.chmodSync(cfg, 0o664);
    const { ino } = fs.statSync(cfg);

    expect(runInstallSh(cfg).status).toBe(0);

    expect(fs.statSync(cfg).ino).toBe(ino);
    expect((fs.statSync(cfg).mode & 0o777).toString(8)).toBe("600");
  });
});

/**
 * The block as install.sh runs it: the shell around the script, with
 * `as_clawbox` (`sudo -u clawbox`) replaced by a recorder of its arguments.
 * sudo records its command line, so only paths may go there.
 */
describe("install.sh's Telegram registration keeps the bot token off sudo's command line", () => {
  const MARKER = "222222:ArgvMarkerNotARealToken";

  /** From the block's comment to the `fi` that closes it, after the script. */
  function registrationBlock(): string {
    const text = fs.readFileSync(path.join(REPO, "install.sh"), "utf-8");
    const from = text.indexOf("  # Register Telegram channel (if token exists)\n");
    if (from < 0) throw new Error("install.sh: no Telegram registration block");
    const script = text.indexOf("\nNODE\n", from);
    if (script < 0) throw new Error("install.sh: Telegram registration script never closes");
    const close = text.indexOf("\n  fi\n", script);
    if (close < 0) throw new Error("install.sh: Telegram registration block never closes");
    return text.slice(from, close + "\n  fi\n".length);
  }

  function runBlock(saved: string | null): { status: number | null; argv: string[]; cfg: string } {
    const clawboxConfig = path.join(dir, "data", "config.json");
    fs.mkdirSync(path.dirname(clawboxConfig), { recursive: true });
    if (saved !== null) fs.writeFileSync(clawboxConfig, saved, { mode: 0o600 });
    const argvLog = path.join(dir, "as_clawbox.argv");
    const script = [
      "set -euo pipefail",
      'as_clawbox() { printf "%s\\0" "$@" >> "$ARGV_LOG"; "$@"; }',
      // A function, as in install.sh: the block declares locals.
      "register() {",
      registrationBlock(),
      "}",
      "register",
    ].join("\n");
    const res = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLAWBOX_CONFIG: clawboxConfig,
        CLAWBOX_HOME: path.join(dir, "home"),
        ARGV_LOG: argvLog,
      },
      encoding: "utf-8",
    });
    const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8").split("\0").filter(Boolean) : [];
    return { status: res.status, argv, cfg: path.join(dir, "home", ".openclaw", "openclaw.json") };
  }

  it("hands the script paths only, and the token still lands in OpenClaw's config", () => {
    const run = runBlock(JSON.stringify({ telegram_bot_token: MARKER }));

    expect(run.status).toBe(0);
    expect(run.argv.length).toBeGreaterThan(0);
    expect(run.argv.filter((arg) => arg.includes(MARKER))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(run.cfg, "utf-8")).channels.telegram).toEqual({
      enabled: true,
      botToken: MARKER,
    });
  });

  it("rewrites nothing on a second run that changes nothing", () => {
    const saved = JSON.stringify({ telegram_bot_token: MARKER });
    expect(runBlock(saved).status).toBe(0);
    const cfg = path.join(dir, "home", ".openclaw", "openclaw.json");
    fs.utimesSync(cfg, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const bytes = fs.readFileSync(cfg, "utf-8");
    const { ino, mtimeMs } = fs.statSync(cfg);

    expect(runBlock(saved).status).toBe(0);

    expect(fs.readFileSync(cfg, "utf-8")).toBe(bytes);
    expect(fs.statSync(cfg)).toMatchObject({ ino, mtimeMs });
  });

  it.each([
    ["no token", "{}"],
    ["a corrupt file", "{ not json"],
  ])("finishes the step without a config when ClawBox's holds %s", (_name, saved) => {
    const run = runBlock(saved);

    expect(run.status).toBe(0);
    expect(fs.existsSync(run.cfg)).toBe(false);
  });

  it("aborts the step instead of overwriting an OpenClaw config it cannot parse", () => {
    const cfg = path.join(dir, "home", ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, "{ not json", "utf-8");

    expect(runBlock(JSON.stringify({ telegram_bot_token: MARKER })).status).not.toBe(0);

    expect(fs.readFileSync(cfg, "utf-8")).toBe("{ not json");
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
