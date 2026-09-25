import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { saveEnv } from "@/tests/helpers/env";
import { scriptSource } from "@/tests/helpers/gateway-pre-start";
import {
  forgetPluginInstallUnavailable,
  NO_INSTALLABLE_BUILD_PATTERN,
  PLUGIN_INSTALL_UNAVAILABLE_TTL_MS,
  pluginInstallUnavailablePath,
  readPluginInstallUnavailable,
  recordPluginInstallUnavailable,
  saysNoInstallableBuild,
} from "@/lib/plugin-install-unavailable";

// TASK-1206. OpenClaw 2026.9.4 and a ClawHub with no
// `@openclaw/deepseek-provider@2026.9.4`: every gateway start asked again and
// waited 35–60 s for the same "Version not found". This record is the answer
// kept — per core, bounded, and only when it IS an answer about the package.

let dir: string;
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  dir = mkdtempSync(path.join(tmpdir(), "plugin-install-unavailable-"));
  process.env.CLAWBOX_ROOT = dir;
});

afterEach(() => {
  restoreEnv();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_790_000_000_000;
const RECORD = {
  core: "2026.9.4",
  atMs: NOW,
  specs: ["clawhub:@openclaw/deepseek-provider@2026.9.4", "clawhub:@openclaw/deepseek-provider"],
  cause: "Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.",
};

describe("saysNoInstallableBuild — the registry's own no, and nothing else", () => {
  it.each([
    "Version not found on ClawHub: @openclaw/deepseek-provider@2026.9.4.",
    "Package not found on ClawHub.",
    "Package not found on npm: @openclaw/deepseek-provider@2026.9.4. See https://docs.openclaw.ai/tools/plugin for installable plugins.",
    "npm error code E404\nnpm error 404 No match found for version 2026.9.99",
    "npm error code ETARGET\nnpm error notarget No matching version found for @openclaw/x@9.9.9.",
    'Plugin "@openclaw/deepseek-provider" requires plugin API >=2026.9.5, but this OpenClaw runtime exposes 2026.9.4.',
    'Plugin "@openclaw/deepseek-provider" requires OpenClaw >=2026.10.1, but this host is 2026.9.4.',
  ])("counts %j", (text) => {
    expect(saysNoInstallableBuild(text)).toBe(true);
  });

  it.each([
    "npm error code ETIMEDOUT npm error network request to https://registry.npmjs.org failed",
    "Error: clawhub registry answered 503 Service Unavailable",
    "getaddrinfo EAI_AGAIN clawhub.ai",
    "offline",
    // Killed at its deadline: the verb never finished, whatever it had printed.
    "openclaw plugins install clawhub:@openclaw/deepseek-provider@2026.9.4 timed out after 180000ms",
  ])("does not count %j", (text) => {
    expect(saysNoInstallableBuild(text)).toBe(false);
  });
});

describe("the record", () => {
  it("lives beside the repair record", () => {
    expect(pluginInstallUnavailablePath()).toBe(path.join(dir, "data", "plugin-install-unavailable.json"));
  });

  it("is believed for the core it was written for, inside the bound", async () => {
    await recordPluginInstallUnavailable("deepseek", RECORD);
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.4", NOW + PLUGIN_INSTALL_UNAVAILABLE_TTL_MS - 1))
      .toEqual(RECORD);
  });

  it("counts for nothing on another core — an update asks again at once", async () => {
    await recordPluginInstallUnavailable("deepseek", RECORD);
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.5", NOW)).toBeNull();
  });

  it("expires, so a registry that catches up is picked up without a click", async () => {
    await recordPluginInstallUnavailable("deepseek", RECORD);
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.4", NOW + PLUGIN_INSTALL_UNAVAILABLE_TTL_MS)).toBeNull();
  });

  it("does not hold for ever when it was stamped by a clock far in the future", async () => {
    await recordPluginInstallUnavailable("deepseek", RECORD);
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.4", NOW - PLUGIN_INSTALL_UNAVAILABLE_TTL_MS)).toBeNull();
    // …while a few minutes of skew is still the same answer.
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.4", NOW - 5 * 60_000)).not.toBeNull();
  });

  it("keeps other plugins' records when one is written or forgotten", async () => {
    await recordPluginInstallUnavailable("codex", { ...RECORD, specs: ["@openclaw/codex@2026.9.4"] });
    await recordPluginInstallUnavailable("deepseek", RECORD);
    await forgetPluginInstallUnavailable("deepseek");
    const onDisk = JSON.parse(readFileSync(pluginInstallUnavailablePath(), "utf-8"));
    expect(Object.keys(onDisk)).toEqual(["codex"]);
  });

  it("reads a torn or foreign file as no record, and never throws", async () => {
    mkdirSync(path.join(dir, "data"), { recursive: true });
    writeFileSync(pluginInstallUnavailablePath(), '{"deepseek": {"core": "2026.9');
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.4", NOW)).toBeNull();
    writeFileSync(pluginInstallUnavailablePath(), JSON.stringify({ deepseek: { core: "2026.9.4", atMs: "yesterday" } }));
    expect(await readPluginInstallUnavailable("deepseek", "2026.9.4", NOW)).toBeNull();
  });

  it("forgets nothing on a box that never wrote one", async () => {
    await forgetPluginInstallUnavailable("deepseek");
    expect(existsSync(pluginInstallUnavailablePath())).toBe(false);
  });
});

describe("the boot script keeps the same rule", () => {
  // `scripts/gateway-pre-start.sh` writes and reads this file on the boot path;
  // the two sides disagreeing about what counts or for how long would put the
  // retry-every-start back on whichever side is looser.
  const src = scriptSource();

  it("with the same pattern", () => {
    const shell = /\nCLAWBOX_PLUGIN_UNAVAILABLE_PATTERN="([^"]+)"/.exec(src);
    expect(shell, "CLAWBOX_PLUGIN_UNAVAILABLE_PATTERN was not found").not.toBeNull();
    expect(shell![1]).toBe(NO_INSTALLABLE_BUILD_PATTERN);
  });

  it("with the same bound", () => {
    const ttl = /\nCLAWBOX_PLUGIN_UNAVAILABLE_TTL_S=(\d+)\n/.exec(src);
    expect(ttl, "CLAWBOX_PLUGIN_UNAVAILABLE_TTL_S was not found").not.toBeNull();
    expect(Number(ttl![1]) * 1000).toBe(PLUGIN_INSTALL_UNAVAILABLE_TTL_MS);
  });

  it("in the same file", () => {
    expect(src).toContain('CLAWBOX_PLUGIN_UNAVAILABLE_FILE="$CLAWBOX_ROOT/data/plugin-install-unavailable.json"');
  });
});
