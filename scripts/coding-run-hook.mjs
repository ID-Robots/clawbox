#!/usr/bin/env node
/**
 * coding-run-hook — the Claude Code hook every coding run is spawned with
 * (src/lib/coding-run-inbox.ts builds the `--settings` JSON that names it).
 *
 * Plain Node, no dependencies, run by the web server's own Node binary: it is
 * started by the harness after (or before) a tool call, so it has to be quick,
 * and it must never fail the call it rides on — every error ends in exit 0
 * with nothing said.
 *
 *   node coding-run-hook.mjs inbox <inbox-dir>
 *     PostToolUse. Takes every message waiting in <inbox-dir>/pending — the
 *     owner's, a teammate's, the box's own note — and hands them to the model
 *     as `additionalContext`, so a message sent while the run works is read
 *     after the tool call it is in, not at the end of the whole task. A
 *     message is TAKEN by renaming it into <inbox-dir>/taken: a rename is
 *     atomic, so of this hook and the web server reclaiming it at the turn's
 *     end (or of two hooks after two parallel tool calls) exactly one gets it.
 *     The web server reads `taken/` to mark it delivered. A sub-agent's tool
 *     call (the hook input carries an `agent_id`) is not the run's own turn:
 *     nothing is handed over there.
 *
 *   node coding-run-hook.mjs merge-guard
 *     PreToolUse on Bash, for a coding TEAM's runs only: a command that would
 *     merge a pull request — `gh pr merge`, a `gh api` call to a merge
 *     endpoint or mutation, a `git push`, `hub merge`, a curl at GitHub's merge
 *     API — is denied with the reason. The team's orchestrator does the one
 *     final merge; `--disallowedTools` refuses the plain prefixes too, and this
 *     catches the same commands inside `bash -c`, after `&&`, behind `env`.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * A program's global options between its name and its subcommand — `git -C
 * dir push`, `gh -R owner/repo pr merge`, `git --no-pager push` — so the
 * subcommand is found where the program reads it, and never in a commit
 * message ("fix push notifications") that merely contains the word.
 */
const GLOBAL_OPTIONS = String.raw`(?:\s+(?:-[A-Za-z]\s+(?!-)\S+|--?[\w-]+(?:=\S+)?))*`;

/** What a merge looks like in a shell command — the whole text, wherever in it. */
const MERGE_COMMANDS = [
  new RegExp(String.raw`\bgh${GLOBAL_OPTIONS}\s+pr\s+merge\b`),
  new RegExp(String.raw`\bgh${GLOBAL_OPTIONS}\s+api\b[^\n]*(?:\/merges?\b|mergePullRequest|enablePullRequestAutoMerge|mergeBranch)`, "i"),
  new RegExp(String.raw`\bgit${GLOBAL_OPTIONS}\s+push\b`),
  /\bhub\s+merge\b/,
  /api\.github\.com[^\s'"]*\/(?:merges?|pulls\/\d+\/merge)\b/,
];

const MERGE_REFUSAL =
  "A coding team's run never merges or pushes: the team's orchestrator merges once every task is accepted, the suite is green, the final review passed and every check on the pull request passes. Leave your work committed on your branch and say in your final message what is ready.";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hookInput() {
  try {
    const parsed = JSON.parse(readStdin());
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function takeInbox(dir) {
  const pending = path.join(dir, "pending");
  const taken = path.join(dir, "taken");
  let names;
  try {
    names = fs.readdirSync(pending).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const contexts = [];
  for (const name of names) {
    const target = path.join(taken, name);
    try {
      fs.renameSync(path.join(pending, name), target);
    } catch {
      // Somebody else took it — the web server at the turn's end, or another hook.
      continue;
    }
    try {
      const message = JSON.parse(fs.readFileSync(target, "utf8"));
      if (message && typeof message.context === "string" && message.context.trim()) contexts.push(message.context);
    } catch {
      // A file that is not a message is taken and said nowhere.
    }
  }
  return contexts;
}

function main() {
  const [mode, dir] = process.argv.slice(2);
  const input = hookInput();
  if (mode === "inbox") {
    if (!dir || typeof input.agent_id === "string") return;
    const contexts = takeInbox(dir);
    if (!contexts.length) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: contexts.join("\n\n") },
    }));
    return;
  }
  if (mode === "merge-guard") {
    const command = input.tool_name === "Bash" && input.tool_input && typeof input.tool_input.command === "string" ? input.tool_input.command : "";
    if (!command || !MERGE_COMMANDS.some((re) => re.test(command))) return;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: MERGE_REFUSAL },
    }));
  }
}

try {
  main();
} catch {
  // Never the tool call's problem.
}
process.exitCode = 0;
