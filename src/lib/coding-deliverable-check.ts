/**
 * Looking to see whether the deliverable is actually there.
 *
 * The side-effecting half of ./coding-deliverable: this one stats files and
 * spawns a command, so nothing in the browser bundle may import it. The types,
 * the parsers and the wording live next door, where the run's page can read
 * them.
 *
 * The sandbox a command runs in is PASSED IN rather than imported from
 * ./coding-agent. Two reasons, and both matter: coding-agent.ts imports this
 * module, so importing its capability-drop constants back would make a cycle
 * out of the one module in this family that must be loadable on its own — and
 * the sandbox is the security boundary here, so a test that cannot substitute
 * it cannot prove the command ran inside one.
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import {
  MAX_MISSING_CHARS,
  type Deliverable,
  type DeliverableVerdict,
} from "./coding-deliverable";
import type { PrState } from "./coding-pr-state";

/**
 * How long a deliverable command gets.
 *
 * A project's own verification is the intended command, and on an Orin a real
 * suite is minutes rather than seconds — but this runs on the settle path of a
 * finished run, between the harness exiting and the owner being told what
 * happened, so it cannot be open-ended. Five minutes is long enough for every
 * test command measured on the box and short enough that a command which hangs
 * is reported as a hang rather than holding the verdict for ever.
 */
export const DELIVERABLE_COMMAND_TIMEOUT_MS = 5 * 60_000;

/** How much of a failing command's own output is quoted as the reason. */
export const MAX_COMMAND_OUTPUT_CHARS = 200;

/** The sandbox a deliverable command is run in — the harness's own. */
export interface DeliverableSandbox {
  /** The capability-dropping binary (`setpriv`). */
  bin: string;
  /** Its flags, up to and including the `--` that ends them. */
  args: readonly string[];
  /** The environment, built the way a run's is. */
  env: Record<string, string>;
}

/** What the checker needs to know about the run. */
export interface DeliverableSubject {
  /** The run's working folder, already real-pathed by the runner. */
  directory: string;
  /** The run's pull request record, for the `pr` kind. */
  pr: PrState | null;
}

function verdict(ok: boolean, missing: string | null): DeliverableVerdict {
  return { ok, missing: ok ? null : (missing ?? "").slice(0, MAX_MISSING_CHARS), checkedAt: Date.now() };
}

/**
 * Is the deliverable there?
 *
 * Never throws. A check that cannot be made is NOT a pass — that is the whole
 * point of the feature, and a thrown error swallowed into `ok: true` would put
 * the lie back exactly where it was. It is reported as missing, with what went
 * wrong as the reason, so the attempt loop tries again and the owner ends up
 * with a sentence rather than a tick.
 */
export async function checkDeliverable(
  subject: DeliverableSubject,
  deliverable: Deliverable,
  sandbox: DeliverableSandbox | null,
): Promise<DeliverableVerdict> {
  try {
    switch (deliverable.kind) {
      case "pr":
        return checkPr(subject.pr);
      case "paths":
        return await checkPaths(subject.directory, deliverable.paths);
      case "command":
        return await checkCommand(subject.directory, deliverable.command, sandbox);
    }
  } catch (err) {
    return verdict(false, `The deliverable could not be checked: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A pull request exists for this run's branch.
 *
 * Read off the box's OWN record rather than asked of GitHub a second time. The
 * record is written by the step that opened it (`maybeOpenPullRequest`), which
 * has just run — so a `gh` call here would be a different moment's answer to a
 * question already settled, one more network round trip on the settle path, and
 * a second place that could disagree with the number the card shows.
 */
function checkPr(pr: PrState | null): DeliverableVerdict {
  if (pr?.number != null) return verdict(true, null);
  // The record's own sentence when it has one — "Nothing was committed, so
  // there is no pull request to open" is exactly the diagnosis, and it is
  // better than anything this function could compose.
  const detail = pr?.detail?.trim();
  return verdict(false, detail ? `No pull request was opened. ${detail}` : "No pull request was opened for this run's branch.");
}

/**
 * The named files exist, are files, and are not empty.
 *
 * Resolved against the working folder and then CONTAINED: `isSafeDeliverablePath`
 * kept the obvious nonsense off the record, but a symlink inside the folder
 * pointing out of it is not something a path test can see. So the resolved
 * parent is compared against the real working folder, and a file that is
 * actually somewhere else is reported as missing rather than read — a
 * deliverable must not become a way to ask the box whether a file it guards
 * exists.
 *
 * `lstat`, not `stat`: a symlink whose target is a real file would otherwise
 * satisfy a deliverable by pointing at something the run did not write.
 */
async function checkPaths(directory: string, paths: readonly string[]): Promise<DeliverableVerdict> {
  const root = await realOrSelf(directory);
  for (const relative of paths) {
    const typed = path.resolve(root, relative);
    // Stage one, on the path AS TYPED. `path.resolve` has already normalised
    // away any `.` segment, so this is what catches a traversal the path rule
    // let through and anything resolve collapses differently than expected.
    if (!inside(root, typed)) return verdict(false, `${relative} is not inside the run's folder.`);

    // Stage two, on the REALPATH'D PARENT — the same two-stage containment
    // `coding-agent-media.ts` uses for the other direction, and for its reason:
    // a run can plant a symlink inside its own folder. `away -> /tmp/elsewhere`
    // makes `away/secret.txt` pass stage one lexically while naming a file the
    // run did not write and this box may not be willing to talk about. Found by
    // the test that pins it.
    let parent: string;
    try {
      parent = await fs.realpath(path.dirname(typed));
    } catch {
      // The folder the file should be in is not there, so neither is the file.
      return verdict(false, `${relative} was not created.`);
    }
    if (!inside(root, parent)) return verdict(false, `${relative} is not inside the run's folder.`);
    const absolute = path.join(parent, path.basename(typed));

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      return verdict(false, `${relative} was not created.`);
    }
    if (stat.isSymbolicLink()) return verdict(false, `${relative} is a link, not the file itself.`);
    if (stat.isDirectory()) return verdict(false, `${relative} is a folder, not a file.`);
    if (!stat.isFile()) return verdict(false, `${relative} is not a file.`);
    if (stat.size === 0) return verdict(false, `${relative} is empty.`);
  }
  return verdict(true, null);
}

/** Is `target` the root itself or something under it? */
function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

async function realOrSelf(directory: string): Promise<string> {
  try {
    return await fs.realpath(directory);
  } catch {
    return path.resolve(directory);
  }
}

/**
 * The command exits 0, run the way the harness itself is run.
 *
 * Through the same capability-dropping prefix (`setpriv --ambient-caps=-all
 * --inh-caps=-all --no-new-privs --`), with the run's own environment, in the
 * run's own folder, detached into its own process group so a command that
 * spawns children can be ended whole rather than leaving them behind the way a
 * bare `kill` on the shell would.
 *
 * The output is not kept beyond a bounded tail of the LAST thing it said,
 * because that tail is the reason the owner reads and the nudge quotes — a
 * project's test runner names the failing test there. Nothing else about the
 * output reaches the record, the log or the MCP surface.
 */
async function checkCommand(
  directory: string,
  command: string,
  sandbox: DeliverableSandbox | null,
): Promise<DeliverableVerdict> {
  // No sandbox means the box could not find `setpriv`, which is the same
  // condition that refuses a run outright. Running the command without it
  // would hand it the web server's ambient network capabilities — so it is not
  // run at all, and the verdict says why rather than claiming a pass.
  if (!sandbox) {
    return verdict(false, "The deliverable command could not be run: this box is missing setpriv, so there is no sandbox to run it in.");
  }
  return await new Promise<DeliverableVerdict>((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(sandbox.bin, [...sandbox.args, "/bin/bash", "-lc", command], {
      cwd: directory,
      // The cast is only because this repo's ProcessEnv augmentation insists on
      // NODE_ENV, which a deliverable command has no use for — the same cast
      // the runner's own spawn carries for the same reason.
      env: sandbox.env as NodeJS.ProcessEnv,
      // No stdin: a deliverable command that waits for input would hang to its
      // deadline, and there is nothing to give it.
      stdio: ["ignore", "pipe", "pipe"] as const,
      detached: true,
    });
    // Decoded as UTF-8 by the STREAM, not per chunk: `String(chunk)` on each
    // Buffer turns a multi-byte character split across a chunk boundary into
    // replacement characters, and that tail is what the owner reads and the
    // harness nudge quotes.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const keep = (chunk: Buffer | string): void => {
      // The TAIL, kept by trimming as it arrives: a command that prints a
      // megabyte must not put a megabyte in this closure on its way to a
      // 200-character field.
      output = (output + String(chunk)).slice(-(MAX_COMMAND_OUTPUT_CHARS * 4));
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    /**
     * End the process GROUP the command was spawned into.
     *
     * On every settle path, not only the timeout: a command that starts a
     * descendant and exits — a test runner that leaves a dev server up, `npm
     * test &` — settles through `close` with that descendant still in the
     * detached group, and nothing later reaps it. The run's own group is
     * deliberately left alone when it finishes (the guide tells a run to leave
     * its app's server listening), but this is a CHECK, nobody is told about it,
     * and repeated checks would leak processes and hold ports.
     */
    const endGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // No group left, or the leader is already reaped and took it with it.
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const done = (result: DeliverableVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // After the exit code is in hand — `done` is called FROM the close
      // handler — so this can never race the verdict it is reporting.
      endGroup();
      resolve(result);
    };
    const timer = setTimeout(() => {
      done(verdict(false, `The deliverable command did not finish within ${Math.round(DELIVERABLE_COMMAND_TIMEOUT_MS / 60_000)} minutes.`));
    }, DELIVERABLE_COMMAND_TIMEOUT_MS);
    // The timer must never hold the web server open: this is the one
    // long-lived ClawBox process.
    timer.unref?.();

    child.on("error", (err) => {
      done(verdict(false, `The deliverable command could not be run: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) return done(verdict(true, null));
      const tail = lastLine(output);
      done(verdict(
        false,
        `The deliverable command exited ${code ?? "without a code"}${tail ? `: ${tail}` : "."}`,
      ));
    });
  });
}

/** The last non-blank line of a command's output, bounded. */
function lastLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, MAX_COMMAND_OUTPUT_CHARS) : "";
}
