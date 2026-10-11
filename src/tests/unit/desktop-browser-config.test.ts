/**
 * Which browser the Browser app means (src/lib/desktop-browser-config.ts):
 * profile directory, CDP port and executable, from the launch env file with
 * environment overrides — and the launch script reading the very same values.
 *
 * The defaults are pinned first because they are the contract with every box
 * that never configured anything: exactly the profile and port that used to be
 * hard-coded. The parity block then runs scripts/launch-browser.sh
 * --print-config over the same files the TypeScript resolver reads, because the
 * two are two implementations of one rule and a drift between them is the bug
 * this module exists to remove (the app watching one browser while systemd
 * starts another).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import {
  DEFAULT_CDP_PORT,
  browserEnvFile,
  cdpEndpoint,
  defaultProfileDir,
  parseBrowserEnv,
  readDesktopBrowserConfig,
  resolveDesktopBrowserConfig,
} from "@/lib/desktop-browser-config";

// Runs bash: vitest's 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000 });

const run = promisify(execFile);

/**
 * Only what the browser unit would give the launch script — never the suite's
 * own environment, which points CLAWBOX_BROWSER_ENV_FILE at nowhere.
 */
function scriptEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...extra };
}
const HOME = "/home/owner-test";

describe("defaults", () => {
  it("are exactly what was hard-coded before: ClawBox's own profile, port 18800, auto-detected Chromium", () => {
    const config = resolveDesktopBrowserConfig({}, {}, HOME);
    expect(DEFAULT_CDP_PORT).toBe(18800);
    expect(config).toEqual({
      profileDir: `${HOME}/.config/clawbox-browser`,
      cdpPort: 18800,
      executable: null,
      ownProfile: true,
      warnings: [],
    });
    expect(defaultProfileDir(HOME)).toBe(`${HOME}/.config/clawbox-browser`);
    expect(cdpEndpoint(config)).toBe("http://127.0.0.1:18800");
  });

  it("keeps the launch env file where the launch script has always read it", () => {
    expect(browserEnvFile({}, HOME)).toBe(`${HOME}/.cache/clawbox/browser.env`);
    expect(browserEnvFile({ CLAWBOX_BROWSER_ENV_FILE: "/tmp/x.env" }, HOME)).toBe("/tmp/x.env");
  });

  it("treats empty and blank values as not set", () => {
    const config = resolveDesktopBrowserConfig(
      { CLAWBOX_BROWSER_PROFILE_DIR: "  ", CLAWBOX_BROWSER_CDP_PORT: "" },
      { CLAWBOX_BROWSER_EXECUTABLE: "" },
      HOME,
    );
    expect(config.profileDir).toBe(`${HOME}/.config/clawbox-browser`);
    expect(config.cdpPort).toBe(18800);
    expect(config.executable).toBeNull();
    expect(config.warnings).toEqual([]);
  });
});

describe("parseBrowserEnv", () => {
  it("reads the shapes a shell `source` reads", () => {
    expect(parseBrowserEnv([
      "# Written by ClawBox",
      "CLAWBOX_BROWSER_START_URL='https://example.com/'",
      'export CLAWBOX_BROWSER_PROFILE_DIR="/home/owner-test/.config/my-chrome"',
      "CLAWBOX_BROWSER_CDP_PORT=9222 # the owner's Chrome",
      "CLAWBOX_BROWSER_EXECUTABLE='/opt/google/chrome/chrome' # theirs",
      "   ",
      "not an assignment",
    ].join("\n"))).toEqual({
      CLAWBOX_BROWSER_START_URL: "https://example.com/",
      CLAWBOX_BROWSER_PROFILE_DIR: "/home/owner-test/.config/my-chrome",
      CLAWBOX_BROWSER_CDP_PORT: "9222",
      CLAWBOX_BROWSER_EXECUTABLE: "/opt/google/chrome/chrome",
    });
  });

  it("lets the last assignment of a key win, as bash does", () => {
    expect(parseBrowserEnv("CLAWBOX_BROWSER_CDP_PORT=9222\nCLAWBOX_BROWSER_CDP_PORT=9333\n")).toEqual({
      CLAWBOX_BROWSER_CDP_PORT: "9333",
    });
  });

  it("handles CRLF line endings and escaped characters inside double quotes", () => {
    expect(parseBrowserEnv('A="x\\"y"\r\nB=z\r\n')).toEqual({ A: 'x"y', B: "z" });
  });
});

describe("resolveDesktopBrowserConfig", () => {
  it("takes the owner's profile, port and executable from the file", () => {
    const config = resolveDesktopBrowserConfig({
      CLAWBOX_BROWSER_PROFILE_DIR: "/home/owner-test/.config/my-chrome/",
      CLAWBOX_BROWSER_CDP_PORT: "9222",
      CLAWBOX_BROWSER_EXECUTABLE: "/opt/google/chrome/chrome",
    }, {}, HOME);
    expect(config).toMatchObject({
      // The trailing slash is the same directory, written as Chromium's argv will carry it.
      profileDir: "/home/owner-test/.config/my-chrome",
      cdpPort: 9222,
      executable: "/opt/google/chrome/chrome",
      ownProfile: false,
      warnings: [],
    });
  });

  it("lets the environment outrank the file, key by key", () => {
    const config = resolveDesktopBrowserConfig(
      { CLAWBOX_BROWSER_PROFILE_DIR: "/home/owner-test/a", CLAWBOX_BROWSER_CDP_PORT: "9222" },
      { CLAWBOX_BROWSER_CDP_PORT: "9333" },
      HOME,
    );
    expect(config.profileDir).toBe("/home/owner-test/a");
    expect(config.cdpPort).toBe(9333);
  });

  it("expands ~ and $HOME at the start of a path, the way the shell does", () => {
    for (const raw of ["~/.config/my-chrome", "$HOME/.config/my-chrome", "${HOME}/.config/my-chrome"]) {
      expect(resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_PROFILE_DIR: raw }, {}, HOME).profileDir)
        .toBe(`${HOME}/.config/my-chrome`);
    }
    expect(resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_EXECUTABLE: "~/bin/chrome" }, {}, HOME).executable)
      .toBe(`${HOME}/bin/chrome`);
  });

  it("names ClawBox's own profile as its own even when it is written out in full", () => {
    const config = resolveDesktopBrowserConfig(
      { CLAWBOX_BROWSER_PROFILE_DIR: "~/.config/clawbox-browser/", CLAWBOX_BROWSER_CDP_PORT: "9222" },
      {},
      HOME,
    );
    expect(config.ownProfile).toBe(true);
    expect(config.cdpPort).toBe(9222);
  });

  it.each([
    ["relative", "chrome-profile"],
    ["the root", "/"],
    ["with a space", "/home/owner-test/My Profile"],
    ["with a quote", "/home/owner-test/it's"],
    ["with a dot-dot segment", "/home/owner-test/../other"],
    ["with a dot segment", "/home/owner-test/./x"],
  ])("refuses a profile directory that is %s, for the default and a warning", (_label, raw) => {
    const config = resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_PROFILE_DIR: raw }, {}, HOME);
    expect(config.profileDir).toBe(`${HOME}/.config/clawbox-browser`);
    expect(config.ownProfile).toBe(true);
    expect(config.warnings).toHaveLength(1);
  });

  it.each(["80", "1023", "65536", "92a2", "-1", "9222.5", "123456"])("refuses port %s, for 18800 and a warning", (raw) => {
    const config = resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_CDP_PORT: raw }, {}, HOME);
    expect(config.cdpPort).toBe(18800);
    expect(config.warnings).toHaveLength(1);
  });

  it("accepts the edges of the port range and drops leading zeros", () => {
    expect(resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_CDP_PORT: "1024" }, {}, HOME).cdpPort).toBe(1024);
    expect(resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_CDP_PORT: "65535" }, {}, HOME).cdpPort).toBe(65535);
    expect(resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_CDP_PORT: "09222" }, {}, HOME).cdpPort).toBe(9222);
  });

  it("refuses a relative executable and goes back to finding Chromium itself", () => {
    const config = resolveDesktopBrowserConfig({ CLAWBOX_BROWSER_EXECUTABLE: "google-chrome" }, {}, HOME);
    expect(config.executable).toBeNull();
    expect(config.warnings).toHaveLength(1);
  });

  it("does not let an unusable environment value fall through to the file's", () => {
    // Set means set: the script cannot tell "unusable" from "absent" any
    // differently, and both sides must name the same port.
    const config = resolveDesktopBrowserConfig(
      { CLAWBOX_BROWSER_CDP_PORT: "9222" },
      { CLAWBOX_BROWSER_CDP_PORT: "nope" },
      HOME,
    );
    expect(config.cdpPort).toBe(18800);
  });
});

describe("readDesktopBrowserConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-browser-config-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the file the launch script reads, on every call", async () => {
    const file = path.join(dir, "browser.env");
    const env = { CLAWBOX_BROWSER_ENV_FILE: file };
    expect((await readDesktopBrowserConfig(env)).cdpPort).toBe(18800);

    fs.writeFileSync(file, "CLAWBOX_BROWSER_CDP_PORT=9222\nCLAWBOX_BROWSER_PROFILE_DIR=/srv/owner/chrome\n");
    const config = await readDesktopBrowserConfig(env);
    expect(config.cdpPort).toBe(9222);
    expect(config.profileDir).toBe("/srv/owner/chrome");
    expect(config.ownProfile).toBe(false);
  });

  it("falls back to every default when there is no file", async () => {
    const config = await readDesktopBrowserConfig({ CLAWBOX_BROWSER_ENV_FILE: path.join(dir, "missing.env") });
    expect(config.cdpPort).toBe(18800);
    expect(config.ownProfile).toBe(true);
    expect(config.executable).toBeNull();
  });
});

/**
 * The same files through scripts/launch-browser.sh. `--print-config` exits
 * before anything is started, so this needs no display and no Chromium.
 */
describe.runIf(process.platform === "linux")("scripts/launch-browser.sh agrees with the resolver", () => {
  const script = path.join(process.cwd(), "scripts", "launch-browser.sh");
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "launch-browser-home-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function scriptConfig(fileBody: string | null, env: Record<string, string> = {}) {
    const file = path.join(home, ".cache", "clawbox", "browser.env");
    if (fileBody !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fileBody);
    }
    const { stdout } = await run("bash", [script, "--print-config"], {
      env: scriptEnv(home, env),
    });
    const out = Object.fromEntries(stdout.trim().split("\n").map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at), l.slice(at + 1)];
    }));
    const resolved = resolveDesktopBrowserConfig(parseBrowserEnv(fileBody ?? ""), env, home);
    return { out, resolved };
  }

  const cases: { name: string; file: string | null; env?: Record<string, string> }[] = [
    { name: "no file at all", file: null },
    { name: "a start page only (every box before this change)", file: "CLAWBOX_BROWSER_START_URL='about:blank'\n" },
    {
      name: "the owner's own browser",
      file: "CLAWBOX_BROWSER_PROFILE_DIR='~/.config/my-chrome/'\nCLAWBOX_BROWSER_CDP_PORT=9222\nCLAWBOX_BROWSER_EXECUTABLE=/opt/google/chrome/chrome\n",
    },
    { name: "an environment override", file: "CLAWBOX_BROWSER_CDP_PORT=9222\n", env: { CLAWBOX_BROWSER_CDP_PORT: "9333" } },
    { name: "a blank environment value", file: "CLAWBOX_BROWSER_CDP_PORT=9222\n", env: { CLAWBOX_BROWSER_CDP_PORT: "  " } },
    { name: "an unusable environment value", file: "CLAWBOX_BROWSER_CDP_PORT=9222\n", env: { CLAWBOX_BROWSER_CDP_PORT: "nope" } },
    { name: "$HOME in double quotes", file: 'CLAWBOX_BROWSER_PROFILE_DIR="$HOME/.config/x"\n' },
    { name: "$HOME in single quotes", file: "CLAWBOX_BROWSER_PROFILE_DIR='${HOME}/.config/x'\n" },
    { name: "a spaced profile", file: "CLAWBOX_BROWSER_PROFILE_DIR='/srv/My Profile'\n" },
    { name: "a dot-dot profile", file: "CLAWBOX_BROWSER_PROFILE_DIR=/srv/a/../b\n" },
    { name: "a privileged port", file: "CLAWBOX_BROWSER_CDP_PORT=80\n" },
    { name: "a zero-padded port", file: "CLAWBOX_BROWSER_CDP_PORT=09222\n" },
    { name: "a relative executable", file: "CLAWBOX_BROWSER_EXECUTABLE=google-chrome\n" },
    { name: "an inline comment", file: "CLAWBOX_BROWSER_CDP_PORT=9444 # mine\n" },
  ];

  it.each(cases)("$name", async ({ file, env }) => {
    const { out, resolved } = await scriptConfig(file, env);
    expect(out).toEqual({
      PROFILE: resolved.profileDir,
      CDP_PORT: String(resolved.cdpPort),
      EXECUTABLE: resolved.executable ?? "",
    });
  });
});

/**
 * The launch script's own last line of defence: on the OWNER's profile, a
 * browser already holding it (Chromium's SingletonLock names a live pid) is
 * never joined by a second one — that one would only hand the start page to
 * the running browser as a stray tab and exit.
 */
describe.runIf(process.platform === "linux")("scripts/launch-browser.sh on an owner profile that is already open", () => {
  const script = path.join(process.cwd(), "scripts", "launch-browser.sh");
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "launch-browser-lock-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses to start, and never runs the browser", async () => {
    const profile = path.join(home, "owner-profile");
    fs.mkdirSync(profile, { recursive: true });
    // Held by a live process: this test's own.
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(profile, "SingletonLock"));
    const marker = path.join(home, "browser-ran");
    const browser = path.join(home, "chrome");
    fs.writeFileSync(browser, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });

    const result = await run("bash", [script], {
      env: scriptEnv(home, {
        CLAWBOX_BROWSER_PROFILE_DIR: profile,
        // A port nothing answers on, so the "already running" check passes by.
        CLAWBOX_BROWSER_CDP_PORT: "39297",
        CLAWBOX_BROWSER_EXECUTABLE: browser,
      }),
    }).then(() => ({ code: 0, stderr: "" }), (err: { code?: number; stderr?: string }) => ({ code: err.code ?? -1, stderr: err.stderr ?? "" }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`is already open (pid ${process.pid})`);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
