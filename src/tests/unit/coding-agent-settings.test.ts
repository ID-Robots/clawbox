/**
 * The two Claude Code settings the Coding Agent app exposes — `--effort` and
 * whether sub-agents (the Task tool) are available at all — plus the live
 * sub-agent count.
 *
 * Both are real CLI settings. There is deliberately no "ultracode" knob:
 * `claude --help` has no such flag and `claude config` has no such key, so
 * the app would be offering something the harness cannot honour.
 *
 * What matters here: the effort the owner picked reaches the wrapper, the
 * sub-agent switch decides whether Task is in `--tools` at all (it is a
 * capability, not a hint), and a run records the settings it STARTED with
 * even if the owner changes them mid-flight.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  set: configSet,
}));

import {
  buildRunArgs,
  buildRunEnv,
  CLAUDE_TOOLS,
  CODING_AGENT_EFFORT_CONFIG_KEY,
  CODING_AGENT_SUBAGENTS_CONFIG_KEY,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  getEffort,
  getSubagentsEnabled,
  setEffort,
  setSubagentsEnabled,
  SUBAGENT_TOOL,
  toolsFor,
  CodingAgentError,
} from "@/lib/coding-agent";

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("effort", () => {
  it("offers exactly the levels the installed CLI accepts", () => {
    // `claude --effort bogus` names these five and ignores anything else.
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(DEFAULT_EFFORT).toBe("max");
  });

  it("defaults to max when unset, and when the stored value is junk", async () => {
    expect(await getEffort()).toBe("max");
    configGet.mockResolvedValue("ultracode");
    expect(await getEffort()).toBe("max");
    configGet.mockResolvedValue(7);
    expect(await getEffort()).toBe("max");
  });

  it("stores a level the CLI knows", async () => {
    expect(await setEffort("low")).toBe("low");
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_EFFORT_CONFIG_KEY, "low");
  });

  it("refuses a level the CLI would silently ignore", async () => {
    // Passing this through would leave the owner believing they had changed
    // something: the CLI warns on stderr and uses its default.
    await expect(setEffort("ultracode")).rejects.toBeInstanceOf(CodingAgentError);
    await expect(setEffort("MAX")).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("reaches the wrapper, and the owner's choice outranks an inherited one", () => {
    expect(buildRunEnv({ effort: "high" }).CLAUDE_DS_EFFORT).toBe("high");

    const prev = process.env.CLAUDE_DS_EFFORT;
    process.env.CLAUDE_DS_EFFORT = "low";
    try {
      // A stale shell variable must not beat the app's setting.
      expect(buildRunEnv({ effort: "max" }).CLAUDE_DS_EFFORT).toBe("max");
      expect(buildRunEnv().CLAUDE_DS_EFFORT).toBe("low");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_DS_EFFORT;
      else process.env.CLAUDE_DS_EFFORT = prev;
    }
  });
});

describe("sub-agents", () => {
  it("are off unless the owner turned them on", async () => {
    expect(await getSubagentsEnabled()).toBe(false);
    configGet.mockResolvedValue("yes"); // only a real true counts
    expect(await getSubagentsEnabled()).toBe(false);
    configGet.mockResolvedValue(true);
    expect(await getSubagentsEnabled()).toBe(true);
  });

  it("is a capability, not a hint: Task is absent from --tools when off", () => {
    expect(CLAUDE_TOOLS).not.toContain(SUBAGENT_TOOL);
    expect(toolsFor(false)).toBe(CLAUDE_TOOLS);
    expect(toolsFor(true).split(",")).toContain(SUBAGENT_TOOL);

    const off = buildRunArgs({ resumeSessionId: null, subagents: false });
    expect(off[off.indexOf("--tools") + 1]).toBe(CLAUDE_TOOLS);

    const on = buildRunArgs({ resumeSessionId: null, subagents: true });
    expect(on[on.indexOf("--tools") + 1].split(",")).toContain(SUBAGENT_TOOL);
  });

  it("defaults to off when the caller says nothing", () => {
    const args = buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--tools") + 1]).not.toContain(SUBAGENT_TOOL);
  });

  it("does not widen what a run may reach — only that it may fan out", () => {
    const on = buildRunArgs({ resumeSessionId: null, subagents: true });
    const off = buildRunArgs({ resumeSessionId: null, subagents: false });
    const rules = (a: string[]) => a.slice(a.indexOf("--allowedTools"));
    // Same Bash allow/deny lists and file deny rules either way.
    expect(rules(on)).toEqual(rules(off));
    expect(on).toContain("--permission-mode");
    expect(on[on.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("records the switch", async () => {
    await setSubagentsEnabled(true);
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_SUBAGENTS_CONFIG_KEY, true);
  });
});
