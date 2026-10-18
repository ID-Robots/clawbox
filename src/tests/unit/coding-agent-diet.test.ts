/**
 * The token diet as `buildRunArgs` applies it (TASK-1749, src/lib/coding-diet.ts):
 *
 *   - the LEGACY diet (full / always / always — what a record without a
 *     `diet` field and a call without one mean) changes nothing: the appended
 *     prompt is pinned by fingerprints taken from the build before the diet
 *     existed, and an explicit LEGACY_DIET is the same argv as no diet at all;
 *   - the DEFAULT diet (the owner's setting when nothing is stored, lean /
 *     lean / auto since TASK-1749's measurement) is NOT that prompt;
 *   - `brief: "lean"` keeps every failure-preventing rule in at most 40% of
 *     HEADLESS_BRIEF, with the browser block only for a visual run and the
 *     auto-merge sentence only where a pull request is in sight;
 *   - `helpers: "lean"` replaces the delegation sentence, in either brief;
 *   - `visualTools: "auto"` with a non-visual run drops the browser and media
 *     tools from the MCP server, from --allowedTools and from the brief —
 *     while --strict-mcp-config stays, so no owner server can leak in.
 */
import { describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildRunArgs,
  buildRunMcpConfig,
  decideRunVisual,
  HEADLESS_BRIEF,
  headlessBrief,
  LEAN_HEADLESS_BRIEF,
  LEAN_VISUAL_BRIEF,
  leanHelpersBrief,
  MCP_BROWSER_TOOLS,
  MCP_MEDIA_TOOLS,
  MCP_TEAM_TOOL,
  MEDIA_BRIEF_AUDIO,
  MEDIA_BRIEF_IMAGES,
  PR_AUTO_MERGE_BRIEF,
  TEAM_NO_MERGE_BRIEF,
  ULTRACODE_EFFORT,
} from "@/lib/coding-agent";
import { type CodingDiet, DEFAULT_DIET, LEGACY_DIET } from "@/lib/coding-diet";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const systemPrompt = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1];
/** The values of a variadic flag, up to the next flag. */
function flagValues(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}

const RUN = { id: "run-aaaaaaaa", directory: "/home/clawbox/Projects/site", media: { images: true, audio: true } };
const TEAM_RUN = { ...RUN, team: { id: "team-aaaaaaaa", role: "worker" as const, taskId: "t1" } };
const LEAN: CodingDiet = { brief: "lean", helpers: "lean", visualTools: "auto", context: "full" };
const DELEGATION_START = "Delegate instead of doing everything in one thread";

describe("the legacy diet changes nothing", () => {
  // Taken from the build BEFORE the diet existed (d6cc266cd), so a change to
  // any default byte of the prompt fails here and not on a box.
  it("keeps HEADLESS_BRIEF and its variants byte for byte", () => {
    expect(HEADLESS_BRIEF.length).toBe(7667);
    expect(sha(HEADLESS_BRIEF)).toBe("29877cced4191674b7a97840f36bd0cd560b6890467cebd8243195187b0696e6");
    expect(sha(headlessBrief({ reviewedSeparately: true }))).toBe("0a85ed82c852ecc79d65814a7e2dda71dc009caa7209e0173b204044ad9368ff");
    expect(sha(headlessBrief({ reviewedSeparately: false, team: true }))).toBe("57336ac4c28442d1c74f84ef5147bd5167a00dd343e4552745d0f3366e21d9a4");
  });

  it("keeps the appended prompt of an ordinary, a PR and an ultracode run byte for byte", () => {
    expect(sha(systemPrompt(buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, cpuBudget: 2, lessonChannel: true, draftPullRequests: true }))))
      .toBe("21908d5e85357b641a2646d6f4e1798941b301d71458f0d08be8249bc408c676");
    expect(sha(systemPrompt(buildRunArgs({ effort: ULTRACODE_EFFORT, provider: "clawbox-ai", run: RUN, cpuBudget: 2, lessonChannel: true, reviewedSeparately: true }))))
      .toBe("3aacb91d558ca3210e3b087ec98e0bad016381e7272182d405ddf92f0a21234b");
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: { ...RUN, media: { images: false, audio: false } } }))).toBe(HEADLESS_BRIEF);
  });

  it.each([
    ["an ordinary run", { effort: "xhigh" as const, provider: "clawbox-ai" as const, run: RUN, cpuBudget: 2, lessonChannel: true, draftPullRequests: true }],
    ["an ultracode resume", { effort: ULTRACODE_EFFORT, run: RUN, reviewedSeparately: true, resumeSessionId: "s1", streamInput: true }],
    ["a team worker", { effort: "xhigh" as const, run: TEAM_RUN }],
    ["a read-only planner", { effort: "xhigh" as const, readOnly: true, run: { ...TEAM_RUN, team: { ...TEAM_RUN.team, role: "planner" as const, taskId: null } } }],
    ["a run with no run context", { effort: "high" as const }],
  ])("gives %s the same argv with an explicit LEGACY_DIET, whatever the visual decision says", (_name, opts) => {
    const before = buildRunArgs(opts);
    expect(buildRunArgs({ ...opts, diet: { ...LEGACY_DIET } })).toEqual(before);
    // `visualTools: "always"` ignores the decision: the tools stay.
    expect(buildRunArgs({ ...opts, diet: { ...LEGACY_DIET }, visual: false, pullRequestMentioned: true })).toEqual(before);
  });
});

describe("the owner's default diet (nothing stored)", () => {
  it("is the lean brief with the lean helper sentence, and drops the tools from a run judged not visual", () => {
    const args = buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, diet: { ...DEFAULT_DIET }, visual: false });
    const prompt = systemPrompt(args);
    expect(prompt).not.toBe(HEADLESS_BRIEF);
    expect(prompt).toContain(leanHelpersBrief(false));
    expect(prompt).not.toContain(DELEGATION_START);
    expect(prompt).not.toContain(LEAN_VISUAL_BRIEF);
    expect(prompt.length).toBeLessThanOrEqual(HEADLESS_BRIEF.length * 0.4);
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--strict-mcp-config");
  });

  it("keeps the browser block and the tools for a run judged visual", () => {
    const args = buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, diet: { ...DEFAULT_DIET }, visual: true });
    expect(systemPrompt(args)).toContain(LEAN_VISUAL_BRIEF);
    expect(args).toContain("--mcp-config");
  });
});

describe("brief: lean", () => {
  it("is at most 40% of HEADLESS_BRIEF for a run that is not visual, with either helper sentence", () => {
    const budget = HEADLESS_BRIEF.length * 0.4;
    expect(LEAN_HEADLESS_BRIEF.length).toBeLessThanOrEqual(budget);
    for (const helpers of ["always", "lean"] as const) {
      const prompt = systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, diet: { ...LEAN, helpers }, visual: false }));
      expect(prompt.length).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps every rule that prevents a real failure", () => {
    for (const rule of [
      /unattended/, /make sensible assumptions/,
      /refused Read, Write or Edit is a decision/, /no sed, tee, redirection or scripts through Bash/,
      /in-folder edits you are sure of FIRST/, /try it once with Edit or Write, never Bash/,
      /ClawBox checkout \(\/home\/clawbox\/clawbox\), its data\/ folder, your run record and session files are off limits, except your evidence folder/,
      /owner's other projects: never list, search or read them/,
      /\$CLAWBOX_RUN_INPUTS_DIR/,
      /chain, pipe and background; end what you started by PID \(pkill, killall and fuser are refused\)/,
      /MOVE \(mv, never copy\) any checker script/,
      /exactly the files the task names, nothing beside them/, /look once/, /never search the disk/,
      /Finish decisively: once ONE verification pass/,
      /final message[\s\S]*file names[\s\S]*every assumption you made/,
    ]) {
      expect(LEAN_HEADLESS_BRIEF).toMatch(rule);
    }
  });

  it("carries the browser block only for a visual run", () => {
    expect(LEAN_HEADLESS_BRIEF).not.toContain(LEAN_VISUAL_BRIEF);
    expect(LEAN_HEADLESS_BRIEF).not.toMatch(/browser_fill|CLAWBOX_PREVIEW|cannot see images/);
    const visual = headlessBrief({ reviewedSeparately: false, diet: LEAN, visual: true });
    expect(visual).toContain(LEAN_VISUAL_BRIEF);
    expect(LEAN_VISUAL_BRIEF).toMatch(/browser_fill/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/\$CLAWBOX_PREVIEW/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/You cannot see images/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/key by key/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/ONE pass, one screenshot per state/);
  });

  it("carries the auto-merge sentence only when a pull request is in sight", () => {
    expect(LEAN_HEADLESS_BRIEF).not.toContain(PR_AUTO_MERGE_BRIEF);
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, diet: LEAN, visual: false }))).not.toContain(PR_AUTO_MERGE_BRIEF);
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, diet: LEAN, visual: false, pullRequestMentioned: true }))).toContain(PR_AUTO_MERGE_BRIEF);
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, diet: LEAN, visual: false, draftPullRequests: true }))).toContain(PR_AUTO_MERGE_BRIEF);
  });

  it("still tells a team's run it never merges, in place of the auto-merge sentence", () => {
    const prompt = systemPrompt(buildRunArgs({ effort: "xhigh", run: TEAM_RUN, diet: LEAN, visual: false, pullRequestMentioned: true }));
    expect(prompt).toContain(TEAM_NO_MERGE_BRIEF);
    expect(prompt).not.toContain(PR_AUTO_MERGE_BRIEF);
  });

  it("is byte-identical between two runs with the same diet", () => {
    const a = buildRunArgs({ effort: "xhigh", run: RUN, diet: LEAN, visual: true, cpuBudget: 2, lessonChannel: true });
    const b = buildRunArgs({ effort: "xhigh", run: { ...RUN, id: "run-bbbbbbbb" }, diet: LEAN, visual: true, cpuBudget: 2, lessonChannel: true });
    expect(systemPrompt(a)).toBe(systemPrompt(b));
  });
});

describe("helpers: lean", () => {
  it.each(["full", "lean"] as const)("replaces the delegation sentence in the %s brief", (brief) => {
    const prompt = systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, diet: { brief, helpers: "lean", visualTools: "always", context: "full" } }));
    expect(prompt).toContain(leanHelpersBrief(false));
    expect(prompt).not.toContain(DELEGATION_START);
    expect(prompt).toMatch(/Run the project's tests and builds yourself in your shell — cheaper than a helper/);
    expect(prompt).toMatch(/explorer only for a codebase too large to read directly, handing it the paths and the question/);
    expect(prompt).toMatch(/send the reviewer exactly once, handing it the changed files, the task.s requirements and the edge cases/);
  });

  it("does not send the reviewer at all when a separate review reads the diff", () => {
    const prompt = systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, reviewedSeparately: true, diet: { ...LEGACY_DIET, helpers: "lean" } }));
    expect(prompt).toContain(leanHelpersBrief(true));
    expect(prompt).toMatch(/Do not send the reviewer/);
    expect(prompt).not.toMatch(/reviewer at most once/);
  });

  it("leaves the full brief otherwise exactly as it was", () => {
    const lean = headlessBrief({ reviewedSeparately: false, diet: { ...LEGACY_DIET, helpers: "lean" } });
    const full = HEADLESS_BRIEF;
    const at = full.indexOf(DELEGATION_START);
    expect(lean.slice(0, at)).toBe(full.slice(0, at));
    expect(lean.endsWith(full.slice(full.indexOf("Sub-agents and workflows run in the background")))).toBe(true);
  });

  it("keeps the delegation sentence under helpers: always in the lean brief", () => {
    expect(LEAN_HEADLESS_BRIEF).toContain(DELEGATION_START);
  });
});

describe("visualTools: auto", () => {
  const nonVisual = (extra: Partial<Parameters<typeof buildRunArgs>[0]> = {}) =>
    buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, diet: { ...LEGACY_DIET, visualTools: "auto" }, visual: false, ...extra });

  it("gives a run that is not visual no MCP server — but keeps --strict-mcp-config", () => {
    const args = nonVisual();
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    // The evidence folder is still writable.
    expect(args[args.indexOf("--add-dir") + 1]).toMatch(/coding-agent-artifacts\/run-aaaaaaaa$/);
  });

  it("allows none of the browser or media tools and tells the run of none", () => {
    const args = nonVisual();
    const allowed = flagValues(args, "--allowedTools");
    for (const tool of [...MCP_BROWSER_TOOLS, MCP_MEDIA_TOOLS.images, MCP_MEDIA_TOOLS.audio]) expect(allowed).not.toContain(tool);
    expect(allowed).toContain("Bash(*)");
    const prompt = systemPrompt(args);
    expect(prompt).not.toContain(MEDIA_BRIEF_IMAGES);
    expect(prompt).not.toContain(MEDIA_BRIEF_AUDIO);
    // The full brief itself is today's, as the diet says.
    expect(prompt).toBe(HEADLESS_BRIEF);
  });

  it("gives a team's run that is not visual a server with only team_message", () => {
    const args = nonVisual({ run: TEAM_RUN });
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    const env = config.mcpServers.clawbox.env;
    expect(env.CLAWBOX_RUN_BROWSER).toBe("0");
    expect(env).not.toHaveProperty("CLAWBOX_RUN_MEDIA");
    expect(env.CLAWBOX_TEAM_ID).toBe("team-aaaaaaaa");
    const allowed = flagValues(args, "--allowedTools");
    expect(allowed).toContain(MCP_TEAM_TOOL);
    for (const tool of MCP_BROWSER_TOOLS) expect(allowed).not.toContain(tool);
  });

  it("gives a visual run exactly today's tools and media briefs", () => {
    const args = buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, diet: { ...LEGACY_DIET, visualTools: "auto" }, visual: true });
    expect(args).toEqual(buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN }));
  });

  it("names nothing new in today's MCP config", () => {
    expect(buildRunMcpConfig(RUN)).toBe(buildRunMcpConfig(RUN, { visual: true }));
    expect(JSON.parse(buildRunMcpConfig(RUN)).mcpServers.clawbox.env).not.toHaveProperty("CLAWBOX_RUN_BROWSER");
  });
});

describe("decideRunVisual", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-diet-"));

  it("is always yes under visualTools: always", () => {
    expect(decideRunVisual(LEGACY_DIET, "fix the parser", "/nonexistent")).toBe(true);
  });

  it("judges the task and the folder's top-level entries under auto", () => {
    const auto = { ...LEGACY_DIET, visualTools: "auto" as const };
    const plain = dir();
    fs.writeFileSync(path.join(plain, "main.py"), "");
    expect(decideRunVisual(auto, "fix the parser", plain)).toBe(false);
    expect(decideRunVisual(auto, "build a web page", plain)).toBe(true);

    const site = dir();
    fs.writeFileSync(path.join(site, "index.html"), "");
    expect(decideRunVisual(auto, "fix the parser", site)).toBe(true);

    const app = dir();
    fs.mkdirSync(path.join(app, "src", "components"), { recursive: true });
    expect(decideRunVisual(auto, "fix the parser", app)).toBe(true);

    // A folder that cannot be read is judged on the task alone.
    expect(decideRunVisual(auto, "fix the parser", path.join(plain, "missing"))).toBe(false);
    for (const d of [plain, site, app]) fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("context: capped", () => {
  it("sets the compaction window in the run's environment, and nothing when full", async () => {
    const { buildRunEnv } = await import("@/lib/coding-agent");
    const { DEFAULT_DIET } = await import("@/lib/coding-diet");
    expect(buildRunEnv({ diet: { ...DEFAULT_DIET, context: "capped" } }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("128000");
    expect(buildRunEnv({ diet: { ...DEFAULT_DIET, context: "full" } }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(buildRunEnv({}).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});

