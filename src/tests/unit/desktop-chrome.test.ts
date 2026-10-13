import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildChromeArgv,
  chromeEnv,
  chromeUrl,
  DEFAULT_CHROME_URL,
  escapeSystemdArgv,
  desktopChromeStatus,
  findChrome,
  launchDesktopChrome,
  parseChromeArgs,
} from "@/lib/desktop-chrome";
import { onBoxScreen } from "@/lib/desktop-chrome-client";

/**
 * The desktop's Google Chrome icon (src/lib/desktop-chrome.ts): only while the
 * ClawBox Desktop session is up, only http(s) pages, and the owner's flags
 * kept intact in front of the page.
 */

let tmp: string;
const saved = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-chrome-"));
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeChrome(): string {
  const bin = path.join(tmp, "chrome");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

describe("chromeUrl", () => {
  it("opens Google when no page is named", () => {
    expect(chromeUrl(undefined)).toBe(DEFAULT_CHROME_URL);
    expect(chromeUrl("")).toBe(DEFAULT_CHROME_URL);
  });

  it("passes http(s) and refuses everything else", () => {
    expect(chromeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(chromeUrl("file:///etc/passwd")).toBeNull();
    expect(chromeUrl("javascript:alert(1)")).toBeNull();
    expect(chromeUrl("--remote-debugging-port=1")).toBeNull();
    expect(chromeUrl(42)).toBeNull();
  });
});

describe("parseChromeArgs / buildChromeArgv", () => {
  it("splits on whitespace and keeps an escaped space", () => {
    expect(parseChromeArgs("  --a  --profile-directory=Profile\\ 1 ")).toEqual(["--a", "--profile-directory=Profile 1"]);
    expect(parseChromeArgs(undefined)).toEqual([]);
  });

  it("puts the page last, in a new Wayland window", () => {
    const argv = buildChromeArgv("https://example.com/", { NODE_ENV: "test", CLAWBOX_DESKTOP_CHROME_ARGS: "--x" } as NodeJS.ProcessEnv);
    expect(argv).toEqual(["--x", "--ozone-platform=wayland", "--new-window", "https://example.com/"]);
  });
});

describe("chromeEnv", () => {
  it("points at the session's display and carries none of the server's secrets", () => {
    const env = chromeEnv({ runtimeDir: "/run/user/1000", display: "wayland-0" }, {
      HOME: "/var/empty",
      PATH: "/usr/bin",
      NODE_ENV: "test",
      SECRET_TOKEN: "s",
    } as NodeJS.ProcessEnv);
    expect(env.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(env).not.toHaveProperty("SECRET_TOKEN");
  });
});

describe("findChrome", () => {
  it("takes CLAWBOX_DESKTOP_CHROME when it is an executable, and nothing when it is not", () => {
    const bin = fakeChrome();
    expect(findChrome({ NODE_ENV: "test", CLAWBOX_DESKTOP_CHROME: bin } as NodeJS.ProcessEnv)).toBe(bin);
    expect(findChrome({ NODE_ENV: "test", CLAWBOX_DESKTOP_CHROME: path.join(tmp, "nope") } as NodeJS.ProcessEnv)).toBeNull();
    expect(findChrome({ NODE_ENV: "test", CLAWBOX_DESKTOP_CHROME: "chrome" } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("availability", () => {
  it("is off on a box with no kiosk (every Jetson), and the launch never starts anything", async () => {
    // The suite points kiosk.env at nowhere (vitest.config.ts).
    delete process.env.CLAWBOX_KIOSK_URL;
    process.env.CLAWBOX_DESKTOP_CHROME = fakeChrome();
    expect(desktopChromeStatus()).toEqual({ available: false });
    expect(await launchDesktopChrome("https://example.com/")).toEqual({ ok: false, available: false });
  });

  it("is off on a kiosk box while the ClawBox Desktop session is not up", () => {
    process.env.CLAWBOX_KIOSK_URL = "http://localhost/";
    process.env.CLAWBOX_MONITORS_RUNTIME_DIR = tmp;
    process.env.CLAWBOX_DESKTOP_CHROME = fakeChrome();
    expect(desktopChromeStatus()).toEqual({ available: false });
  });
});

describe("onBoxScreen", () => {
  it("is the box's own screen only when the page came from loopback", () => {
    expect(onBoxScreen("localhost")).toBe(true);
    expect(onBoxScreen("127.0.0.1")).toBe(true);
    expect(onBoxScreen("[::1]")).toBe(true);
    expect(onBoxScreen("192.0.2.20")).toBe(false);
    expect(onBoxScreen("clawbox.local")).toBe(false);
  });
});

describe("escapeSystemdArgv", () => {
  it("doubles every dollar so systemd hands Chrome the URL unexpanded", () => {
    expect(escapeSystemdArgv(["--new-window", "https://example.com/$HOME?a=${USER}&b=$$"]))
      .toEqual(["--new-window", "https://example.com/$$HOME?a=$${USER}&b=$$$$"]);
    expect(escapeSystemdArgv(["https://example.com/"])).toEqual(["https://example.com/"]);
  });
});
