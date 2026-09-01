import { beforeEach, describe, expect, it, vi } from "vitest";

// The DeepSeek provider plugin is installed PINNED to the running core. The
// day OpenClaw 2026.8.2 shipped, ClawHub's latest @openclaw/deepseek-provider
// declared `pluginApi >=2026.8.2`; the pinned 2026.8.1 runtime refused it and
// every fresh install parked at a gateway that would not report ready. These
// pin the ordering: the core's own build first, the unpinned spec only as the
// fallback, and no throw either way (the route's write path reports a missing
// plugin on its own).

const spawnOpenclawCli = vi.fn<(args: string[], opts?: unknown) => Promise<string>>();

vi.mock("@/lib/openclaw-config", () => ({
  spawnOpenclawCli: (args: string[], opts?: unknown) => spawnOpenclawCli(args, opts),
}));

import {
  DEEPSEEK_PROVIDER_PLUGIN_SPEC,
  deepseekPluginSpecs,
  installDeepseekProviderPlugin,
  installedOpenclawRelease,
} from "@/lib/openclaw-deepseek-plugin";

const installCalls = () =>
  spawnOpenclawCli.mock.calls.filter(([args]) => args[0] === "plugins").map(([args]) => args[2]);

beforeEach(() => {
  spawnOpenclawCli.mockReset();
});

describe("deepseekPluginSpecs", () => {
  it("tries the core's own build before the unpinned spec", () => {
    expect(deepseekPluginSpecs("2026.8.1")).toEqual([
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`,
      DEEPSEEK_PROVIDER_PLUGIN_SPEC,
    ]);
  });

  it("falls back to the unpinned spec alone when the core cannot be asked", () => {
    expect(deepseekPluginSpecs(null)).toEqual([DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });
});

describe("installedOpenclawRelease", () => {
  it("reads the release out of the binary's banner", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    await expect(installedOpenclawRelease()).resolves.toBe("2026.8.1");
    expect(spawnOpenclawCli).toHaveBeenCalledWith(["--version"], expect.objectContaining({ captureStdout: true }));
  });

  it("is null when the binary cannot be asked", async () => {
    spawnOpenclawCli.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(installedOpenclawRelease()).resolves.toBeNull();
  });
});

describe("installDeepseekProviderPlugin", () => {
  it("installs the pinned build and stops there", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result).toEqual({ installed: `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`, failures: [] });
    expect(installCalls()).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`]);
    expect(spawnOpenclawCli.mock.calls[1][0]).toEqual([
      "plugins",
      "install",
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.8.1`,
      "--accept-capabilities",
    ]);
  });

  it("falls back to the unpinned spec when no build carries the core's version", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.9.1 (abcdef0)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("Version 2026.9.1 not found"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
    expect(result.failures).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.1: Version 2026.9.1 not found`]);
    expect(installCalls()).toEqual([`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@2026.9.1`, DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });

  it("never throws: both failures are reported, installed is null", async () => {
    spawnOpenclawCli.mockResolvedValueOnce("OpenClaw 2026.8.1 (ea80657)\n");
    spawnOpenclawCli.mockRejectedValueOnce(new Error("offline"));
    spawnOpenclawCli.mockRejectedValueOnce(new Error("still offline"));
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBeNull();
    expect(result.failures).toHaveLength(2);
  });

  it("goes straight to the unpinned spec when the core cannot be asked", async () => {
    spawnOpenclawCli.mockRejectedValueOnce(new Error("ENOENT"));
    spawnOpenclawCli.mockResolvedValueOnce("");
    const result = await installDeepseekProviderPlugin();
    expect(result.installed).toBe(DEEPSEEK_PROVIDER_PLUGIN_SPEC);
    expect(installCalls()).toEqual([DEEPSEEK_PROVIDER_PLUGIN_SPEC]);
  });
});
