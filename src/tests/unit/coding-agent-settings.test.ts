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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "fs";
import osMod from "os";
import pathMod from "path";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  // The status reads the whole file once rather than one key at a time.
  getAll: configGetAll,
  set: configSet,
}));

import {
  buildRunArgs,
  buildRunEnv,
  CODING_AGENT_EFFORT_CONFIG_KEY,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  getEffort,
  setEffort,
  CodingAgentError,
} from "@/lib/coding-agent";

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
});

describe("effort", () => {
  it("offers exactly the levels the installed CLI accepts", () => {
    // `claude --effort bogus` names these five and ignores anything else;
    // ultracode is the CLI's xhigh-plus-workflows mode on top of them.
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
    expect(DEFAULT_EFFORT).toBe("ultracode");
  });

  it("defaults to ultracode when unset, and when the stored value is junk", async () => {
    expect(await getEffort()).toBe("ultracode");
    configGet.mockResolvedValue("turbo");
    expect(await getEffort()).toBe("ultracode");
    configGet.mockResolvedValue(7);
    expect(await getEffort()).toBe("ultracode");
  });

  it("stores a level the CLI knows", async () => {
    expect(await setEffort("low")).toBe("low");
    expect(configSet).toHaveBeenCalledWith(CODING_AGENT_EFFORT_CONFIG_KEY, "low");
  });

  it("refuses a level the CLI would silently ignore", async () => {
    // Passing this through would leave the owner believing they had changed
    // something: the CLI warns on stderr and uses its default.
    await expect(setEffort("turbo")).rejects.toBeInstanceOf(CodingAgentError);
    await expect(setEffort("MAX")).rejects.toBeInstanceOf(CodingAgentError);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("asks for ultracode with the flag, never through the env pin", () => {
    // A pinned CLAUDE_CODE_EFFORT_LEVEL blocks the mode ("clear it and
    // ultracode takes over"), so the wrapper leaves the pin unset for it and
    // the run passes the flag itself — a resume must keep the effort the run
    // started with even after the owner changed the setting.
    const args = buildRunArgs({ effort: "ultracode" });
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "ultracode"]);
    expect(buildRunArgs({ effort: "max" })).not.toContain("--effort");
    expect(buildRunEnv({ effort: "ultracode" }).CLAUDE_DS_EFFORT).toBe("ultracode");
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
  it("says what the argv enforces: chaining is allowed, killing by name is not", async () => {
    // Under the retired allow-list the brief said "one command per call,
    // chaining is refused"; every run has had `Bash(*)` since, and the
    // sentence was simply false — bench cycle 1 (2026-09-05) watched runs
    // split commands for a rule nothing enforced. The one command rule that
    // IS shipped (BASH_KILL_DENYLIST) is what the brief names now.
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).not.toMatch(/ONE command per Bash call/i);
    expect(lib.HEADLESS_BRIEF).toMatch(/You may chain commands with && or ;, pipe, redirect/);
    expect(lib.HEADLESS_BRIEF).toMatch(/End anything you started by its PID: pkill, killall and fuser are refused/);
  });

  it("tells a run whose diff gets a separate review not to send the reviewer helper too", async () => {
    // Bench cycle 1 (2026-09-05): with the automatic review pass on, m-02
    // spent 45% of its wall time idle behind a flash reviewer whose verdict
    // ("no defects") the pass then re-derived with Bash in hand. One diff,
    // one review — the helper sentence is swapped for the reason.
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).toMatch(/before your final report, send the reviewer over your changes/);
    expect(lib.HEADLESS_BRIEF).not.toContain("{{REVIEWER_CLAUSE}}");
    const reviewed = lib.headlessBrief({ reviewedSeparately: true });
    expect(reviewed).toMatch(/your changes get a separate, automatic adversarial review on this device — do not send the reviewer helper/);
    expect(reviewed).not.toMatch(/before your final report, send the reviewer/);
    expect(reviewed).not.toContain("{{REVIEWER_CLAUSE}}");
    // The explorer and tester steps stay whatever the review shape is — the
    // comment above the sentence records what softer wording did.
    expect(reviewed).toMatch(/send the explorer to map it/);
    expect(reviewed).toMatch(/send the tester to run whatever check exists/);
    expect(lib.headlessBrief({ reviewedSeparately: false })).toBe(lib.HEADLESS_BRIEF);

    const brief = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1];
    expect(brief(lib.buildRunArgs({ reviewedSeparately: true }))).toBe(reviewed);
    expect(brief(lib.buildRunArgs({}))).toBe(lib.HEADLESS_BRIEF);
    expect(brief(lib.buildRunArgs({ reviewedSeparately: true, effort: "ultracode" }))).toBe(`${reviewed} ${lib.ULTRACODE_BRIEF}`);
  });

  it("closes the contradictions the refusal task exposed, and asks the report for its assumptions", async () => {
    // Bench s-02 (2026-09-05): the brief banned data/ while --add-dir granted
    // the evidence folder under it; the run listed two sibling projects and
    // walked their .git; it decided its in-folder edit at +13 s and timed out
    // with nothing on disk. m-04's assumptions section came from the bench
    // folder's NAME, not from anything the brief asked for.
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).toMatch(/The one exception is your own evidence folder \(CLAWBOX_RUN_ARTIFACTS_DIR\), which lives under data\//);
    expect(lib.HEADLESS_BRIEF).toMatch(/The folders beside yours under the project root are the owner's other projects: never list, search or read them/);
    expect(lib.HEADLESS_BRIEF).toMatch(/Do the parts you are sure of and that are inside this folder FIRST/);
    expect(lib.HEADLESS_BRIEF).toMatch(/try that step once with Edit or Write — never through Bash — so the device's refusal is on the record/);
    expect(lib.HEADLESS_BRIEF).toMatch(/every assumption you made where the task left a choice open — name the convention or default you picked and why/);
    expect(lib.ULTRACODE_BRIEF).toMatch(/Decide the shape once and do not re-argue whether the ultracode reminder applies/);
    expect(lib.ULTRACODE_BRIEF).toMatch(/a Workflow is for a fan-out of many, never for a folder of two files/);
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

  // Bench run run-g6vwqr9y: the Edit on an outside path was denied, so the
  // run made the same change with `sed -i` through Bash and reported success.
  // The brief now names that move and forbids it; this pins the sentence.
  it("tells the run a denial is a decision, not a puzzle for Bash", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.HEADLESS_BRIEF).toMatch(/denied file action is a DECISION/);
    // Bench cycle 1 (2026-09-05): finish after ONE verification pass, ship
    // exactly the files named, never search the disk for a missing one.
    expect(lib.HEADLESS_BRIEF).toMatch(/Finish decisively: once the work is done and ONE verification pass/);
    expect(lib.HEADLESS_BRIEF).toMatch(/Do not review verified work a second time/);
    expect(lib.HEADLESS_BRIEF).toMatch(/produce exactly those — no extra assets, pictures, notes or scripts/);
    expect(lib.HEADLESS_BRIEF).toMatch(/never search the disk for it/);
    expect(lib.ULTRACODE_BRIEF).toMatch(/a task of one to three files needs no workflow at all/);
    expect(lib.ULTRACODE_BRIEF).toMatch(/at most ONE/);
    expect(lib.HEADLESS_BRIEF).toMatch(/no sed, tee, redirection or scripts through Bash/);
    expect(lib.HEADLESS_BRIEF).toMatch(/report plainly which part was refused/);
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


describe("the effort picker", () => {
  it("offers only the levels that measurably differ on this backend", async () => {
    // low 82 / medium 94 / high 102 / xhigh 139 / max 414 reasoning tokens,
    // measured on the box: the first three are within noise of each other.
    const lib = await import("@/lib/coding-agent");
    expect([...lib.OFFERED_EFFORT_LEVELS]).toEqual(["low", "xhigh", "max", "ultracode"]);
    // ...while every level the CLI accepts stays valid to store.
    for (const level of lib.EFFORT_LEVELS) {
      await expect(lib.setEffort(level)).resolves.toBe(level);
    }
  });

  it("still shows a stored level the picker no longer offers", async () => {
    // A box that chose "high" before the narrowing must not render a row with
    // nothing selected — the owner could not then tell what was in force.
    configGetAll.mockResolvedValue({ coding_agent_effort: "high" });
    const lib = await import("@/lib/coding-agent");
    const status = await lib.getCodingAgentStatus();
    expect(status.effort).toBe("high");
    expect(status.effortLevels).toContain("high");
    expect(status.effortLevels).toContain("max");
  });
});

describe("the folder the device proposes", () => {
  it("suggests ~/Projects, and says so in the status", async () => {
    configGetAll.mockResolvedValue({});
    const lib = await import("@/lib/coding-agent");
    const status = await lib.getCodingAgentStatus();
    expect(status.suggestedDirectory).toBe(lib.suggestedDefaultDirectory());
    expect(status.suggestedDirectory.endsWith("/Projects")).toBe(true);
    // A suggestion, not a default in force: nothing is chosen until saved.
    expect(status.defaultDirectory).toBeNull();
  });

  it("creates the folder when the owner saves one inside their home", async () => {
    // A fresh box has no ~/Projects, and the wizard pre-fills it — so
    // accepting the folder the device proposed must not answer "that folder
    // does not exist on this ClawBox".
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-home-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const lib = await import("@/lib/coding-agent");
      const target = path.join(fs.realpathSync(home), "Projects");
      expect(fs.existsSync(target)).toBe(false);
      const saved = await lib.setDefaultDirectory(target);
      expect(saved).toBe(target);
      expect(fs.statSync(target).isDirectory()).toBe(true);
    } finally {
      process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not create folders outside the owner's home", async () => {
    // Creating directories on someone's behalf is this feature's business
    // only inside their own home; anywhere else a missing folder stays an error.
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    // Writable, and outside the owner's home: a mkdir here would SUCCEED if
    // the fence were gone, so the assertion tests the fence and not the
    // permissions of "/" — where an unprivileged mkdir fails on its own and
    // would have satisfied this test with no guard at all.
    const outside = path.join(fs.realpathSync(os.tmpdir()), "coding-outside-home-xyz");
    expect(outside.startsWith(fs.realpathSync(os.homedir()) + path.sep)).toBe(false);
    const lib = await import("@/lib/coding-agent");
    await expect(lib.setDefaultDirectory(outside)).rejects.toThrow();
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("does not create folders through a symlink that leaves the home", async () => {
    // The lexical fence sees ~/scratch/Projects as inside the home; on disk
    // ~/scratch may be a link to anywhere, and mkdir follows it — so the
    // nearest EXISTING ancestor has to be realpath'd and checked too, or the
    // owner's typed path would create a folder somewhere else entirely.
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-home-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coding-outside-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      fs.symlinkSync(outside, path.join(home, "scratch"));
      vi.resetModules();
      const lib = await import("@/lib/coding-agent");
      const typed = path.join(home, "scratch", "Projects");
      await expect(lib.setDefaultDirectory(typed)).rejects.toThrow();
      // Neither through the link nor under the real home.
      expect(fs.existsSync(path.join(outside, "Projects"))).toBe(false);
      expect(fs.existsSync(typed)).toBe(false);
      expect(configSet).not.toHaveBeenCalled();
    } finally {
      process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the setup wizard flag", () => {
  it("is false on a box that has never been set up", async () => {
    configGetAll.mockResolvedValue({});
    const lib = await import("@/lib/coding-agent");
    expect((await lib.getCodingAgentStatus()).setupComplete).toBe(false);
  });

  it("counts a box configured before the wizard existed as done", async () => {
    // The switch being ON is the same consent the wizard collects. Without
    // this, every owner who already had the agent running would be dropped
    // back into onboarding by the update that introduced it.
    configGetAll.mockResolvedValue({ coding_agent_enabled: true });
    const lib = await import("@/lib/coding-agent");
    expect((await lib.getCodingAgentStatus()).setupComplete).toBe(true);
  });

  it("lets the wizard switch the agent ON without declaring setup finished", async () => {
    // The wizard enables the agent at step 2 so its last step has something to
    // test on. An explicit false must beat the `enabled` fallback, or the app
    // swaps the last step for the home page a second after it appears.
    configGetAll.mockResolvedValue({ coding_agent_enabled: true, coding_agent_setup_complete: false });
    const lib = await import("@/lib/coding-agent");
    const status = await lib.getCodingAgentStatus();
    expect(status.enabled).toBe(true);
    expect(status.setupComplete).toBe(false);
  });

  it("stays done after the owner switches the agent off again", async () => {
    configGetAll.mockResolvedValue({ coding_agent_enabled: false, coding_agent_setup_complete: true });
    const lib = await import("@/lib/coding-agent");
    const status = await lib.getCodingAgentStatus();
    expect(status.enabled).toBe(false);
    // Only a reset reopens the wizard; a switched-off agent is a setting, not
    // an unfinished setup.
    expect(status.setupComplete).toBe(true);
  });
});

describe("sub-agent definitions", () => {
  it("ships agents to delegate to — the Task tool alone never fired", async () => {
    // Every run on this box reported subagentsTotal 0: the tool existed and
    // there was nothing on the other end of it.
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    const i = args.indexOf("--agents");
    expect(i).toBeGreaterThan(-1);
    const defs = JSON.parse(args[i + 1]);
    expect(Object.keys(defs).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer", "tester", "workflow-subagent"]);
  });

  it("shadows the CLI's general-purpose and claude agents with flash readers too", async () => {
    // The Agent tool's own text lands an omitted or unknown subagent_type on
    // general-purpose — a tier-model writer under acceptEdits and Bash(*),
    // whose edits never reach filesTouched and are swept into the settle
    // commit unlisted. Same shadow as workflow-subagent, for the two names
    // the brief cannot stop a model from typing.
    const lib = await import("@/lib/coding-agent");
    for (const name of ["general-purpose", "claude"] as const) {
      const def = lib.SUBAGENT_DEFINITIONS[name];
      expect(def.model).toBe("deepseek-v4-flash");
      // Read-only to the letter: no Write, no Edit, and no shell either — a
      // fallback with Bash is a way to write that filesTouched never sees.
      expect([...def.tools].sort()).toEqual(["Glob", "Grep", "Read"]);
      expect(def.prompt).toMatch(/never edit, never run a command/);
    }
    // ...and the reviewer no longer sells itself as the step before "done":
    // whether a run sends it is the brief's call (see headlessBrief).
    expect(lib.SUBAGENT_DEFINITIONS.reviewer.description).not.toMatch(/before reporting a task complete/);
  });

  it("shadows the workflow's default agent with a flash reader", async () => {
    // Claude Code's own workflow-subagent is a full writer on the session's
    // model; the first ultracode bench run ignored the brief and ran four of
    // them on the tier model. A definition of the same name wins.
    const lib = await import("@/lib/coding-agent");
    const def = lib.SUBAGENT_DEFINITIONS["workflow-subagent"];
    expect(def.model).toBe("deepseek-v4-flash");
    expect(def.tools).not.toContain("Write");
    expect(def.tools).not.toContain("Edit");
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

});

describe("what every run now gets, permanently", () => {
  // The owner removed both switches: full command access and sub-agents are
  // always on. These pin what that means so it cannot drift back silently.

  it("allows every command — no allow-list, no command deny-list", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Bash(*)");
    for (const rule of lib.BASH_DENYLIST) expect(args.join(" ")).not.toContain(rule);
  });

  it("still ships the credential file rules, because they cost nothing", async () => {
    // They bind Claude Code's own Read/Edit/Write and NOT Bash — an
    // interpreter reads the file either way, measured on the box. Worth
    // keeping, not worth trusting.
    const lib = await import("@/lib/coding-agent");
    const joined = lib.buildRunArgs({ resumeSessionId: null }).join(" ");
    for (const secret of ["config.json", ".mcp-token", ".session-secret"]) {
      expect(joined).toContain(secret);
    }
  });

  it("always offers the Agent tool and the three definitions", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--tools") + 1].split(",")).toContain("Agent");
    const defs = JSON.parse(args[args.indexOf("--agents") + 1]);
    expect(Object.keys(defs).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer", "tester", "workflow-subagent"]);
  });

  it("offers and pre-approves the Workflow tool under ultracode, and only there", async () => {
    // Ultracode IS the opt-in to orchestration; listed without the approval
    // the tool answers "Review dynamic workflow before running" to nobody.
    const lib = await import("@/lib/coding-agent");
    const ultra = lib.buildRunArgs({ resumeSessionId: null, effort: "ultracode" });
    expect(ultra[ultra.indexOf("--tools") + 1].split(",")).toContain("Workflow");
    expect(ultra.slice(ultra.indexOf("--allowedTools") + 1, ultra.indexOf("--allowedTools") + 3)).toEqual(["Bash(*)", "Workflow"]);
    expect(ultra[ultra.indexOf("--append-system-prompt") + 1]).toContain(lib.ULTRACODE_BRIEF);
    for (const effort of ["low", "xhigh", "max"] as const) {
      const fixed = lib.buildRunArgs({ resumeSessionId: null, effort });
      expect(fixed[fixed.indexOf("--tools") + 1].split(",")).not.toContain("Workflow");
      expect(fixed).not.toContain("Workflow");
      expect(fixed[fixed.indexOf("--append-system-prompt") + 1]).toBe(lib.HEADLESS_BRIEF);
    }
    expect(lib.toolsFor(true)).not.toContain("Workflow");
    expect(lib.toolsFor(true, "ultracode")).toContain("Workflow");
  });

  it("keeps acceptEdits and the capability drop", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(lib.CAPABILITY_DROP_ARGS).toContain("--ambient-caps=-all");
  });
});

describe("working in a folder the owner already has", () => {
  // A real folder inside the home, created here: the resolver checks the
  // folder exists and lives under the ClawBox home, so a fixture that only
  // pretends would prove nothing.
  let base = "";
  let sub = "";
  beforeEach(() => {
    base = fsSync.mkdtempSync(pathMod.join(osMod.homedir(), ".coding-agent-test-"));
    sub = pathMod.join(base, "my-existing-app");
    fsSync.mkdirSync(sub, { recursive: true });
  });
  afterEach(() => fsSync.rmSync(base, { recursive: true, force: true }));

  it("resolves a bare name against the default project folder", async () => {
    // Before this, a folder the owner made could only be reached by typing
    // its whole absolute path, and nothing told the assistant it existed.
    configGet.mockImplementation(async (k: string) =>
      k === "coding_agent_default_directory" ? base : undefined);
    const lib = await import("@/lib/coding-agent");
    const r = await lib.resolveWorkingDirectory({ directory: "my-existing-app" });
    expect(r.directory).toBe(fsSync.realpathSync(sub));
  });

  it("refuses a bare name that tries to climb out", async () => {
    configGet.mockImplementation(async (k: string) =>
      k === "coding_agent_default_directory" ? base : undefined);
    const lib = await import("@/lib/coding-agent");
    for (const bad of ["..", ".", "../secrets", "a/b"]) {
      await expect(lib.resolveWorkingDirectory({ directory: bad })).rejects.toBeInstanceOf(lib.CodingAgentError);
    }
  });

  it("says so plainly when there is no default to resolve against", async () => {
    configGet.mockResolvedValue(undefined);
    const lib = await import("@/lib/coding-agent");
    await expect(lib.resolveWorkingDirectory({ directory: "some-folder" }))
      .rejects.toThrow(/absolute path, or a folder name/i);
  });

  it("takes only an absolute path for the default folder itself", async () => {
    // A bare name is a folder INSIDE the default; the setting that says where
    // "inside" is cannot be relative to itself. Typed into the Project folder
    // field, "qa" was looked for under the previous default and answered
    // "That folder does not exist" — and a name that did exist there quietly
    // moved the default a level down.
    configGet.mockImplementation(async (k: string) =>
      k === "coding_agent_default_directory" ? base : undefined);
    const lib = await import("@/lib/coding-agent");
    await expect(lib.setDefaultDirectory("my-existing-app")).rejects.toMatchObject({
      kind: "invalid",
      message: expect.stringMatching(/absolute path/i),
    });
    expect(configSet).not.toHaveBeenCalled();
    expect(await lib.setDefaultDirectory(sub)).toBe(fsSync.realpathSync(sub));
  });
});

describe("what every run now gets, permanently", () => {
  // The owner removed both switches: full command access and sub-agents are
  // always on. These pin what that means so it cannot drift back silently.

  it("allows every command — no allow-list, no command deny-list", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Bash(*)");
    for (const rule of lib.BASH_DENYLIST) expect(args.join(" ")).not.toContain(rule);
  });

  it("still ships the credential file rules, because they cost nothing", async () => {
    // They bind Claude Code's own Read/Edit/Write and NOT Bash — an
    // interpreter reads the file either way, measured on the box. Worth
    // keeping, not worth trusting.
    const lib = await import("@/lib/coding-agent");
    const joined = lib.buildRunArgs({ resumeSessionId: null }).join(" ");
    for (const secret of ["config.json", ".mcp-token", ".session-secret"]) {
      expect(joined).toContain(secret);
    }
  });

  it("always offers the Agent tool and the three definitions", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--tools") + 1].split(",")).toContain("Agent");
    const defs = JSON.parse(args[args.indexOf("--agents") + 1]);
    expect(Object.keys(defs).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer", "tester", "workflow-subagent"]);
  });

  it("keeps acceptEdits and the capability drop", async () => {
    const lib = await import("@/lib/coding-agent");
    const args = lib.buildRunArgs({ resumeSessionId: null });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(lib.CAPABILITY_DROP_ARGS).toContain("--ambient-caps=-all");
  });
});

