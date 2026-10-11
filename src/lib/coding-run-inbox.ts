/**
 * A coding run's INBOX: how a message reaches a run in the middle of a turn.
 *
 * `--input-format stream-json` keeps the harness's stdin open, but Claude Code
 * reads the next user turn only once the current one has ENDED — and a
 * delegated run's first turn is the whole task. So a correction sent at minute
 * three was read at minute forty, as the run's last word. And the pipe is this
 * web server's: a run reattached after a restart has none at all.
 *
 * What the installed Claude Code does take mid-turn is a hook's
 * `additionalContext` (PostToolUse, `hookSpecificOutput`), handed to the model
 * right after the tool call it belongs to — proved against the box's own
 * harness (Claude Code 2.1.296: a run told a word only through this hook
 * answered with it) and in this repo's tests against the hook script itself. Every run is spawned with that hook (`runHookSettings`,
 * via `--settings`), pointed at a folder of its own:
 *
 *   data/coding-agent-inbox/<runId>/pending/   messages waiting for a tool call
 *                                  /taken/     receipts: what the hook handed over
 *                                  /reclaimed/ what the box took back at a turn's end
 *
 * A message is written whole (to a temp name, then renamed) into `pending/`;
 * the hook (scripts/coding-run-hook.mjs) TAKES it by renaming it into
 * `taken/`, and the web server takes back what is still pending at the end of
 * a turn by renaming it into `reclaimed/` and delivering it the old way (the
 * next stdin turn, or the next spawn's first). A rename is atomic, so each
 * message goes exactly one of those ways, never both and never twice.
 *
 * Everything on disk, nothing in a pipe: the inbox works for a run this web
 * server only reattached to, and a receipt the hook left while the server was
 * down is read when it comes back.
 */

import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { CONFIG_ROOT, DATA_DIR } from "@/lib/config-store";
import { RUN_MESSAGE_ID_RE } from "@/lib/coding-run-messages";

const RUN_ID_RE = /^run-[a-z0-9]{8}$/;
/** `<13-digit ms>-<id>.json`: the inbox's own order is the order the messages arrived in. */
const INBOX_FILE_RE = /^(\d{13})-(m-[a-z0-9]{8,16})\.json$/;

export function inboxRoot(): string {
  return path.join(DATA_DIR, "coding-agent-inbox");
}

/** The run's inbox folder. Throws for anything that is not a run id: the value reaches the filesystem. */
export function runInboxDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`Not a run id: ${runId}`);
  return path.join(inboxRoot(), runId);
}

/** Make the run's inbox (0700, its three folders), and answer it. */
export function ensureRunInbox(runId: string): string {
  const dir = runInboxDir(runId);
  for (const sub of ["pending", "taken", "reclaimed"]) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  return dir;
}

function names(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => INBOX_FILE_RE.test(n)).sort();
  } catch {
    return [];
  }
}

function idOf(name: string): string {
  return INBOX_FILE_RE.exec(name)![2];
}

/**
 * Put one message in the run's inbox for its hook: `context` is the text the
 * model is handed, already framed (runMessageTurn). False when it could not be
 * written — the message then stays queued for the old ways.
 */
export function postToInbox(runId: string, message: { id: string; at: number; context: string }): boolean {
  if (!RUN_MESSAGE_ID_RE.test(message.id)) return false;
  try {
    const dir = ensureRunInbox(runId);
    const name = `${String(Math.max(0, Math.floor(message.at))).padStart(13, "0")}-${message.id}.json`;
    // Written beside the folder the hook reads and renamed in, so the hook
    // never finds half a message.
    const tmp = untraced(path.join(dir, `.${name}.${process.pid}.tmp`));
    fs.writeFileSync(tmp, JSON.stringify({ id: message.id, context: message.context }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, "pending", name));
    return true;
  } catch {
    return false;
  }
}

/** The ids still waiting in the inbox, oldest first. */
export function inboxPending(runId: string): string[] {
  return names(path.join(runInboxDir(runId), "pending")).map(idOf);
}

/** What the hook has handed over and the box has not recorded yet, oldest first, with when. */
export function inboxReceipts(runId: string): Array<{ id: string; at: number }> {
  const taken = path.join(runInboxDir(runId), "taken");
  return names(taken).map((name) => {
    let at = Date.now();
    try {
      // The rename is the delivery; a rename keeps the file's times, so its
      // change time is when the hook took it.
      at = Math.floor(fs.statSync(path.join(taken, name)).ctimeMs);
    } catch {
      // Gone between the listing and the look: now is close enough.
    }
    return { id: idOf(name), at };
  });
}

/** A receipt recorded on the run's record: removed, so it is never counted twice. */
export function clearReceipts(runId: string, ids: readonly string[]): void {
  const taken = path.join(runInboxDir(runId), "taken");
  const wanted = new Set(ids);
  for (const name of names(taken)) {
    if (!wanted.has(idOf(name))) continue;
    try {
      fs.rmSync(path.join(taken, name), { force: true });
    } catch {
      // Left behind it is read again, and a message already delivered is not marked twice.
    }
  }
}

/**
 * Take back every message the hook has not taken — at a turn's end, at the
 * run's settle, before a spawn delivers the queue its own way. Answers the ids
 * the box got; one the hook took meanwhile is not among them (its receipt is).
 */
export function reclaimInbox(runId: string): string[] {
  const dir = runInboxDir(runId);
  const got: string[] = [];
  for (const name of names(path.join(dir, "pending"))) {
    const target = path.join(dir, "reclaimed", name);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(dir, "pending", name), target);
    } catch {
      continue;
    }
    got.push(idOf(name));
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // A reclaimed file is never read again; one left over costs a few bytes.
    }
  }
  return got;
}

/** The run's inbox, gone with its record. */
export function removeRunInbox(runId: string): void {
  try {
    fs.rmSync(runInboxDir(runId), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** scripts/coding-run-hook.mjs, in this checkout. */
export function runHookScriptPath(): string {
  return path.join(CONFIG_ROOT, "scripts", "coding-run-hook.mjs");
}

/** A word for a POSIX shell, quoted: the hook's command line is run by `sh -c`. */
function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `--settings` JSON a run is spawned with: its PostToolUse inbox hook,
 * and — for a coding team's run — the PreToolUse guard that denies any
 * command merging a pull request. `node` is the binary that runs the hook (the
 * web server's own); null `inbox` leaves the inbox hook out.
 */
export function runHookSettings(opts: { node: string; script?: string; inbox: string | null; mergeGuard: boolean }): string | null {
  const script = opts.script ?? runHookScriptPath();
  const hook = (...args: string[]) => ({ type: "command", command: [opts.node, script, ...args].map(shellWord).join(" "), timeout: 10 });
  const hooks: Record<string, unknown[]> = {};
  if (opts.inbox) hooks.PostToolUse = [{ matcher: "*", hooks: [hook("inbox", opts.inbox)] }];
  if (opts.mergeGuard) hooks.PreToolUse = [{ matcher: "Bash", hooks: [hook("merge-guard")] }];
  return Object.keys(hooks).length ? JSON.stringify({ hooks }) : null;
}
