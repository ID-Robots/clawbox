/**
 * A run that may only read — a coding team's planner — gets the tools and
 * the brief that match: Read, Grep, Glob and the helpers, approved by name,
 * Bash for read-only git and nothing else, no browser tools, and words that
 * say exactly that. Nor anything a reading run cannot use: the Workflow
 * fan-out, the helpers that carry Bash, the browser profile and the media
 * allowance of its MCP server.
 *
 * Seen on a team: a planner that could not read the project planned blind,
 * every repo_map entry "source not inspected", and its catch-all task folded
 * the whole plan into one run.
 */
import { describe, expect, it } from "vitest";
import {
  BASH_KILL_DENYLIST,
  buildCodexRunArgs,
  buildRunArgs,
  fileDenyRules,
  MUTATING_GIT_DENYLIST,
  READ_ONLY_BRIEF,
  READ_ONLY_GIT_RULES,
  READ_ONLY_TOOLS,
  SUBAGENT_DEFINITIONS,
  subagentDefinitionsFor,
  TEAM_MERGE_DENYLIST,
  WORKFLOW_TOOL,
} from "@/lib/coding-agent";

function flag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  }
  return out;
}

const PLANNER = { id: "run-aaaaaaaa", directory: "/p", team: { id: "team-aaaaaaaa", role: "planner" as const, taskId: null } };

/**
 * Claude Code's Bash rule grammar, as far as these rules use it: `prefix:*`
 * is the prefix alone or followed by a space and anything, and a `*` anywhere
 * else is any text. Each part of a compound command is judged on its own by
 * the CLI, so a command here is one part.
 */
function matches(rule: string, command: string): boolean {
  const spec = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (spec === undefined) return false;
  const glob = spec.endsWith(":*") ? `${spec.slice(0, -2)}\u0000` : spec;
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, "\\$&")).join(".*").replace("\u0000", "(?: .*)?");
  return new RegExp(`^${source}$`, "s").test(command);
}

/** What a headless run does with one command: approved, refused by a deny rule, or refused for want of an approval. */
function verdict(args: string[], command: string): "allowed" | "denied" | "unapproved" {
  if (flag(args, "--disallowedTools").some((rule) => matches(rule, command))) return "denied";
  return flag(args, "--allowedTools").some((rule) => matches(rule, command)) ? "allowed" : "unapproved";
}

describe("a read-only run", () => {
  it("lists the reading tools and Bash, approves no Bash(*), and carries the read-only brief plus the role's words", () => {
    const args = buildRunArgs({ effort: "ultracode", readOnly: true, extraBrief: "Answer with ONLY a JSON array.", run: { id: "run-aaaaaaaa", directory: "/p", media: { images: true, audio: true } } });
    expect(flag(args, "--tools")).toEqual([`${READ_ONLY_TOOLS},Bash`]);
    expect(READ_ONLY_TOOLS).toBe("Read,Grep,Glob,Agent");
    const allowed = flag(args, "--allowedTools");
    expect(allowed).not.toContain("Bash(*)");
    expect(allowed.some((a) => a.startsWith("mcp__"))).toBe(false);
    const brief = flag(args, "--append-system-prompt")[0];
    expect(brief).toContain(READ_ONLY_BRIEF);
    expect(brief).toContain("Answer with ONLY a JSON array.");
    expect(brief).not.toMatch(/ONE command per Bash call|Bash may chain|browser_view_local|CLAWBOX_RUN_ARTIFACTS_DIR|generate_image/);
    expect(READ_ONLY_BRIEF).toMatch(/READ-ONLY session/);
  });

  it("approves Read, Grep, Glob and Agent by name, so a read outside its folder never waits on a prompt — the deny rules still outrank them", () => {
    for (const run of [PLANNER, undefined]) {
      const args = buildRunArgs({ readOnly: true, run });
      const allowed = flag(args, "--allowedTools");
      for (const tool of ["Read", "Grep", "Glob", "Agent"]) expect(allowed).toContain(tool);
      expect(flag(args, "--disallowedTools")).toEqual(expect.arrayContaining(fileDenyRules()));
    }
    // A writing run is not handed them by this: its approvals stay as they were.
    const writer = flag(buildRunArgs({ run: { id: "run-aaaaaaaa", directory: "/p" } }), "--allowedTools");
    for (const tool of ["Read", "Grep", "Glob"]) expect(writer).not.toContain(tool);
  });

  it("may run read-only git through Bash and nothing else", () => {
    const named = ["log", "status", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "shortlog", "describe"].map((cmd) => `Bash(git ${cmd}:*)`);
    for (const run of [PLANNER, undefined]) {
      const args = buildRunArgs({ readOnly: true, run });
      const bash = flag(args, "--allowedTools").filter((rule) => rule.startsWith("Bash"));
      expect(bash).toEqual(expect.arrayContaining(named));
      expect(bash).toEqual([...READ_ONLY_GIT_RULES]);
      for (const rule of bash) expect(rule).toMatch(/^Bash\(git [a-z-]+:\*\)$/);

      for (const command of ["git log --oneline -20", "git status", "git diff origin/beta -- src", "git show HEAD:src/lib/a.ts", "git branch -a", "git rev-parse HEAD", "git ls-files src", "git blame -L 1,9 a.ts", "git shortlog -sn", "git describe --tags"]) {
        expect(verdict(args, command), command).toBe("allowed");
      }
      for (const command of ["git push origin HEAD", "git commit -m x", "git add .", "git checkout -- a.ts", "git reset --hard", "git branch -D main", "git branch -d old", "git stash", "git worktree add ../x", "git remote set-url origin x", "git config user.name x", "git clean -fd", "git fetch", "git pull", "gh pr merge 1", "gh pr create", "gh api repos", "pkill -f next-server", "killall node"]) {
        expect(verdict(args, command), command).toBe("denied");
      }
      for (const command of ["rm -rf src", "npm install", "touch a", "mkdir b", "bash -c 'git log'", "curl http://example.com", "node -e 1"]) {
        expect(verdict(args, command), command).toBe("unapproved");
      }
      // The diff family's --output writes a file wherever it is told.
      for (const command of ["git log --output=/tmp/x", "git diff --output x", "git show --output=a HEAD"]) {
        expect(verdict(args, command), command).toBe("denied");
      }
    }
  });

  it("is refused the kill list, the merge list and every mutating git command, in a team or not", () => {
    for (const run of [PLANNER, { id: "run-aaaaaaaa", directory: "/p" }, undefined]) {
      const denied = flag(buildRunArgs({ readOnly: true, run }), "--disallowedTools");
      for (const rule of [...fileDenyRules(), ...BASH_KILL_DENYLIST, ...TEAM_MERGE_DENYLIST, ...MUTATING_GIT_DENYLIST]) expect(denied).toContain(rule);
    }
    for (const cmd of ["push", "commit", "add", "rm", "mv", "checkout", "switch", "restore", "reset", "merge", "rebase", "cherry-pick", "stash", "branch -D", "branch -d", "worktree", "tag", "remote add", "remote set-url", "config", "clean", "am", "apply", "fetch", "pull", "gc", "init", "clone"]) {
      expect(MUTATING_GIT_DENYLIST).toContain(`Bash(git ${cmd}:*)`);
    }
    expect(MUTATING_GIT_DENYLIST).toEqual(expect.arrayContaining(["Bash(gh pr:*)", "Bash(gh api:*)"]));
    // No approval is ever shadowed into a deny of a read: every read-only rule stays usable.
    for (const rule of READ_ONLY_GIT_RULES) expect(MUTATING_GIT_DENYLIST).not.toContain(rule);
  });

  it("answers no prompt it was not pre-approved for: default mode, never acceptEdits", () => {
    // acceptEdits accepts file edits and the CLI's common filesystem commands
    // in the folder without a rule; a run that may write nothing has no use for it.
    const args = buildRunArgs({ readOnly: true, run: PLANNER });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    const writer = buildRunArgs({ run: { id: "run-aaaaaaaa", directory: "/p" } });
    expect(writer[writer.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("is told the truth about its tools: read-only git by name, everything else refused, still no writing and no push", () => {
    expect(READ_ONLY_BRIEF).not.toMatch(/no shell/);
    expect(READ_ONLY_BRIEF).toMatch(/Bash for read-only git only/);
    for (const rule of READ_ONLY_GIT_RULES) expect(READ_ONLY_BRIEF).toContain(/^Bash\((.*):\*\)$/.exec(rule)?.[1] ?? rule);
    expect(READ_ONLY_BRIEF).toMatch(/any other command is refused and wastes a step/);
    expect(READ_ONLY_BRIEF).toMatch(/do not try to edit, create, delete or push anything/);
    expect(READ_ONLY_BRIEF).toMatch(/Read, Grep and Glob/);
  });

  it("is never handed the Workflow tool, whatever effort the record carries", () => {
    // startRun clamps a read-only run's ultracode to xhigh; a record from
    // before that clamp still resumes with `effort: "ultracode"`, and must
    // not get the fan-out either.
    const args = buildRunArgs({ effort: "ultracode", readOnly: true, run: { id: "run-aaaaaaaa", directory: "/p" } });
    expect(flag(args, "--allowedTools")).not.toContain(WORKFLOW_TOOL);
    expect(flag(args, "--tools")[0].split(",")).not.toContain(WORKFLOW_TOOL);
    expect(args).not.toContain(WORKFLOW_TOOL);
  });

  it("gets no helper that carries Bash, and keeps the two no-Bash decoys", () => {
    for (const provider of ["clawbox-ai", "anthropic"] as const) {
      const defs = subagentDefinitionsFor(provider, { readOnly: true });
      expect(Object.keys(defs).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer"]);
      for (const def of Object.values(defs) as { tools: string[] }[]) expect(def.tools).not.toContain("Bash");
      // A writing run keeps every definition, the tester among them.
      expect(Object.keys(subagentDefinitionsFor(provider))).toEqual(Object.keys(SUBAGENT_DEFINITIONS));
    }
    const args = buildRunArgs({ readOnly: true, run: { id: "run-aaaaaaaa", directory: "/p" } });
    const handed = JSON.parse(flag(args, "--agents")[0]) as Record<string, unknown>;
    expect(Object.keys(handed).sort()).toEqual(["claude", "explorer", "general-purpose", "reviewer"]);
  });

  it("starts no browser profile and holds no media on its MCP server, on either harness", () => {
    const run = { id: "run-aaaaaaaa", directory: "/p", media: { images: true, audio: true }, team: { id: "team-aaaaaaaa", role: "planner" as const, taskId: null } };
    const claude = JSON.parse(flag(buildRunArgs({ readOnly: true, visual: true, run }), "--mcp-config")[0]) as { mcpServers: { clawbox: { env: Record<string, string> } } };
    expect(claude.mcpServers.clawbox.env.CLAWBOX_RUN_BROWSER).toBe("0");
    expect(claude.mcpServers.clawbox.env.CLAWBOX_RUN_MEDIA).toBeUndefined();
    expect(claude.mcpServers.clawbox.env.CLAWBOX_TEAM_ROLE).toBe("planner");
    const codex = buildCodexRunArgs({ readOnly: true, visual: true, run, model: "gpt-5.6-luna" }).join("\n");
    expect(codex).toContain('CLAWBOX_RUN_BROWSER = "0"');
    expect(codex).not.toContain("CLAWBOX_RUN_MEDIA");
    // A writing run on the same record keeps its browser and media.
    const writer = JSON.parse(flag(buildRunArgs({ visual: true, run: { ...run, team: { ...run.team, role: "worker" as const, taskId: "t1" } } }), "--mcp-config")[0]) as { mcpServers: { clawbox: { env: Record<string, string> } } };
    expect(writer.mcpServers.clawbox.env.CLAWBOX_RUN_BROWSER).toBeUndefined();
    expect(writer.mcpServers.clawbox.env.CLAWBOX_RUN_MEDIA).toBeTruthy();
  });

  it("is told how many steps it has, and that a step is one reply", () => {
    const brief = flag(buildRunArgs({ readOnly: true, maxTurns: 100 }), "--append-system-prompt")[0];
    expect(brief).toContain("This run has 100 steps.");
    expect(READ_ONLY_BRIEF).toContain("each reply you send spends one step, however many tool calls it carries");
    expect(READ_ONLY_BRIEF).not.toContain("every tool call spends one");
    // The constant itself never carries a figure: it is compared byte for byte.
    expect(READ_ONLY_BRIEF).not.toContain("This run has");
    expect(flag(buildRunArgs({ readOnly: true }), "--append-system-prompt")[0]).not.toContain("This run has");
  });

  it("leaves an ordinary run exactly as it was", () => {
    const args = buildRunArgs({ effort: "ultracode", run: { id: "run-aaaaaaaa", directory: "/p", media: { images: false, audio: false } } });
    expect(flag(args, "--tools")[0]).toContain("Bash");
    expect(flag(args, "--allowedTools")).toContain("Bash(*)");
    expect(flag(args, "--append-system-prompt")[0]).not.toContain(READ_ONLY_BRIEF);
  });
});
