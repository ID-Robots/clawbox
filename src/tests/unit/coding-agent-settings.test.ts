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

describe("steps and tokens", () => {
  it("defaults to the shipped step count and accepts a new one", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(await lib.getMaxTurns()).toBe(lib.DEFAULT_MAX_TURNS);
    expect(await lib.setMaxTurns(500)).toBe(500);
    expect(configSet).toHaveBeenCalledWith(lib.CODING_AGENT_TURNS_CONFIG_KEY, 500);
  });

  it("refuses a step count outside the range the CLI can use", async () => {
    const lib = await import("@/lib/coding-agent");
    await expect(lib.setMaxTurns(1)).rejects.toBeInstanceOf(lib.CodingAgentError);
    await expect(lib.setMaxTurns(999_999)).rejects.toBeInstanceOf(lib.CodingAgentError);
    await expect(lib.setMaxTurns("many" as unknown as number)).rejects.toBeInstanceOf(lib.CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("clamps a stored value rather than handing the CLI something it rejects", async () => {
    const lib = await import("@/lib/coding-agent");
    configGet.mockResolvedValue(50_000);
    expect(await lib.getMaxTurns()).toBe(lib.MAX_MAX_TURNS);
    configGet.mockResolvedValue(1);
    expect(await lib.getMaxTurns()).toBe(lib.MIN_MAX_TURNS);
  });

  it("has no token ceiling unless the owner sets one", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(await lib.getTokenLimit()).toBeNull();
    expect(await lib.setTokenLimit(250_000)).toBe(250_000);
    expect(await lib.setTokenLimit(null)).toBeNull();
    expect(configSet).toHaveBeenLastCalledWith(lib.CODING_AGENT_TOKENS_CONFIG_KEY, undefined);
  });

  it("refuses a ceiling so low every run would die on its first turn", async () => {
    const lib = await import("@/lib/coding-agent");
    await expect(lib.setTokenLimit(100)).rejects.toBeInstanceOf(lib.CodingAgentError);
  });

  it("puts the owner's step count on the command line, and no price flag", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null, maxTurns: 400 });
    expect(args[args.indexOf("--max-turns") + 1]).toBe("400");
    expect(args).not.toContain("--max-budget-usd");
  });
});

describe("what a run is told about the shell", () => {
  it("says one command per call, because the parts being safe is not enough", async () => {
    // Four of six denials in a real run were compound commands whose every
    // part was allow-listed: `git rev-parse; git status`, `(node --check … )`,
    // a python3 heredoc. The run worked it out by trial and error and spent
    // turns doing it.
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).toMatch(/ONE command per Bash call/i);
    for (const form of ["&&", "heredoc", "redirection", "pipes", "subshell"]) {
      expect(lib.HEADLESS_BRIEF.toLowerCase()).toContain(form.toLowerCase());
    }
  });

  it("tells the run to fix obviously garbled copy rather than ship it", async () => {
    // Seen on a real run: the brief carried scraped artifacts — a step timed
    // "260 sec" and one labelled "3 instant" — and the run reproduced them
    // verbatim onto a marketing page. Faithful, and wrong: nobody wants
    // nonsense strings shipped because the task had a paste error.
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).toMatch(/copy-paste artifacts/i);
    expect(lib.HEADLESS_BRIEF).toMatch(/note it in your final report/i);
  });

  it("allows the read-only git queries a real run reached for", async () => {
    const lib = await import("@/lib/coding-agent");
    for (const rule of ["Bash(git rev-parse:*)", "Bash(git check-ignore:*)"]) {
      expect(lib.BASH_ALLOWLIST).toContain(rule);
    }
    // ...and still refuses the ones that change history.
    for (const rule of ["Bash(git push:*)", "Bash(git reset:*)"]) {
      expect(lib.BASH_DENYLIST).toContain(rule);
    }
  });
});

describe("full command access", () => {
  it("is off unless the owner turned it on", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(await lib.getFullAccess()).toBe(false);
    configGet.mockResolvedValue("yes"); // only a real true counts
    expect(await lib.getFullAccess()).toBe(false);
    configGet.mockResolvedValue(true);
    expect(await lib.getFullAccess()).toBe(true);
  });

  it("allows EVERY command via Bash(*) — withholding the list grants nothing", async () => {
    // First version withheld both lists; on the box curl was STILL denied,
    // because in headless mode the allow-list is what approves a command.
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null, fullAccess: true });
    const joined = args.join(" ");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Bash(*)");
    for (const rule of lib.BASH_ALLOWLIST) expect(args).not.toContain(rule);
    // The command deny-list is gone — that is the point of the switch.
    for (const rule of lib.BASH_DENYLIST) expect(joined).not.toContain(rule);
  });

  it("keeps the file rules on Claude Code's OWN tools — but they do not survive Bash(*)", async () => {
    // Measured on the box, and the reason the UI copy changed:
    //   Read(data/config.json)                      -> BLOCKED
    //   head -c 60 .../data/config.json             -> denied (path is visible)
    //   python3 -c "print(open('.../config.json'))" -> RAN, returned the file
    // A tool-name policy cannot fence an interpreter, and no list of blocked
    // words fixes it — node, perl, ruby, awk and `bash -c` all read files.
    // The rules below are still worth shipping (they stop the built-in
    // editor), but full access means full read access in practice.
    const lib = await import("@/lib/coding-agent");
    const joined = lib.buildRunArgs({ resumeSessionId: null, fullAccess: true }).join(" ");
    expect(joined).toContain("--disallowedTools");
    for (const secret of ["config.json", ".mcp-token", ".session-secret", "coding-agent-runs.json"]) {
      expect(joined, `${secret} must stay denied under full access`).toContain(secret);
    }
    // And the same rules a restricted run gets, not a reduced set.
    const restricted = lib.buildRunArgs({ resumeSessionId: null, fullAccess: false }).join(" ");
    for (const secret of ["config.json", ".mcp-token", ".session-secret"]) {
      expect(restricted).toContain(secret);
    }
  });

  it("keeps the capability drop and acceptEdits either way", async () => {
    const lib = await import("@/lib/coding-agent");
    for (const fullAccess of [true, false]) {
      const args = lib.buildRunArgs({ resumeSessionId: null, fullAccess });
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    }
    // setpriv is applied outside buildRunArgs and is not conditional on it.
    expect(lib.CAPABILITY_DROP_ARGS).toContain("--ambient-caps=-all");
  });

  it("leaves the restricted path exactly as it was", async () => {
    const lib = await import("@/lib/coding-agent");
    const off = lib.buildRunArgs({ resumeSessionId: null, fullAccess: false });
    expect(off).toContain("--allowedTools");
    for (const rule of lib.BASH_DENYLIST) expect(off).toContain(rule);
  });

  it("tells the owner what full access really costs, without softening it", async () => {
    // The first version of this copy claimed credentials stayed protected.
    // They do not. The warning must say so in the owner's own terms.
    const { translations } = await import("@/lib/translations");
    const on = translations.en["codingAgent.fullAccessOn"];
    expect(on).toMatch(/any file/i);
    expect(on).toMatch(/keys and passwords/i);
    expect(on).not.toMatch(/stay protected|still protected/i);
  });

  it("records the switch", async () => {
    const lib = await import("@/lib/coding-agent");
    await lib.setFullAccess(true);
    expect(configSet).toHaveBeenCalledWith(lib.CODING_AGENT_FULL_ACCESS_CONFIG_KEY, true);
  });
});

describe("the effort picker", () => {
  it("offers only the levels that measurably differ on this backend", async () => {
    // low 82 / medium 94 / high 102 / xhigh 139 / max 414 reasoning tokens,
    // measured on the box: the first three are within noise of each other.
    const lib = await import("@/lib/coding-agent");
    expect([...lib.OFFERED_EFFORT_LEVELS]).toEqual(["low", "xhigh", "max"]);
    // ...while every level the CLI accepts stays valid to store.
    for (const level of lib.EFFORT_LEVELS) {
      await expect(lib.setEffort(level)).resolves.toBe(level);
    }
  });

  it("still shows a stored level the picker no longer offers", async () => {
    // A box that chose "high" before the narrowing must not render a row with
    // nothing selected — the owner could not then tell what was in force.
    configGet.mockImplementation(async (k: string) =>
      k === "coding_agent_effort" ? "high" : undefined);
    const lib = await import("@/lib/coding-agent");
    const status = await lib.getCodingAgentStatus();
    expect(status.effort).toBe("high");
    expect(status.effortLevels).toContain("high");
    expect(status.effortLevels).toContain("max");
  });
});

describe("sub-agent definitions", () => {
  it("ships agents to delegate to — the Task tool alone never fired", async () => {
    // Every run on this box reported subagentsTotal 0: the tool existed and
    // there was nothing on the other end of it.
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null, subagents: true });
    const i = args.indexOf("--agents");
    expect(i).toBeGreaterThan(-1);
    const defs = JSON.parse(args[i + 1]);
    expect(Object.keys(defs).sort()).toEqual(["explorer", "reviewer", "tester"]);
  });

  it("says 'Use proactively' in every description — that is what triggers a hand-off", async () => {
    const lib = await import("@/lib/coding-agent");
    for (const [name, def] of Object.entries(lib.SUBAGENT_DEFINITIONS)) {
      expect(def.description, `${name} must invite delegation`).toMatch(/use proactively/i);
    }
  });

  it("keeps every helper read-or-verify only — writing stays on the main run", async () => {
    // Delegating the code-writing would put the expensive judgement behind a
    // summary, and Flash is chosen here precisely because these roles read.
    const lib = await import("@/lib/coding-agent");
    for (const [name, def] of Object.entries(lib.SUBAGENT_DEFINITIONS)) {
      expect(def.tools, `${name} must not write`).not.toContain("Write");
      expect(def.tools, `${name} must not edit`).not.toContain("Edit");
      expect(def.model, `${name} should be the cheap tier`).toBe("deepseek-v4-flash");
    }
  });

  it("passes no agents when sub-agents are switched off", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.buildRunArgs({ resumeSessionId: null, subagents: false })).not.toContain("--agents");
  });
});
