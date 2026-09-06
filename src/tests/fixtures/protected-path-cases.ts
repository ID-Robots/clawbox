// One case table for the two enforcement surfaces of TASK-605's deny rule.
//
// The rule lives in config/protected-paths.json and is enforced twice, in two
// runtimes that cannot share a line of code: `approvals.deny` fnmatch globs
// inside Hermes' own Python approval gate, and a `before_tool_call` hook loaded
// by the OpenClaw gateway's Node process. src/tests/unit/protected-paths.test.ts
// runs every case below through BOTH and fails when they disagree.
//
// The home directory in these cases is always HOME_DIR, so a case reads the
// same on a developer's machine as on the appliance.

/** The appliance's home directory, and the one the cases are written against. */
export const HOME_DIR = "/home/clawbox";

export interface ProtectedPathCommandCase {
  /** The command line as the agent would issue it. */
  command: string;
  /** Whether BOTH editions must refuse it. */
  denied: boolean;
  /** What this case is here to prove. */
  why: string;
}

/**
 * Commands. Both editions must answer identically, because both decide from
 * the command text alone.
 */
export const PROTECTED_PATH_COMMAND_CASES: ProtectedPathCommandCase[] = [
  // ── The incident, in the spelling the transcript recorded ────────────────
  {
    command:
      "rm /home/clawbox/check-acbuild/data/llamacpp/models/gemma-4-E2B_q4_0-it.gguf",
    denied: true,
    why: "the 3.2 GB delete that opened TASK-605 — a model folder outside the checkout",
  },
  {
    command: "rm -f ~/clawbox/data/llamacpp/models/gemma-4-E2B_q4_0-it.gguf",
    denied: true,
    why: "the same file where a stock box keeps it",
  },
  {
    command: "rm -f ~/clawbox/data/embed/models/nomic-embed-text-v2.gguf",
    denied: true,
    why: "the embedder's model store is the second model folder ClawBox writes",
  },

  // ── The tree itself ──────────────────────────────────────────────────────
  {
    command: "rm -rf ~/clawbox",
    denied: true,
    why: "the whole checkout, named without a trailing separator",
  },
  { command: "rm -rf ~/clawbox/", denied: true, why: "the same, with one" },
  {
    command: "rm ~/clawbox/data/config.json",
    denied: true,
    why: "one file inside the tree",
  },
  {
    command: "mv ~/clawbox/scripts/register-mcp.sh /tmp/",
    denied: true,
    why: "moving a file OUT of the tree destroys it there just as surely",
  },
  {
    command: "truncate -s 0 ~/clawbox/data/llamacpp/models/x.gguf",
    denied: true,
    why: "truncating is one of the four operations the ruling names",
  },
  {
    command: "shred -u ~/clawbox/data/x",
    denied: true,
    why: "shred, likewise",
  },
  {
    command: "unlink ~/clawbox/data/x",
    denied: true,
    why: "unlink, likewise",
  },
  {
    command: "journalctl -u clawbox-gateway | tee ~/clawbox/log.txt",
    denied: true,
    why: "tee writes into the tree",
  },
  {
    command: "echo broken >~/clawbox/data/config.json",
    denied: true,
    why: "a redirection truncates the file it names",
  },
  {
    command: "echo broken > ~/clawbox/data/llamacpp/models/x.gguf",
    denied: true,
    why: "the spaced spelling of the same",
  },
  {
    command: "cat /dev/null >> ~/clawbox/data/x",
    denied: true,
    why: "an appending redirection still creates and writes inside the tree",
  },
  {
    command: "cd ~/clawbox/data/llamacpp/models && rm gemma-4-E2B_q4_0-it.gguf",
    denied: true,
    why: "the cd-then-delete spelling, where the path precedes the verb",
  },
  {
    command: "find ~/clawbox/data/llamacpp/models -name '*.gguf' -delete",
    denied: true,
    why: "find's own delete, which never spells a verb before the path",
  },
  {
    command: "RM -RF ~/CLAWBOX/DATA",
    denied: true,
    why: "both matchers are case-insensitive",
  },
  {
    command: "rm -rf /etc/clawbox",
    denied: true,
    why: "the root-owned edition lock is part of the ClawBox tree",
  },

  // ── Whitespace after the root ────────────────────────────────────────────
  // A newline is not an exotic spelling: it is how a typed command is
  // DELIVERED. `process({action:"write", data:"rm -rf ~/clawbox\n"})` types
  // exactly this into a live pty, and a script body separates its commands the
  // same way. With only a space in pathTerminators the root stopped ending a
  // path segment the moment anything but a space followed it, and the whole
  // tree — the most destructive spelling there is — was allowed.
  {
    command: "rm -rf ~/clawbox\n",
    denied: true,
    why: "the whole checkout followed by the newline that runs the line",
  },
  {
    command: "cd /tmp\nrm -rf ~/clawbox\necho done",
    denied: true,
    why: "the same root mid-script, where no trailing-whitespace strip can reach it",
  },
  {
    command: "rm -rf ~/clawbox\tfoo",
    denied: true,
    why: "a tab separates arguments exactly as a space does",
  },
  {
    command: "rm -rf ~/clawbox\r",
    denied: true,
    why: "a carriage return is what a CRLF script leaves after the root",
  },
  {
    command: "rm -rf ~/check-acbuild/data/llamacpp/models\n",
    denied: true,
    why: "the incident's own model folder, in the second checkout, with the newline that runs it",
  },
  {
    command: "rm -rf ~/clawbox-backup\n",
    denied: false,
    why: "…and the look-alike sibling stays allowed: adding whitespace to the terminators must widen the rule only where a root really ends a segment",
  },

  // ── What must keep working ───────────────────────────────────────────────
  {
    command: "ls -la ~/clawbox/data/llamacpp/models",
    denied: false,
    why: "reading the model folder is not destroying it",
  },
  {
    command: "du -sh ~/clawbox/data/llamacpp/models/*.gguf",
    denied: false,
    why: "the sizing the incident turn did before it deleted anything",
  },
  {
    command: "df -h > /tmp/disk.txt && du -sh ~/clawbox/data/llamacpp/models/",
    denied: false,
    why: "a redirection ELSEWHERE plus a read here — the false positive the loose redirection rule caused",
  },
  {
    command: "cat ~/clawbox/scripts/register-mcp.sh",
    denied: false,
    why: "reading ClawBox's own scripts is how the agent answers questions about the box",
  },
  {
    command: "bash ~/clawbox/scripts/box-health.sh",
    denied: false,
    why: "running a ClawBox script is not writing to the tree",
  },
  {
    command: "rm -rf /home/clawbox/tmp/scratch",
    denied: false,
    why: "THE regression: the appliance's home is /home/clawbox, so an unfolded path here would match /clawbox and the guard would refuse most of the box",
  },
  {
    command: "rm ~/Downloads/clawbox-notes.txt",
    denied: false,
    why: "a file whose name merely starts like the tree is not the tree",
  },
  {
    command: "rm -rf ~/clawbox-backup",
    denied: false,
    why: "a sibling directory is not the tree either — the root must end a path segment",
  },
  {
    command: "rmdir ~/clawbox/data/empty",
    denied: false,
    why: "rmdir removes only empty directories, so it cannot cost anyone a file",
  },
  {
    command: "git add ~/clawbox/README.md",
    denied: false,
    why: "why `dd` is not a verb in the table: `*dd *` would match this",
  },
  {
    command: "cp ~/clawbox/config/protected-paths.json /tmp/",
    denied: false,
    why: "why `cp` is not a verb in the table: it copies OUT as often as it writes IN",
  },
  {
    command: "rm -rf ~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M",
    denied: false,
    why: "the HF cache is deliberately outside the rule — deleting it is the documented repair for a corrupt download",
  },
  {
    command: "echo a > ~/clawbox-backup/x; echo b > ~/clawbox/data/config.json",
    denied: true,
    why: "a redirection into the tree AFTER one into a look-alike sibling — the first-occurrence-only rule let this through on one edition and denied it on the other",
  },
  {
    command: "echo confirm the models && ls ~/clawbox/data/llamacpp/models",
    denied: false,
    why: "`rm ` inside `confirm ` is not the command rm; a token needs a left boundary as well as its trailing space",
  },
  {
    command: "xterm -e ls ~/clawbox",
    denied: false,
    why: "the same, inside a program's name",
  },
  {
    command: "/bin/rm ~/clawbox/data/x",
    denied: true,
    why: "…and a real `rm` reached by its absolute path still is one: `/` is a boundary",
  },
  {
    command: "sed -i s/a/b/ ~/clawbox/data/config.json",
    denied: true,
    why: "an in-place edit is an overwrite, and the spelling an agent reaches for first when asked to fix a file in the tree",
  },
  {
    command: "du -sh ~/embed/models && rm ~/clawbox/data/x",
    denied: true,
    why: "a delete after the SECOND protected root: stopping at the first root hit missed it on one edition while the Hermes globs denied it",
  },
  {
    command: "sed s/a/b/ ~/clawbox/data/config.json",
    denied: false,
    why: "…and sed WITHOUT -i only reads",
  },
];

export interface ProtectedPathToolCase {
  toolName: string;
  params: Record<string, unknown>;
  derivedPaths?: string[];
  denied: boolean;
  why: string;
}

/**
 * Tool-call shapes only the OpenClaw hook can see. Hermes matches command TEXT,
 * so it has no equivalent for a working directory or for a file tool's target —
 * which is why these live in their own table rather than carrying a
 * per-edition expectation.
 */
export const PROTECTED_PATH_TOOL_CASES: ProtectedPathToolCase[] = [
  {
    toolName: "exec",
    params: { command: "rm gemma-4-E2B_q4_0-it.gguf", workdir: "~/clawbox/data/llamacpp/models" },
    denied: true,
    why: "a relative delete from inside the model folder — invisible to any rule that reads only the command",
  },
  {
    toolName: "exec",
    params: { command: "rm big.gguf", workdir: "/home/clawbox/clawbox/data/llamacpp/models" },
    denied: true,
    why: "the same with the resolved home spelled out",
  },
  {
    toolName: "exec",
    params: { command: "ls -la", workdir: "~/clawbox/data/llamacpp/models" },
    denied: false,
    why: "listing the protected folder from inside it is still only a read",
  },
  {
    toolName: "exec",
    params: { command: "rm /tmp/scratch", workdir: "/home/clawbox/tmp" },
    denied: false,
    why: "an ordinary delete from an ordinary directory",
  },
  {
    toolName: "write",
    params: { path: "~/clawbox/data/llamacpp/models/x.gguf", content: "corrupt" },
    denied: true,
    why: "the file tools reach the same paths the shell does",
  },
  {
    toolName: "edit",
    params: { file_path: "/home/clawbox/clawbox/scripts/gateway-pre-start.sh", old: "a", new: "b" },
    denied: true,
    why: "editing the tree the dashboard runs from is the same destruction, slower",
  },
  {
    toolName: "apply_patch",
    params: { input: "*** Begin Patch\n*** Update File: x\n*** End Patch" },
    derivedPaths: ["/home/clawbox/clawbox/src/lib/config-store.ts"],
    denied: true,
    why: "apply_patch names its targets only in the host-derived path hints",
  },
  {
    toolName: "write",
    params: {
      path: "/home/clawbox/notes.md",
      content: "where things live\nthe models are in ~/clawbox/data/llamacpp/models\n",
    },
    denied: false,
    why: "a body that MENTIONS a protected path is not a write to it — a path has no newline, which is how the guard tells a target from prose",
  },
  {
    toolName: "write",
    params: { path: "/home/clawbox/notes.md", content: "see ~/clawbox/data for the models" },
    denied: true,
    why: "the honest cost of that test: a ONE-LINE body naming a protected path is refused as though it were the target. Over-approximating a write is the safe direction",
  },
  {
    toolName: "read",
    params: { path: "~/clawbox/data/llamacpp/models/x.gguf" },
    denied: false,
    why: "the ruling forbids destroying these paths, not looking at them",
  },
  {
    toolName: "process",
    params: { action: "write", sessionId: "s1", data: "rm -rf ~/clawbox/data/llamacpp/models\n" },
    denied: true,
    why: "the two-call bypass: `exec` starts a pty session naming no protected path, and `process` types the delete into it — the core's own exec description steers a model there",
  },
  {
    toolName: "terminal",
    params: { input: "rm -rf ~/clawbox/data/llamacpp/models" },
    denied: true,
    why: "the shared operator terminal is a second door into a live shell",
  },
  {
    toolName: "write",
    params: { path: "/home/clawbox/clawbox/data/code-projects/todo/index.html", content: "<html>" },
    denied: false,
    why: "THE REGRESSION: data/ is inside the checkout, and code_project_init hands the agent absolute paths there and tells it to edit them with its own file tools — denying this took multi-file web apps off the box",
  },
  {
    toolName: "write",
    params: { path: "/home/clawbox/clawbox/data/webapps/todo/index.html", content: "<html>" },
    denied: false,
    why: "the other DATA_DIR public subtrees are writable for the same reason",
  },
  {
    toolName: "write",
    params: { path: "/home/clawbox/clawbox/data/config.json", content: "{}" },
    denied: true,
    why: "the carve-outs are the named subtrees, not data/ itself",
  },
  {
    toolName: "write",
    params: { path: "/home/clawbox/clawbox/data/llamacpp/models/x.gguf", content: "x" },
    denied: true,
    why: "and never the model store, whichever list you read it from",
  },

  // ── `..` through a carve-out ─────────────────────────────────────────────
  // The carve-out is a substring test, and it RETURNS — so a path that merely
  // passes through a writable subtree used to exempt itself from the whole
  // rule before the root check ever ran. Canonicalising the candidate first is
  // what keeps the exception to the subtree it names.
  {
    toolName: "write",
    params: {
      path: "/home/clawbox/clawbox/data/code-projects/../llamacpp/models/gemma.gguf",
      content: "x",
    },
    denied: true,
    why: "THE TRAVERSAL: one `..` walks out of the code-projects carve-out and straight back into the model store",
  },
  {
    toolName: "write",
    params: {
      path: "/home/clawbox/clawbox/data/code-projects/../../data/llamacpp/models/x.gguf",
      content: "x",
    },
    denied: true,
    why: "the same, two levels up and back down",
  },
  {
    toolName: "write",
    params: { path: "/home/clawbox/clawbox/data/webapps/../config.json", content: "{}" },
    denied: true,
    why: "and out of the webapps carve-out onto the tree's own config.json",
  },
  {
    toolName: "write",
    params: {
      path: "/home/clawbox/clawbox/data/llamacpp/models/../../code-projects/app/index.html",
      content: "<html>",
    },
    denied: false,
    why: "…and canonicalising cuts both ways: a path that normalises INTO a carve-out is written, not refused",
  },
];
