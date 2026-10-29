/**
 * A coding team's runs never merge a pull request (owner's brief,
 * 2026-10-11): seen live, a worker whose task text quoted a goal ending
 * "…and merge it" merged the PR itself, mid-team. The ORCHESTRATOR merges,
 * once, at the end. Three fences, each pinned here on the argv a team's run
 * is spawned with: the brief says so in place of the auto-merge sentence
 * every other writing run gets, `--disallowedTools` refuses the commands by
 * prefix, and the hook's merge guard (tested against the script itself in
 * coding-run-inbox.test.ts) reads whole command lines.
 */
import { describe, expect, it } from "vitest";
import { BASH_KILL_DENYLIST, buildRunArgs, PR_AUTO_MERGE_BRIEF, TEAM_MERGE_DENYLIST, TEAM_NO_MERGE_BRIEF } from "@/lib/coding-agent";

const after = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1];
/** A variadic flag's values: everything up to the next `--flag`. */
function values(argv: string[], flag: string): string[] {
  const start = argv.indexOf(flag) + 1;
  const end = argv.findIndex((a, i) => i >= start && a.startsWith("--"));
  return argv.slice(start, end < 0 ? undefined : end);
}

const WORKER = { id: "run-abcd1234", directory: "/home/clawbox/Projects/site/.clawbox/worktrees/t1-1", team: { id: "team-abcd1234", role: "worker" as const, taskId: "t1" } };
const SOLO = { id: "run-abcd5678", directory: "/home/clawbox/Projects/site" };

describe("a coding team's worker", () => {
  const argv = buildRunArgs({ run: WORKER, hookSettings: '{"hooks":{}}' });

  it("is told it never merges, instead of being told how to", () => {
    const prompt = after(argv, "--append-system-prompt");
    expect(prompt).toContain(TEAM_NO_MERGE_BRIEF);
    expect(prompt).not.toContain(PR_AUTO_MERGE_BRIEF);
  });

  it("is refused gh pr merge, gh api and git push by prefix — beside the kill list it always had", () => {
    const denied = values(argv, "--disallowedTools");
    for (const rule of [...TEAM_MERGE_DENYLIST, ...BASH_KILL_DENYLIST]) expect(denied).toContain(rule);
    expect(TEAM_MERGE_DENYLIST).toEqual(expect.arrayContaining(["Bash(gh pr merge:*)", "Bash(gh api:*)", "Bash(git push:*)"]));
  });

  it("carries its hooks in --settings, before the variadic tool flags", () => {
    expect(after(argv, "--settings")).toBe('{"hooks":{}}');
    expect(argv.indexOf("--settings")).toBeLessThan(argv.indexOf("--tools"));
  });
});

describe("a run that is nobody's team", () => {
  // The lean brief spends the auto-merge sentence only on a run with a pull
  // request in sight (its task mentions one, or drafts are on).
  const argv = buildRunArgs({ run: SOLO, pullRequestMentioned: true });

  it("keeps the auto-merge sentence its task's consent governs, and no team denial", () => {
    expect(after(argv, "--append-system-prompt")).toContain(PR_AUTO_MERGE_BRIEF);
    expect(after(argv, "--append-system-prompt")).not.toContain(TEAM_NO_MERGE_BRIEF);
    const denied = values(argv, "--disallowedTools");
    for (const rule of TEAM_MERGE_DENYLIST) expect(denied).not.toContain(rule);
    expect(argv).not.toContain("--settings");
  });
});

describe("a team's read-only run (planner, reviewer, lead)", () => {
  it("has no Bash to deny anything in", () => {
    const argv = buildRunArgs({ readOnly: true, run: { ...WORKER, team: { ...WORKER.team, role: "reviewer" as const } } });
    for (const rule of TEAM_MERGE_DENYLIST) expect(values(argv, "--disallowedTools")).not.toContain(rule);
    expect(values(argv, "--allowedTools")).not.toContain("Bash(*)");
  });
});
