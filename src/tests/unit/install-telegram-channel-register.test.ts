import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
});
