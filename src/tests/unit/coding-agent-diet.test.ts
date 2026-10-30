/**
 * The brief and the visual decision as `buildRunArgs` applies them
 * (TASK-1749's lean brief and lean helper sentence, the only ones since the
 * full brief and the diet's knobs were deleted):
 *
 *   - the brief keeps every failure-preventing rule in a small budget, with
 *     the browser block only for a visual run and the auto-merge sentence
 *     only where a pull request is in sight;
 *   - the helper sentence says to check work in the run's own shell, and not
 *     to send the reviewer at all when a separate review reads the diff;
 *   - a run judged not visual (`decideRunVisual`, frozen on its record) drops
 *     the browser and media tools from the MCP server, from --allowedTools and
 *     from the brief — while --strict-mcp-config stays, so no owner server can
 *     leak in; an undecided run keeps them.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildRunArgs,
  buildRunMcpConfig,
  decideRunVisual,
  HEADLESS_BRIEF,
  headlessBrief,
  LEAN_VISUAL_BRIEF,
  leanHelpersBrief,
  MCP_BROWSER_TOOLS,
  MCP_MEDIA_TOOLS,
  MCP_TEAM_TOOL,
  MEDIA_BRIEF_AUDIO,
  MEDIA_BRIEF_IMAGES,
  PR_AUTO_MERGE_BRIEF,
  TEAM_NO_MERGE_BRIEF,
} from "@/lib/coding-agent";

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
/** The brief of an ordinary run that is not visual and has no pull request in sight. */
const PLAIN_BRIEF = headlessBrief({ reviewedSeparately: false, visual: false, pullRequest: false });

describe("the brief", () => {
  it("stays within the budget the lean brief was measured at", () => {
    // The full brief it replaced was 7,750 characters; the lean one was
    // measured at under 40% of that (bench/diet, 2026-10-18) and must not
    // grow back — every turn of a run re-sends it.
    expect(PLAIN_BRIEF.length).toBeLessThanOrEqual(3_100);
    expect(headlessBrief({ reviewedSeparately: true, visual: false, pullRequest: false }).length).toBeLessThanOrEqual(3_100);
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
      /Keep your context small/,
      /MOVE \(mv, never copy\) any checker script/,
      /exactly the files the task names, nothing beside them/, /look once/, /never search the disk/,
      /Finish decisively: once ONE verification pass/,
      /final message[\s\S]*file names[\s\S]*every assumption you made/,
    ]) {
      expect(PLAIN_BRIEF).toMatch(rule);
    }
  });

  it("carries the lean helper sentence, never the old delegation protocol", () => {
    expect(PLAIN_BRIEF).toContain(leanHelpersBrief(false));
    expect(PLAIN_BRIEF).not.toContain("Delegate instead of doing everything in one thread");
    expect(PLAIN_BRIEF).toMatch(/Run the project's tests and builds yourself in your shell — cheaper than a helper/);
    expect(PLAIN_BRIEF).toMatch(/explorer only for a codebase too large to read directly, handing it the paths and the question/);
    expect(PLAIN_BRIEF).toMatch(/send the reviewer exactly once, handing it the changed files, the task.s requirements and the edge cases/);
  });

  it("does not send the reviewer at all when a separate review reads the diff", () => {
    const prompt = systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, reviewedSeparately: true }));
    expect(prompt).toContain(leanHelpersBrief(true));
    expect(prompt).toMatch(/Do not send the reviewer/);
    expect(prompt).not.toMatch(/reviewer exactly once/);
  });

  it("carries the browser block only for a visual run", () => {
    expect(PLAIN_BRIEF).not.toContain(LEAN_VISUAL_BRIEF);
    expect(PLAIN_BRIEF).not.toMatch(/browser_fill|CLAWBOX_PREVIEW|cannot see images/);
    const visual = headlessBrief({ reviewedSeparately: false, visual: true });
    expect(visual).toContain(LEAN_VISUAL_BRIEF);
    // An undecided run errs on the side of the tools: HEADLESS_BRIEF is the visual one.
    expect(HEADLESS_BRIEF).toBe(visual);
    expect(LEAN_VISUAL_BRIEF).toMatch(/browser_fill/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/\$CLAWBOX_PREVIEW/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/You cannot see images/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/key by key/);
    expect(LEAN_VISUAL_BRIEF).toMatch(/ONE pass, one screenshot per state/);
  });

  it("carries the auto-merge sentence only when a pull request is in sight", () => {
    expect(PLAIN_BRIEF).not.toContain(PR_AUTO_MERGE_BRIEF);
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, visual: false }))).not.toContain(PR_AUTO_MERGE_BRIEF);
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, visual: false, pullRequestMentioned: true }))).toContain(PR_AUTO_MERGE_BRIEF);
    expect(systemPrompt(buildRunArgs({ effort: "xhigh", run: RUN, visual: false, draftPullRequests: true }))).toContain(PR_AUTO_MERGE_BRIEF);
  });

  it("still tells a team's run it never merges, in place of the auto-merge sentence", () => {
    const prompt = systemPrompt(buildRunArgs({ effort: "xhigh", run: TEAM_RUN, visual: false, pullRequestMentioned: true }));
    expect(prompt).toContain(TEAM_NO_MERGE_BRIEF);
    expect(prompt).not.toContain(PR_AUTO_MERGE_BRIEF);
  });

  it("is byte-identical between two runs with the same decision", () => {
    const a = buildRunArgs({ effort: "xhigh", run: RUN, visual: true, cpuBudget: 2, lessonChannel: true });
    const b = buildRunArgs({ effort: "xhigh", run: { ...RUN, id: "run-bbbbbbbb" }, visual: true, cpuBudget: 2, lessonChannel: true });
    expect(systemPrompt(a)).toBe(systemPrompt(b));
  });
});

describe("a run judged not visual", () => {
  const nonVisual = (extra: Partial<Parameters<typeof buildRunArgs>[0]> = {}) =>
    buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, visual: false, ...extra });

  it("gets no MCP server — but keeps --strict-mcp-config", () => {
    const args = nonVisual();
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    // The evidence folder is still writable.
    expect(args[args.indexOf("--add-dir") + 1]).toMatch(/coding-agent-artifacts\/run-aaaaaaaa$/);
  });

  it("is allowed none of the browser or media tools and told of none", () => {
    const args = nonVisual();
    const allowed = flagValues(args, "--allowedTools");
    for (const tool of [...MCP_BROWSER_TOOLS, MCP_MEDIA_TOOLS.images, MCP_MEDIA_TOOLS.audio]) expect(allowed).not.toContain(tool);
    expect(allowed).toContain("Bash(*)");
    const prompt = systemPrompt(args);
    expect(prompt).not.toContain(MEDIA_BRIEF_IMAGES);
    expect(prompt).not.toContain(MEDIA_BRIEF_AUDIO);
    expect(prompt).not.toContain(LEAN_VISUAL_BRIEF);
  });

  it("as a team's run gets a server with only team_message", () => {
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

  it("is the only case without the tools: a visual run and an undecided one get the same argv", () => {
    const visual = buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN, visual: true });
    expect(visual).toEqual(buildRunArgs({ effort: "xhigh", provider: "clawbox-ai", run: RUN }));
    expect(visual).toContain("--mcp-config");
    expect(systemPrompt(visual)).toContain(LEAN_VISUAL_BRIEF);
    expect(systemPrompt(visual)).toContain(MEDIA_BRIEF_IMAGES);
  });

  it("names nothing new in a visual run's MCP config", () => {
    expect(buildRunMcpConfig(RUN)).toBe(buildRunMcpConfig(RUN, { visual: true }));
    expect(JSON.parse(buildRunMcpConfig(RUN)).mcpServers.clawbox.env).not.toHaveProperty("CLAWBOX_RUN_BROWSER");
  });
});

describe("decideRunVisual", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-diet-"));

  it("judges the task and the folder's top-level entries", () => {
    const plain = dir();
    fs.writeFileSync(path.join(plain, "main.py"), "");
    expect(decideRunVisual("fix the parser", plain)).toBe(false);
    expect(decideRunVisual("build a web page", plain)).toBe(true);

    const site = dir();
    fs.writeFileSync(path.join(site, "index.html"), "");
    expect(decideRunVisual("fix the parser", site)).toBe(true);

    const app = dir();
    fs.mkdirSync(path.join(app, "src", "components"), { recursive: true });
    expect(decideRunVisual("fix the parser", app)).toBe(true);

    // A folder that cannot be read is judged on the task alone.
    expect(decideRunVisual("fix the parser", path.join(plain, "missing"))).toBe(false);
    for (const d of [plain, site, app]) fs.rmSync(d, { recursive: true, force: true });
  });
});
