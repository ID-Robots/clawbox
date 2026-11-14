import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const installer = fs.readFileSync(path.join(process.cwd(), "install.sh"), "utf8");
const start = installer.indexOf("step_update_smoke() {");
const smoke = installer.slice(start, installer.indexOf("\n}", start) + 2);
const editionHelper = installer.match(/^has_openclaw_harness\(\).*$/m)![0];
const hasCurl = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0;

/**
 * No live network or device state: only the actual smoke's decisions run. The
 * stub records every call's arguments (each closed by a NUL, the call by a
 * record separator) and, for a call that reads its config on stdin (`-K -`),
 * that config, read before anything else so its writer never meets a closed pipe.
 */
const RECORDING_CURL = String.raw`curl() {
  local a prev="" cfg="" k=0
  for a in "$@"; do
    if [ "$prev" = "-K" ] && [ "$a" = "-" ]; then k=1; fi
    prev=$a
  done
  if [ "$k" = 1 ]; then cfg=$(tee -a "$STDIN_LOG"); fi
  printf '%s\0' "$@" >> "$ARGV_LOG"
  printf '\036\0' >> "$ARGV_LOG"
  case "$* $cfg" in
    */getMe*) printf '{"ok":true}' ;;
    */sendMessage*) printf '{"ok":true,"result":{"message_id":7}}' ;;
    *) printf '%s' "$FIXTURE_HTTP" ;;
  esac
}`;

/**
 * The real curl for the Telegram calls, refused before any socket (`--proto
 * =file` does not allow https): it records the URL it would have fetched and
 * its exit code.
 */
const PARITY_CURL = String.raw`curl() {
  case " $* " in
    *" -K - "*|*api.telegram.org*) ;;
    *) printf '%s' "$FIXTURE_HTTP"; return 0 ;;
  esac
  command curl -q --proto =file -o /dev/null -w '%{url_effective}|%{exitcode}\n' "$@" >> "$PARITY" 2>/dev/null || true
  printf '{"ok":true}'
}`;

interface SmokeOptions {
  /** `channels.telegram.botToken`, the root credential the picker returns raw. */
  botToken?: string;
  chatId?: string;
  parity?: boolean;
}

function runSmoke(edition: string, healthy: boolean, opts: SmokeOptions = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-smoke-edition-"));
  const argvLog = path.join(home, "argv.log");
  const stdinLog = path.join(home, "stdin.log");
  const parityLog = path.join(home, "parity.log");
  try {
    if (healthy) {
      fs.mkdirSync(path.join(home, ".openclaw"));
      fs.writeFileSync(path.join(home, ".openclaw/openclaw.json"), JSON.stringify({
        gateway: { auth: { token: "fixture-token-not-a-real-secret-1234567890" } },
        ...(opts.botToken !== undefined ? { channels: { telegram: { botToken: opts.botToken } } } : {}),
      }));
    }
    const output = execFileSync("bash", ["-c", [
      "set -euo pipefail",
      editionHelper,
      opts.parity ? PARITY_CURL : RECORDING_CURL,
      'as_clawbox() { echo CONFIG_PROBED >&2; "$@"; }',
      smoke,
      'if step_update_smoke; then echo RESULT=0; else echo RESULT=$?; fi',
    ].join("\n")], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CLAWBOX_EDITION: edition, CLAWBOX_HOME: home, HOME: home,
        FIXTURE_HTTP: healthy ? "200" : "000", CLAWBOX_SMOKE_TELEGRAM_CHAT_ID: opts.chatId ?? "",
        ARGV_LOG: argvLog, STDIN_LOG: stdinLog, PARITY: parityLog },
    });
    const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
    const calls: string[][] = [];
    let call: string[] = [];
    for (const arg of read(argvLog).split("\0").slice(0, -1)) {
      if (arg === "\x1e") {
        calls.push(call);
        call = [];
      } else {
        call.push(arg);
      }
    }
    return { output, calls, stdin: read(stdinLog), parity: read(parityLog) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** The calls to Telegram: every call but the gateway's loopback probe. */
const telegramCalls = (calls: string[][]): string[][] => calls.filter((c) => !c.some((a) => a.includes("127.0.0.1")));

describe("post-update smoke checks the installed harness", () => {
  it("does not report a broken OpenClaw gateway on a Hermes-only box", () => {
    const { output } = runSmoke("hermes", false);
    expect(output).toContain("RESULT=0");
    expect(output).toContain("[skip]");
    expect(output).not.toContain("[WARN]");
  });

  it.each(["openclaw", "dual"])("still reports a broken gateway on %s", edition => {
    const { output } = runSmoke(edition, false);
    expect(output).toContain("RESULT=1");
    expect(output).toContain("gateway not reachable");
    expect(output).toContain("gateway auth token is weak/missing");
  });

  it.each(["openclaw", "dual"])("accepts a healthy %s box with no Telegram bot", edition => {
    const { output } = runSmoke(edition, true);
    expect(output).toContain("RESULT=0");
    expect(output).toContain("gateway reachable");
    expect(output).not.toContain("[WARN]");
  });
});

/**
 * Every local account can read a running process's arguments, so the bot
 * token reaches curl on its stdin, as a line of curl's own config format, and
 * never as an argument.
 */
describe("post-update smoke keeps the bot token off curl's arguments", () => {
  const BOT = "123456:FIXTURE-not-a-real-bot";
  const API = "https://api.telegram.org/bot";

  it("checks the bot's identity with the token on curl's stdin", () => {
    const { output, calls, stdin } = runSmoke("openclaw", true, { botToken: BOT });
    expect(calls.flat().filter((a) => a.includes(BOT))).toEqual([]);
    expect(telegramCalls(calls)).toEqual([["-s", "-m", "8", "-K", "-"]]);
    expect(stdin).toBe(`url = "${API}${BOT}/getMe"\n`);
    expect(output).toContain("[ok] Telegram bot identity verified (getMe)");
    expect(output).toContain("RESULT=0");
  });

  it("sends the QA delivery smoke with the token on curl's stdin", () => {
    const { output, calls, stdin } = runSmoke("openclaw", true, { botToken: BOT, chatId: "42" });
    expect(calls.flat().filter((a) => a.includes(BOT))).toEqual([]);
    expect(telegramCalls(calls)).toEqual([
      ["-s", "-m", "8", "-K", "-"],
      ["-s", "-m", "10", "-K", "-", "--data-urlencode", "chat_id=42", "--data-urlencode", "text=ClawBox post-update smoke"],
    ]);
    expect(stdin).toBe(`url = "${API}${BOT}/getMe"\nurl = "${API}${BOT}/sendMessage"\n`);
    expect(output).toContain("[ok] Telegram bot identity verified (getMe)");
    expect(output).toContain("[ok] Telegram delivery smoke sent (message_id=7)");
    expect(output).toContain("RESULT=0");
  });

  it.each([
    ['a quote and a backslash', '123456:a"b\\c', '123456:a', `url = "${API}123456:a\\"b\\\\c/getMe"\n`],
    ["a line break", "123456:ab\nx", "123456:ab", `url = "${API}123456:ab\\nx/getMe"\n`],
    ["a carriage return", "123456:ab\rx", "123456:ab", `url = "${API}123456:ab\\rx/getMe"\n`],
  ])("escapes a token holding %s onto one config line", (_name, token, fragment, line) => {
    const { calls, stdin } = runSmoke("openclaw", true, { botToken: token });
    expect(calls.flat().filter((a) => a.includes(fragment))).toEqual([]);
    expect(stdin).toBe(line);
  });

  // Real curl, no network: the config line names the very URL the argument
  // named before, byte for byte, and fails the same way where that URL is malformed.
  it.skipIf(!hasCurl).each([
    ["plain", "123456:plain"],
    ["a quote", '123456:a"b'],
    ["a backslash", "123456:a\\b"],
    ["a space", "123456:a b"],
    ["a line feed", "123456:a\nb"],
    ["a carriage return", "123456:a\rb"],
  ])("makes curl request the same URL for a %s token", (_name, token) => {
    const { parity } = runSmoke("openclaw", true, { botToken: token, parity: true });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "update-smoke-parity-"));
    try {
      const argvForm = execFileSync("bash", ["-c",
        "command curl -q --proto =file -o /dev/null -w '%{url_effective}|%{exitcode}\\n' " +
          '-s -m 8 "https://api.telegram.org/bot$TOK/getMe" 2>/dev/null || true',
      ], { encoding: "utf8", env: { ...process.env, HOME: home, TOK: token } });
      expect(argvForm).not.toBe("");
      expect(parity).toBe(argvForm);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
