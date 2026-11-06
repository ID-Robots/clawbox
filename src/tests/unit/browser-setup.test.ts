/**
 * The Browser app's owner settings (src/lib/browser-setup.ts).
 *
 * The two rules worth pinning: an explicit setup flag beats the "this box
 * already works" fallback in BOTH directions (the wizard writes `false` at its
 * first step and would otherwise be declared finished by the very state it is
 * creating), and a start page is normalized before it is stored, because the
 * stored value ends up inside a single-quoted shell assignment that
 * scripts/launch-browser.sh sources.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted, because the module under test is imported statically below: the
// mock factories run during that import, before a plain `const` at this level
// has been initialised.
const { store, mkdir, writeFile, readFile } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async (): Promise<string> => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }),
}));

vi.mock("fs/promises", () => ({ default: { mkdir, writeFile, readFile } }));

import {
  DEFAULT_START_URL,
  getBrowserAutoOpen,
  getBrowserSetupComplete,
  getBrowserStartUrl,
  launchEnvBody,
  normalizeStartUrl,
  readBrowserSetupFlag,
  setBrowserAutoOpen,
  setBrowserSetupComplete,
  setBrowserStartUrl,
  writeBrowserLaunchEnv,
} from "@/lib/browser-setup";

describe("browser setup state", () => {
  beforeEach(() => {
    store.clear();
    writeFile.mockClear();
    writeFile.mockResolvedValue(undefined);
    readFile.mockReset();
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  });

  it("treats a box that already has a working browser as set up", async () => {
    expect(await getBrowserSetupComplete(true)).toBe(true);
    expect(await getBrowserSetupComplete(false)).toBe(false);
    expect(await readBrowserSetupFlag()).toBeNull();
  });

  it("lets an explicit flag override the fallback in both directions", async () => {
    await setBrowserSetupComplete(false);
    expect(await getBrowserSetupComplete(true)).toBe(false);
    await setBrowserSetupComplete(true);
    expect(await getBrowserSetupComplete(false)).toBe(true);
  });

  it("opens the browser with the app unless the owner said otherwise", async () => {
    expect(await getBrowserAutoOpen()).toBe(true);
    await setBrowserAutoOpen(false);
    expect(await getBrowserAutoOpen()).toBe(false);
  });

  it("accepts only http(s) start pages", () => {
    expect(normalizeStartUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(normalizeStartUrl("http://example.com/")).toBe("http://example.com/");
    // The one non-web page: the default, accepted in any case and with padding.
    expect(normalizeStartUrl("about:blank")).toBe("about:blank");
    expect(normalizeStartUrl("  About:Blank ")).toBe("about:blank");
    expect(normalizeStartUrl("about:config")).toBeNull();
    expect(DEFAULT_START_URL).toBe("about:blank");
    expect(normalizeStartUrl("file:///etc/shadow")).toBeNull();
    expect(normalizeStartUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeStartUrl("not a url")).toBeNull();
    expect(normalizeStartUrl("")).toBeNull();
    expect(normalizeStartUrl(42)).toBeNull();
  });

  it("percent-encodes the one character a single-quoted shell value cannot hold", () => {
    expect(normalizeStartUrl("https://example.com/it's")).toBe("https://example.com/it%27s");
  });

  it("falls back to the launch script's own default", async () => {
    expect(await getBrowserStartUrl()).toBe(DEFAULT_START_URL);
    await setBrowserStartUrl("https://example.com/start");
    expect(await getBrowserStartUrl()).toBe("https://example.com/start");
    await setBrowserStartUrl(null);
    expect(await getBrowserStartUrl()).toBe(DEFAULT_START_URL);
  });

  it("writes the start page where the launch script reads it", async () => {
    await writeBrowserLaunchEnv("https://example.com/start");
    expect(mkdir).toHaveBeenCalled();
    const [file, body] = writeFile.mock.calls[0] as unknown as [string, string];
    expect(file).toMatch(/\.cache\/clawbox\/browser\.env$/);
    expect(body).toContain("CLAWBOX_BROWSER_START_URL='https://example.com/start'");
  });

  it("does not let a failed env write stop a launch", async () => {
    writeFile.mockRejectedValueOnce(new Error("read-only filesystem"));
    await expect(writeBrowserLaunchEnv("https://example.com/")).resolves.toBeUndefined();
  });

  /**
   * TASK-1480: the same file names the owner's own browser — profile, CDP
   * port, executable (src/lib/desktop-browser-config.ts). Writing the start
   * page used to replace the whole file, which would have quietly pointed the
   * app back at ClawBox's own empty browser the next time anyone pressed Open.
   */
  it("keeps the owner's own browser settings, and their comments, when it writes the start page", async () => {
    readFile.mockResolvedValue([
      "# Written by ClawBox — Settings → Browser. Read by scripts/launch-browser.sh.",
      "CLAWBOX_BROWSER_START_URL='https://old.example/'",
      "# my Chrome",
      "CLAWBOX_BROWSER_PROFILE_DIR=~/.config/google-chrome-debug",
      "CLAWBOX_BROWSER_CDP_PORT=9222",
      "",
    ].join("\n"));

    await writeBrowserLaunchEnv("https://example.com/start");

    const [, body] = writeFile.mock.calls[0] as unknown as [string, string];
    expect(body).toContain("# my Chrome\nCLAWBOX_BROWSER_PROFILE_DIR=~/.config/google-chrome-debug\nCLAWBOX_BROWSER_CDP_PORT=9222\n");
    expect(body).toContain("CLAWBOX_BROWSER_START_URL='https://example.com/start'");
    expect(body).not.toContain("old.example");
    // ClawBox's header once, not once per write.
    expect(body.match(/# Written by ClawBox/g)).toHaveLength(1);
  });

  it("documents the owner's keys in a file it starts from nothing", () => {
    const body = launchEnvBody("", "about:blank");
    expect(body).toContain("CLAWBOX_BROWSER_PROFILE_DIR=");
    expect(body).toContain("CLAWBOX_BROWSER_CDP_PORT=");
    expect(body).toContain("CLAWBOX_BROWSER_EXECUTABLE=");
    // …as comments: nothing is configured until the owner says so.
    expect(body.split("\n").filter((l) => /^CLAWBOX_BROWSER_/.test(l))).toEqual(["CLAWBOX_BROWSER_START_URL='about:blank'"]);
    // Rewriting its own output changes nothing.
    expect(launchEnvBody(body, "about:blank")).toBe(body);
  });

  it("leaves a file it cannot read alone rather than rewrite the owner's settings away", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(writeBrowserLaunchEnv("https://example.com/")).resolves.toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
