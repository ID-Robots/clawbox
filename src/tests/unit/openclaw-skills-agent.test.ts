/**
 * openclawSkillsAgentArgs (src/lib/openclaw-config.ts).
 *
 * Measured on a box with four agents configured: `openclaw skills list --json`
 * and `openclaw skills install <ref>` both refuse with
 * `Multiple agents are configured, but the skills command has no explicit
 * owner. Pass --agent <id>.` — the install before it has even looked at the
 * ref. The web server's cwd is the ClawBox checkout, so the CLI's cwd
 * inference lands nowhere, and the whole App Store skill surface answered 503
 * for every id, installed or not.
 *
 * What is pinned here is the SHAPE of the fix as much as the fix: the flag is
 * named only in the case the CLI refuses to guess in, so a stock appliance —
 * one agent, the inference that has always worked — is passed the same argv it
 * was before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs/promises", () => ({
  default: { readFile: vi.fn(), stat: vi.fn() },
}));
vi.mock("fs", () => ({ default: { readFileSync: vi.fn(), existsSync: vi.fn() } }));

const mockFs = vi.mocked(fs);

let lib: typeof import("@/lib/openclaw-config");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  lib = await import("@/lib/openclaw-config");
});

function withConfig(config: unknown): void {
  mockFs.readFile.mockResolvedValue(JSON.stringify(config));
}

describe("openclawSkillsAgentArgs", () => {
  it("names nothing on a box with one agent — the CLI's own inference still works there", async () => {
    withConfig({ agents: { entries: { main: { workspace: "/w" } } } });
    expect(await lib.openclawSkillsAgentArgs()).toEqual([]);
  });

  it("names nothing when the config declares no agents at all", async () => {
    withConfig({ agents: { defaults: { workspace: "/w" } } });
    expect(await lib.openclawSkillsAgentArgs()).toEqual([]);
    withConfig({});
    expect(await lib.openclawSkillsAgentArgs()).toEqual([]);
  });

  it("names main once a second agent exists, which is the case the CLI refuses", async () => {
    withConfig({ agents: { entries: { main: {}, "support-bot": {} } } });
    expect(await lib.openclawSkillsAgentArgs()).toEqual(["--agent", "main"]);
  });

  it("falls back to the first entry when several agents exist and none is main", async () => {
    withConfig({ agents: { entries: { kimi: {}, claude: {} } } });
    expect(await lib.openclawSkillsAgentArgs()).toEqual(["--agent", "kimi"]);
  });

  it("names nothing when the config cannot be read — the old behaviour, not a guess", async () => {
    mockFs.readFile.mockRejectedValue(new Error("EACCES"));
    expect(await lib.openclawSkillsAgentArgs()).toEqual([]);
  });

  it("names nothing for an entries value that is not a bag of agents", async () => {
    for (const entries of [["main", "other"], "main", 3, null]) {
      withConfig({ agents: { entries } });
      expect(await lib.openclawSkillsAgentArgs()).toEqual([]);
    }
  });
});
