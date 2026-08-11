/**
 * The ClawBox browser must be identifiable without pattern-matching command
 * lines, because one of the command lines on this device is the customer's own
 * chat message.
 *
 * The bug: `close-browser` ran
 *   pkill -f "chrom.*--user-data-dir.*clawbox-browser"
 * and every chat turn runs as
 *   hermes chat -q "<the user's message>" -Q
 * so a message containing that pattern selected the process answering it. The
 * harness catches the resulting SIGTERM and exits 130, which the chat surfaced
 * as a bare "hermes exited with code 130".
 *
 * The first test below is the regression: the exact hostile argv must not
 * match. The rest keep the matcher honest about real browsers.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import {
  isBrowserExecutable,
  isClawboxBrowserArgv,
  findClawboxBrowserPids,
} from "@/lib/process-match";

const PROFILE_DIR = "/home/clawbox/.config/clawbox-browser";
const CDP_PORT = 18800;
const MATCH = { profileDir: PROFILE_DIR, cdpPort: CDP_PORT };

/** The literal text that used to be fatal to put in a chat message. */
const HOSTILE_MESSAGE =
  "why does chrom.*--user-data-dir.*clawbox-browser kill my chat? "
  + "I ran chromium --user-data-dir=/home/clawbox/.config/clawbox-browser and it died";

describe("isClawboxBrowserArgv", () => {
  it("does NOT match a Hermes chat turn carrying the pattern in its message", () => {
    const argv = [
      "/home/clawbox/.hermes/hermes-agent/venv/bin/python",
      "/home/clawbox/.hermes/hermes-agent/hermes",
      "chat",
      "-q",
      HOSTILE_MESSAGE,
      "-Q",
      "-m",
      "gemma4-e2b-it-q4_0",
      "--provider",
      "clawlocal",
    ];
    expect(isClawboxBrowserArgv(argv, MATCH)).toBe(false);
  });

  it("does NOT match the web server itself, whatever is on its command line", () => {
    const argv = ["/usr/bin/node", "/home/clawbox/clawbox/production-server.js"];
    expect(isClawboxBrowserArgv(argv, MATCH)).toBe(false);
  });

  it("does NOT match a shell that merely mentions the browser", () => {
    const argv = ["/bin/bash", "-c", `echo chromium --user-data-dir=${PROFILE_DIR}`];
    expect(isClawboxBrowserArgv(argv, MATCH)).toBe(false);
  });

  it("matches the real Playwright Chromium with our profile dir", () => {
    const argv = [
      "/home/clawbox/.cache/ms-playwright/chromium-1181/chrome-linux/chrome",
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
    ];
    expect(isClawboxBrowserArgv(argv, MATCH)).toBe(true);
  });

  it("matches a distro chromium and the separated --user-data-dir form", () => {
    expect(isClawboxBrowserArgv(
      ["/usr/bin/chromium-browser", "--user-data-dir", PROFILE_DIR],
      MATCH,
    )).toBe(true);
  });

  it("matches renderer children, which carry the same binary and profile", () => {
    const argv = [
      "/usr/bin/chromium",
      "--type=renderer",
      `--user-data-dir=${PROFILE_DIR}`,
    ];
    expect(isClawboxBrowserArgv(argv, MATCH)).toBe(true);
  });

  it("does NOT match a browser running someone else's profile", () => {
    const argv = ["/usr/bin/chromium", "--user-data-dir=/home/clawbox/.config/google-chrome"];
    expect(isClawboxBrowserArgv(argv, MATCH)).toBe(false);
  });

  it("requires the exact switch name, not a prefix of it", () => {
    // `startsWith("--user-data-dir")` would also accept this, and the callers
    // terminate whatever matches — so an unrelated Chromium must not qualify.
    expect(isClawboxBrowserArgv(
      ["/usr/bin/chromium", `--user-data-directory=${PROFILE_DIR}`],
      MATCH,
    )).toBe(false);
  });

  it("treats a trailing slash on the profile path as the same directory", () => {
    expect(isClawboxBrowserArgv(
      ["/usr/bin/chromium", `--user-data-dir=${PROFILE_DIR}/`],
      MATCH,
    )).toBe(true);
  });

  it("matches on the CDP port even without the profile dir", () => {
    expect(isClawboxBrowserArgv(
      ["/usr/bin/chromium", `--remote-debugging-port=${CDP_PORT}`],
      MATCH,
    )).toBe(true);
  });

  it("does NOT match a browser on a different CDP port", () => {
    expect(isClawboxBrowserArgv(
      ["/usr/bin/chromium", "--remote-debugging-port=9222"],
      MATCH,
    )).toBe(false);
  });

  it("ignores an empty argv", () => {
    expect(isClawboxBrowserArgv([], MATCH)).toBe(false);
  });
});

describe("isBrowserExecutable", () => {
  it("accepts browser binaries by basename, on any path", () => {
    for (const exe of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/home/clawbox/.cache/ms-playwright/chromium-1181/chrome-linux64/chrome",
      "chrome",
    ]) {
      expect(isBrowserExecutable(exe), exe).toBe(true);
    }
  });

  it("tolerates the ' (deleted)' suffix /proc adds after an upgrade", () => {
    expect(isBrowserExecutable("/usr/bin/chromium (deleted)")).toBe(true);
  });

  it("rejects everything else, including names that contain a browser name", () => {
    for (const exe of [
      "",
      "/usr/bin/node",
      "/usr/bin/python3",
      "/home/clawbox/.hermes/hermes-agent/hermes",
      "/usr/bin/chrome-sandbox",
      "/usr/bin/not-chrome",
    ]) {
      expect(isBrowserExecutable(exe), exe).toBe(false);
    }
  });
});

// Linux-only: reads /proc. The product runs on Jetson, but the suite should be
// runnable on a developer's machine too.
describe.runIf(process.platform === "linux")("findClawboxBrowserPids", () => {
  it("does not return a live process whose ARGUMENTS carry the pattern", async () => {
    // Stand-in for the chat turn: a real process, alive, with the hostile text
    // in argv[1..] — exactly the shape `pkill -f` used to select.
    const decoy = spawn("sleep", ["30", HOSTILE_MESSAGE, `--user-data-dir=${PROFILE_DIR}`], {
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(decoy.pid).toBeGreaterThan(0);
      const pids = await findClawboxBrowserPids(MATCH);
      expect(pids).not.toContain(decoy.pid);
    } finally {
      decoy.kill("SIGKILL");
    }
  });

  it("never returns its own pid", async () => {
    const pids = await findClawboxBrowserPids(MATCH);
    expect(pids).not.toContain(process.pid);
  });
});
