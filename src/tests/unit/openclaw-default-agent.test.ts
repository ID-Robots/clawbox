import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FALLBACK_AGENT_ID,
  configuredAgentIds,
  normalizeAgentId,
  openclawDefaultAgentId,
  resolveDefaultAgentId,
} from "@/lib/openclaw-default-agent";

/**
 * Which agent Memory Shard asks the core about (TASK-2248). It was "main",
 * hard-coded, and a box whose agent is called something else said "memory
 * status unavailable" over memory that was working. The rule mirrors the
 * pinned core's own (OpenClaw 2026.10.9, `agents.defaults.systemAgent`).
 */

const entries = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {}]));

describe("the default agent a config names", () => {
  it.each([
    ["no config at all", undefined],
    ["a config that is not an object", []],
    ["a config with no agents", { memory: {} }],
    ["agents with no roster", { agents: { defaults: { workspace: "~/w" } } }],
    ["an empty roster", { agents: { entries: {} } }],
    ["a roster of the wrong type", { agents: { entries: [] } }],
  ])("is main for %s", (_label, config) => {
    expect(resolveDefaultAgentId(config)).toBe(FALLBACK_AGENT_ID);
  });

  it("is main on a stock box", () => {
    expect(resolveDefaultAgentId({ agents: { entries: entries("main") } })).toBe("main");
  });

  it("is the sole agent whatever it is called: a box whose agent is `default`", () => {
    expect(resolveDefaultAgentId({ agents: { entries: entries("default") } })).toBe("default");
  });

  it("is a custom id in the form the CLI matches `--agent` against", () => {
    expect(resolveDefaultAgentId({ agents: { entries: entries("Work Bot") } })).toBe("work-bot");
    expect(resolveDefaultAgentId({ agents: { entries: entries("Writer") } })).toBe("writer");
  });

  describe("with several agents", () => {
    // The customer's box: four agents, the main one `default`, none called main.
    const customer = entries("default", "research", "writer", "travel");

    it("is the system agent the config records", () => {
      expect(resolveDefaultAgentId({
        agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "travel" } }, entries: customer },
      })).toBe("travel");
    });

    it("is the one entry marked default", () => {
      expect(resolveDefaultAgentId({
        agents: { entries: { research: {}, default: { default: true }, writer: {} } },
      })).toBe("default");
    });

    it("prefers the system agent over a legacy marker, as the core does", () => {
      expect(resolveDefaultAgentId({
        agents: { defaults: { systemAgent: { agentId: "writer" } }, entries: { default: { default: true }, writer: {} } },
      })).toBe("writer");
    });

    it("ignores a legacy marker under explicit ownership", () => {
      expect(resolveDefaultAgentId({
        agents: { ownership: "explicit", entries: { research: {}, writer: { default: true } } },
      })).toBe("research");
    });

    it("ignores a system agent that is not configured, and two markers", () => {
      expect(resolveDefaultAgentId({
        agents: {
          defaults: { systemAgent: { agentId: "ghost" } },
          entries: { research: { default: true }, writer: { default: true }, main: {} },
        },
      })).toBe("main");
    });

    it("with none named, is main when it is one of them and the first entry otherwise", () => {
      expect(resolveDefaultAgentId({ agents: { entries: entries("travel", "main", "writer") } })).toBe("main");
      expect(resolveDefaultAgentId({ agents: { entries: customer } })).toBe("default");
      expect(resolveDefaultAgentId({ agents: { entries: entries("writer", "default") } })).toBe("writer");
    });

    it("reads a legacy agents.list roster the same way", () => {
      expect(resolveDefaultAgentId({
        agents: { list: [{ id: "research" }, { id: "Default", default: true }, null, "x"] },
      })).toBe("default");
      expect(resolveDefaultAgentId({ agents: { list: [{ id: "travel" }] } })).toBe("travel");
    });

    it("lists every configured id in roster order, unique and normalised", () => {
      expect(configuredAgentIds({ agents: { entries: customer } })).toEqual(["default", "research", "writer", "travel"]);
      expect(configuredAgentIds({ agents: { entries: { Writer: {}, writer: {}, bad: "x" } } })).toEqual(["writer"]);
      expect(configuredAgentIds({})).toEqual(["main"]);
      expect(configuredAgentIds({ agents: { entries: {} } })).toEqual([]);
    });
  });

  it("normalises ids the way OpenClaw does", () => {
    expect(normalizeAgentId("  Travel ")).toBe("travel");
    expect(normalizeAgentId("my agent!")).toBe("my-agent");
    expect(normalizeAgentId("--x--")).toBe("x");
    expect(normalizeAgentId("../main")).toBe("main");
    expect(normalizeAgentId("../etc")).toBe("etc");
    expect(normalizeAgentId("!!!")).toBe("main");
    expect(normalizeAgentId(42)).toBe("main");
  });
});

describe("the default agent of this box's openclaw.json", () => {
  let dir = "";
  let config = "";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-agent-"));
    config = path.join(dir, "openclaw.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (value: unknown) => fs.writeFile(config, typeof value === "string" ? value : JSON.stringify(value));

  it("is main when there is no config", async () => {
    expect(await openclawDefaultAgentId(config)).toBe("main");
  });

  it("is the configured agent, never the one a stale agents/main directory suggests", async () => {
    // The customer's box still has agents/main/ from before the rename.
    await fs.mkdir(path.join(dir, "agents", "main", "agent"), { recursive: true });
    await write({ agents: { entries: entries("default", "research", "writer", "travel") } });
    expect(await openclawDefaultAgentId(config)).toBe("default");
  });

  it("follows a rename at once and reads the file only when it changed", async () => {
    await write({ agents: { entries: entries("main") } });
    const read = vi.spyOn(fs, "readFile");
    expect(await openclawDefaultAgentId(config)).toBe("main");
    expect(await openclawDefaultAgentId(config)).toBe("main");
    expect(read).toHaveBeenCalledTimes(1);
    await write({ agents: { entries: { "default-agent": {} } } });
    expect(await openclawDefaultAgentId(config)).toBe("default-agent");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer over a file it cannot read for a moment, and is main once it is gone", async () => {
    await write({ agents: { entries: entries("default") } });
    expect(await openclawDefaultAgentId(config)).toBe("default");
    await write('{"agents": {"entries": {"def');
    expect(await openclawDefaultAgentId(config)).toBe("default");
    await write({ agents: { entries: entries("travel") } });
    expect(await openclawDefaultAgentId(config)).toBe("travel");
    vi.spyOn(fs, "stat").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    expect(await openclawDefaultAgentId(config)).toBe("travel");
    await fs.rm(config);
    expect(await openclawDefaultAgentId(config)).toBe("main");
  });
});
