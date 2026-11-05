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
 *
 *   node coding-run-hook.mjs keepalive <state-dir> [<inbox-dir>] [--first-command=<file>]
 *     Stop. A run is `claude -p`: once the model ends its turn the process
 *     exits and nothing wakes it again, so a run that started a long job in
 *     the background (a board test matrix, an in-app update, a review
 *     workflow) and then said "the evidence follows when it finishes" was
 *     settled half done. This hook refuses that stop (`decision: "block"`)
 *     while the run still has work of its own going on, and says what:
 *       - a message waiting in its inbox (handed over in the reason, taken
 *         the same way the PostToolUse hook takes it);
 *       - a job the run registered in <state-dir>/.run-jobs/<name>.json
 *         ({"pid": n} alive, or no pid and younger than JOB_MAX_AGE_MS);
 *       - a process the run started that is still alive in its own cgroup:
 *         a background shell the harness keeps, or anything reparented out
 *         of the harness's tree. Not counted: the harness's own MCP servers
 *         (its non-shell children) and a process tree that LISTENS on a TCP
 *         port (the documented "leave a server running" pattern). Nothing
 *         else can be waved through: a pid the run wrote to the old
 *         <state-dir>/.run-jobs/keep list is NOT exempt, because a model that
 *         was told it could list a pid there listed its 3-minute test job and
 *         stopped (seen on a board), which is the very stop this hook exists
 *         to refuse.
 *     "Started" is decided by the spawn's COMMAND CLOCK (`--first-command`,
 *     see commandClock): the cgroup is shared with whatever launched the
 *     harness, and a launcher's own watcher (`<launcher> --heal-watch
 *     <session dir>`, forked at session start, reparented to init, alive
 *     until the session ends) was refused as "a process you started" on
 *     every stop, so finished runs looped on sleep and ps until the cap
 *     (2026-11-05, three runs in an hour). A process counts only when it, and
 *     every ancestor of it up to the harness's command shell or up to where
 *     it was reparented, started at or after the run's first command — so a
 *     server the run backgrounded and that init adopted is still the run's.
 *     Bounded: at most MAX_BLOCKS refusals and MAX_BLOCK_SPAN_MS from the
 *     first one, counted in <state-dir>/.run-jobs/stop-blocks.json (the box
 *     reads that file to say a run ended with work still live). A sub-agent's
 *     stop (`agent_id` in the input) is not the run's.
 *
 *   node coding-run-hook.mjs leftovers --first-command=<file> [--unit=<scope>] [--pgid=<n>]
 *     Not a hook: the web server asks this once the harness has gone, to
 *     decide whether a settled run LEFT something running (its record's
 *     `leftover`, the MCP tools' `left_running`). It looks at the processes
 *     still in the run's scope and in its process group and answers, by the
 *     same command-clock rule, the ones the run started:
 *     `{"seen": <processes looked at>, "procs": ["pid N: argv", ...]}` — the
 *     roots only, listening servers included (a server left for the owner is
 *     exactly what the record keeps for the Kill button).
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

/** How many times one run's stop may be refused, and for how long after the first refusal. */
const MAX_BLOCKS = 20;
const MAX_BLOCK_SPAN_MS = 4 * 60 * 60 * 1000;
/** A registered job with no pid counts as running for this long after it was written. */
const JOB_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const SHELLS = new Set(["bash", "sh", "dash", "zsh"]);
/**
 * USER_HZ: the unit of a process's start time in /proc/<pid>/stat. Fixed at
 * 100 by the kernel ABI on arm64 and x86-64 whatever CONFIG_HZ is, and the
 * same 1/100 s that /proc/uptime prints, which is what the command clock is
 * stamped with.
 */
const TICKS_PER_SECOND = 100;

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * pid → { state, ppid, pgid, start } from /proc/<pid>/stat (`start` in ticks
 * since boot, field 22); null when the process is gone.
 */
function procStat(pid) {
  const raw = readText(`/proc/${pid}/stat`);
  if (!raw) return null;
  const close = raw.lastIndexOf(")");
  const rest = raw.slice(close + 2).split(" ");
  return { state: rest[0], ppid: Number(rest[1]), pgid: Number(rest[2]), start: Number(rest[19]) };
}

/**
 * When this spawn's first command began, in ticks since boot: the earliest
 * stamp in the file the run's PreToolUse guard appends /proc/uptime to before
 * a tool call (coding-run-inbox.ts `runHookSettings`). The web server creates
 * the file EMPTY when it spawns the harness, so:
 *   - a number: everything that started before it was there before the run
 *     ran anything — the harness, its MCP servers, the launcher's watchers;
 *   - Infinity: the file is there and unstamped — no tool has been called in
 *     this spawn, so nothing in the cgroup can be the run's work yet;
 *   - null: no clock (not given, gone, unreadable, or nothing in it reads as
 *     a stamp) — the rule before the clock existed applies, every process
 *     counts, rather than waving work through on a guess.
 * The EARLIEST stamp, because two parallel tool calls may both append: each
 * call's command starts after its own guard stamped, so the earliest stamp is
 * at or before every command of the run.
 */
function commandClock(file) {
  if (!file) return null;
  const raw = readText(file);
  if (raw === null) return null;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return Infinity;
  let earliest = Infinity;
  for (const line of lines) {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(line);
    if (!m) continue;
    const ticks = Number(m[1]) * TICKS_PER_SECOND + Number((m[2] ?? "0").padEnd(2, "0"));
    if (ticks < earliest) earliest = ticks;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

/**
 * Did the RUN start this process? Walks up from it through the processes
 * being looked at (`parentOf`): every one on the way must have started at or
 * after the first command (`since`), until the walk reaches the harness — the
 * process was started by one of its command shells — or leaves the set — it
 * was reparented to init or a subreaper, which is how a server the run
 * backgrounded with nohup or setsid ends up. A process that predates the
 * first command, or descends from one that does (a launcher's watcher and
 * whatever it forks later), is not the run's. `since` null: no clock, the
 * old rule — every process counts.
 */
function startedByRun(pid, { parentOf, startOf, harness, since }) {
  if (since === null) return true;
  let cur = pid;
  for (let i = 0; i < 64; i++) {
    if (!((startOf.get(cur) ?? -1) >= since)) return false;
    const parent = parentOf.get(cur);
    if (harness !== null && parent === harness) return true;
    if (parent === undefined || !parentOf.has(parent)) return true;
    cur = parent;
  }
  return false;
}

function procArgv(pid) {
  const raw = readText(`/proc/${pid}/cmdline`);
  return raw ? raw.split("\0").filter(Boolean) : [];
}

function alive(pid) {
  const st = procStat(pid);
  return st !== null && st.state !== "Z" && st.state !== "X";
}

/** This hook's own chain up to init: never counted as the run's work. */
function ancestors(pid) {
  const out = new Set();
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1 && !out.has(cur); i++) {
    out.add(cur);
    const st = procStat(cur);
    if (!st) break;
    cur = st.ppid;
  }
  return out;
}

/** The harness: the nearest ancestor whose argv names Claude Code. */
function harnessPid(chain) {
  for (const pid of chain) {
    const argv = procArgv(pid);
    if (argv.some((a) => /(^|\/)claude(-ds)?$|\/claude\/versions\/|claude-code/.test(a))) return pid;
  }
  return null;
}

/**
 * The pids in the run's own cgroup (v2): only when this process sits in a
 * run's transient scope (`clawbox-run-<runId>-….scope`, coding-run-unit.ts).
 * A run spawned without one shares the web server's cgroup, where "every
 * process here" would be the server itself — null then, and the caller walks
 * the harness's descendants instead.
 */
function cgroupPids() {
  const line = (readText("/proc/self/cgroup") || "").split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const rel = line.slice(3).trim();
  if (!rel || rel === "/" || !/\/clawbox-run-[^/]*\.scope$/.test(rel)) return null;
  const procs = readText(path.join("/sys/fs/cgroup", rel, "cgroup.procs"));
  if (procs === null) return null;
  return procs.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 1);
}

/** Every pid on the box with its parent, for the descendant walk when no cgroup can be read. */
function allPids() {
  try {
    return fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number);
  } catch {
    return [];
  }
}

/** Socket inodes in LISTEN state, from /proc/net/tcp and tcp6 (state 0A). */
function listeningInodes() {
  const out = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const raw = readText(f);
    if (!raw) continue;
    for (const row of raw.split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      if (cols[3] === "0A" && cols[9]) out.add(cols[9]);
    }
  }
  return out;
}

function listens(pid, inodes) {
  if (inodes.size === 0) return false;
  let fds;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    let target = "";
    try {
      target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const m = /^socket:\[(\d+)\]$/.exec(target);
    if (m && inodes.has(m[1])) return true;
  }
  return false;
}

/** A short, single-line description of a process for the model. */
function describe(pid) {
  const argv = procArgv(pid).join(" ").replace(/\s+/g, " ").trim();
  return `pid ${pid}: ${argv.length > 140 ? argv.slice(0, 137) + "..." : argv || "(no command line)"}`;
}

/**
 * The run's own processes that are still doing work: everything in its
 * cgroup (else the harness's descendants) that the run started
 * (`startedByRun`, by the command clock `since`), minus this hook's chain,
 * the harness's non-shell children (its MCP servers) and their trees, and
 * servers that listen on a TCP port. Answers the roots only — a background
 * shell, not every child under it.
 */
function liveRunProcesses(selfPid, since) {
  const chain = ancestors(selfPid);
  const harness = harnessPid(chain);
  if (harness === null) return [];
  const scoped = cgroupPids();
  const parentOf = new Map();
  const startOf = new Map();
  const universe = scoped ?? allPids();
  for (const pid of universe) {
    const st = procStat(pid);
    if (st && st.state !== "Z" && st.state !== "X") {
      parentOf.set(pid, st.ppid);
      startOf.set(pid, st.start);
    }
  }
  // Without a cgroup, the run is the harness's descendants only.
  const inRun = (pid) => {
    if (scoped) return parentOf.has(pid);
    let cur = pid;
    for (let i = 0; i < 64 && cur > 1; i++) {
      if (cur === harness) return true;
      cur = parentOf.get(cur) ?? 0;
    }
    return false;
  };
  const inodes = listeningInodes();
  // The harness's own helpers: a child of the harness that is not a shell
  // (MCP servers, the language server) and everything under it.
  const helperRoots = new Set();
  for (const [pid, ppid] of parentOf) {
    if (ppid !== harness || chain.has(pid)) continue;
    const name = path.basename(procArgv(pid)[0] || "");
    if (!SHELLS.has(name)) helperRoots.add(pid);
  }
  const under = (pid, roots) => {
    let cur = pid;
    for (let i = 0; i < 64 && cur > 1; i++) {
      if (roots.has(cur)) return true;
      cur = parentOf.get(cur) ?? 0;
    }
    return false;
  };
  const candidates = [];
  for (const pid of parentOf.keys()) {
    if (pid === harness || chain.has(pid) || !inRun(pid)) continue;
    if (under(pid, helperRoots)) continue;
    // Sharing the cgroup is not enough: the launcher that started the harness
    // put its own watcher there before the run ran anything.
    if (!startedByRun(pid, { parentOf, startOf, harness, since })) continue;
    candidates.push(pid);
  }
  const candidateSet = new Set(candidates);
  // A tree that holds a listening socket anywhere is a server the run left on purpose.
  const serverRoots = new Set();
  for (const pid of candidates) {
    if (!listens(pid, inodes)) continue;
    let root = pid;
    while (candidateSet.has(parentOf.get(root) ?? 0)) root = parentOf.get(root);
    serverRoots.add(root);
  }
  return candidates
    .filter((pid) => !candidateSet.has(parentOf.get(pid) ?? 0) && !serverRoots.has(pid))
    .sort((a, b) => a - b);
}

/** Is this process in that systemd unit's cgroup? Any hierarchy's line naming it, so cgroup v1 boxes answer too. */
function inUnit(pid, unit) {
  const raw = readText(`/proc/${pid}/cgroup`);
  if (!raw) return false;
  return raw.split("\n").some((line) => line.endsWith(`/${unit}`));
}

/**
 * What a settled run left running (the `leftovers` mode): the processes still
 * in its scope `unit` or its process group `pgid` that the run started, by
 * the command clock. The harness is gone by now, so every one of them is
 * either an orphan the run left or something that was there before its first
 * command; `startedByRun` with no harness tells them apart. `seen` is how many
 * processes were looked at — 0 tells the caller this side could not see into
 * the scope at all, which is not the same as "nothing of the run's is left".
 */
function settledLeftovers({ clock, unit, pgid }) {
  const since = commandClock(clock);
  const parentOf = new Map();
  const startOf = new Map();
  for (const pid of allPids()) {
    if (pid === process.pid) continue;
    const st = procStat(pid);
    if (!st || st.state === "Z" || st.state === "X") continue;
    if (!((pgid !== null && st.pgid === pgid) || (unit !== null && inUnit(pid, unit)))) continue;
    parentOf.set(pid, st.ppid);
    startOf.set(pid, st.start);
  }
  const own = [...parentOf.keys()].filter((pid) => startedByRun(pid, { parentOf, startOf, harness: null, since }));
  const ownSet = new Set(own);
  const roots = own.filter((pid) => !ownSet.has(parentOf.get(pid) ?? 0)).sort((a, b) => a - b);
  return { seen: parentOf.size, procs: roots.map(describe) };
}

/** Jobs the run registered and that still count as running. */
function liveJobs(jobsDir, now) {
  let names;
  try {
    names = fs.readdirSync(jobsDir).filter((n) => n.endsWith(".json") && n !== "stop-blocks.json");
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(jobsDir, name);
    let job = null;
    try {
      job = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const label = typeof job?.name === "string" && job.name.trim() ? job.name.trim() : name.replace(/\.json$/, "");
    if (Number.isInteger(job?.pid) && job.pid > 1) {
      if (alive(job.pid)) out.push(`${label} (pid ${job.pid})`);
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime < JOB_MAX_AGE_MS) out.push(label);
  }
  return out.sort();
}

function readBlocks(file) {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    return { count: Number(b.count) || 0, first: Number(b.first) || 0, capped: b.capped === true, last: b.last ?? null };
  } catch {
    return { count: 0, first: 0, capped: false, last: null };
  }
}

function writeBlocks(file, blocks) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(blocks));
    fs.renameSync(tmp, file);
  } catch {
    // The record is best effort; the refusal itself does not depend on it.
  }
}

function keepalive(stateDir, inboxDir, input, clockFile) {
  if (!stateDir || typeof input.agent_id === "string") return null;
  // Said beside the clock: the harness runs this spawn's hooks. An unstamped
  // clock is then "no command ran" for the settle too, not "a harness that
  // never ran its hooks", which it cannot tell apart on its own.
  if (clockFile && !fs.existsSync(`${clockFile}.stop-ran`)) {
    try {
      fs.writeFileSync(`${clockFile}.stop-ran`, "");
    } catch {
      // Best effort: without it the settle keeps its old answer.
    }
  }
  const jobsDir = path.join(stateDir, ".run-jobs");
  const blocksFile = path.join(jobsDir, "stop-blocks.json");
  const now = Date.now();
  const messages = inboxDir ? takeInbox(inboxDir) : [];
  const jobs = liveJobs(jobsDir, now);
  const procs = liveRunProcesses(process.pid, commandClock(clockFile));
  if (!messages.length && !jobs.length && !procs.length) return null;
  const blocks = readBlocks(blocksFile);
  const first = blocks.first || now;
  if (blocks.count >= MAX_BLOCKS || now - first > MAX_BLOCK_SPAN_MS) {
    // Out of refusals: let the run stop, and leave the box the fact that it
    // ended with work still live.
    writeBlocks(blocksFile, { ...blocks, first, capped: true, last: { at: now, jobs, procs: procs.map(describe) } });
    return null;
  }
  writeBlocks(blocksFile, { count: blocks.count + 1, first, capped: false, last: { at: now, jobs, procs: procs.map(describe) } });
  const parts = [];
  if (messages.length) parts.push(`New messages for you arrived:\n\n${messages.join("\n\n")}`);
  if (jobs.length) parts.push(`Jobs you registered are still running: ${jobs.join(", ")}.`);
  if (procs.length) parts.push(`Processes you started are still running:\n${procs.map((p) => `- ${describe(p)}`).join("\n")}`);
  parts.push(
    "Do not end your turn yet: once you stop, this run exits and nothing wakes you again, so the work above would be left half done. " +
      "Wait for it in this turn (poll it with sleep in a loop, in steps of a few minutes), read its result and finish with it. " +
      "Only a server you leave running for the owner may outlive you, and only once it listens on a TCP port; a test, a build, an update or any other job must finish first. " +
      `Remove a job file from ${jobsDir} when its job is done.`,
  );
  return parts.join("\n\n");
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

/**
 * The command line: positional words, and `--name=value` options wherever
 * they stand, so a hook spawned before an option existed still reads its
 * positions the same way.
 */
function parseArgs(argv) {
  const words = [];
  const options = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (m) options[m[1]] = m[2];
    else words.push(arg);
  }
  return { words, options };
}

function main() {
  const { words, options } = parseArgs(process.argv.slice(2));
  const [mode, dir] = words;
  if (mode === "leftovers") {
    // Run by the web server, not the harness: there is no hook input, and
    // reading stdin would wait on a pipe nobody closes.
    const pgid = Number(options.pgid);
    process.stdout.write(JSON.stringify(settledLeftovers({
      clock: options["first-command"] || null,
      unit: options.unit || null,
      pgid: Number.isInteger(pgid) && pgid > 1 ? pgid : null,
    })));
    return;
  }
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
  if (mode === "keepalive") {
    const reason = keepalive(dir, words[2], input, options["first-command"] || null);
    if (reason) process.stdout.write(JSON.stringify({ decision: "block", reason }));
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
