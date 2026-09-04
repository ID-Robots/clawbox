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
const { store, mkdir, writeFile } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }),
}));

vi.mock("fs/promises", () => ({ default: { mkdir, writeFile } }));

import {
  DEFAULT_START_URL,
  getBrowserAutoOpen,
  getBrowserSetupComplete,
  getBrowserStartUrl,
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
});
