/**
 * GitHub for the coding agent, through the `gh` CLI.
 *
 * WHY gh RATHER THAN OUR OWN OAUTH
 *
 * GitHub's device flow needs a registered OAuth App's client id. ClawBox has
 * none, and one cannot be conjured at runtime — it is a thing a human
 * registers on github.com. `gh` already ships one, already implements the
 * flow correctly, and is already installed on the device. So "connect" opens
 * a terminal on `gh auth login`, which prints the device code for the owner
 * to enter on github.com from any device. No token is typed on the box, and
 * ClawBox never handles the credential: gh stores it in its own config and
 * lends it to git as a credential helper.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not log in on the owner's behalf, because driving an interactive
 * TUI from a web request is a fragile way to handle someone's credentials.
 * It reads the state and it pushes; the owner does the authorising.
 *
 * Every repository this creates is PRIVATE. A backup of a half-finished
 * project is not a publication, and a run that guessed wrong about a secret
 * in a file should not have that mistake amplified into a public repo.
 */

import path from "path";
import {
  type ChildResult,
  killedDetail,
  runChild,
  startedMissing,
  startFailureDetail,
  wasKilled,
} from "@/lib/child-run";

const GH_TIMEOUT_MS = 60_000;
/** Pushing over the network gets longer than a local git call. */
const PUSH_TIMEOUT_MS = 180_000;

/** The command the owner runs to connect. Shown in the UI and typed into the
 *  Terminal app, so both say the same thing. */
export const GH_LOGIN_COMMAND = "gh auth login --hostname github.com --git-protocol https";

/**
 * Why the probe could not answer. Absent when it did — including when the
 * honest answer is "installed, nobody has logged in yet", which is a state,
 * not a failure.
 */
export type GitHubStatusReason =
  /** `gh` could not be started at all. The binary really is missing. */
  | "not_installed"
  /** `gh` ran but never finished. `gh auth status` validates the stored token
   *  against api.github.com, so a dead uplink or a captive portal hangs it
   *  until the timer kills it. Says nothing about whether gh is installed. */
  | "unreachable"
  /** The file is there but would not execute — EACCES on a binary somebody
   *  chmod'ed, most often. Installing it again fixes nothing; the remedy is
   *  permissions, so this must not be answered with "not installed". */
  | "not_runnable";

export interface GitHubStatus {
  /** Whether gh is installed at all. */
  installed: boolean;
  /** Whether it holds a working credential for github.com. */
  connected: boolean;
  /** The account, when connected. */
  login: string | null;
  /** The command that connects, for the UI to offer. */
  loginCommand: string;
  /** Why the probe failed, when it did. Undefined on an answer we trust. */
  reason?: GitHubStatusReason;
}

export type BackupOutcome =
  | { pushed: true; repo: string; created: boolean; branch: string }
  | {
      pushed: false;
      reason: BackupFailure;
      detail?: string;
      /**
       * The fault was transient — a call our own timer killed, or one that
       * never started — and the same request is worth making again unchanged.
       * `gh_unreachable` says this for the calls that reach github.com; this
       * says it for the LOCAL git probes, which have no reason of their own
       * and whose refusal would otherwise be answered 409: "your request is
       * wrong", about a request that was fine.
       */
      transient?: boolean;
    };

export type BackupFailure =
  /** gh is not installed on this device. */
  | "no_gh"
  /** gh is installed but could not reach GitHub — a transient network fault,
   *  not a missing dependency. Worth retrying; nothing to install. */
  | "gh_unreachable"
  /** Nobody has connected a GitHub account yet. */
  | "not_connected"
  /** The folder has no commits, so there is nothing to back up. */
  | "nothing_to_push"
  /** The folder is not its own repository — see coding-git.ts for why that
   *  matters: it may belong to the ClawBox checkout. */
  | "not_a_repo"
  /** git or gh refused; detail carries what it said. */
  | "failed";

export type DisconnectOutcome =
  | { ok: true; detail?: undefined; kind?: undefined }
  /** `kind` so the route can answer a network fault as one (503, retry) rather
   *  than as a broken box (500). */
  | { ok: false; kind: "no_gh" | "gh_unreachable" | "failed"; detail: string };

/**
 * Run a command with a deliberate, minimal environment.
 *
 * HOME is the one thing gh genuinely needs — its credential lives in
 * ~/.config/gh/hosts.yml. GIT_TERMINAL_PROMPT=0 so a missing credential fails
 * instead of blocking forever on a prompt nobody can answer.
 *
 * The wrapper itself, and the rules for reading a null exit code, live in
 * `@/lib/child-run` — shared with coding-git.ts, which used to carry its own
 * pre-#518 copy of both.
 */
function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ChildResult> {
  return runChild(bin, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/clawbox",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
      LANG: "C",
    },
  });
}

/**
 * The refusal for a local git call that carried no finding — killed by our own
 * timer, or never started. `transient` is what tells the route this is a fault
 * to retry (503) and not a request that cannot be satisfied (409).
 */
function transientGit(r: ChildResult, what: string): BackupOutcome {
  return { pushed: false, reason: "failed", detail: killedDetail(r, what, "Try again."), transient: true };
}

/**
 * The account name out of `gh auth status`.
 *
 * gh writes this to STDERR, not stdout, and has done across versions — so
 * both are searched rather than trusting one. The line reads:
 *   ✓ Logged in to github.com as yalexx (/home/clawbox/.config/gh/hosts.yml)
 */
export function parseLogin(output: string): string | null {
  const m = /Logged in to \S+ as (\S+)/.exec(output);
  return m ? m[1] : null;
}

/**
 * Probed fresh on every call, deliberately. `unreachable` is a statement about
 * this moment's network, not a property of the box: caching one would outlive
 * the outage that produced it and go on refusing backups after the uplink came
 * back.
 */
export async function githubStatus(): Promise<GitHubStatus> {
  const r = await run("gh", ["auth", "status", "--hostname", "github.com"]);
  if (r.startFailed) {
    // ENOENT is the only errno that means "there is no such file". Anything
    // else — EACCES above all — is a binary that EXISTS and would not run, and
    // answering that with "not installed" hands over the one remedy that
    // cannot work.
    const missing = startedMissing(r);
    return {
      installed: !missing,
      connected: false,
      login: null,
      loginCommand: GH_LOGIN_COMMAND,
      reason: missing ? "not_installed" : "not_runnable",
    };
  }
  if (wasKilled(r)) {
    // gh RAN — so it is installed. It just never got an answer out of
    // api.github.com. Reporting this as "not installed" sent the owner off to
    // install software that was already on the box.
    return { installed: true, connected: false, login: null, loginCommand: GH_LOGIN_COMMAND, reason: "unreachable" };
  }
  const login = parseLogin(`${r.stderr}\n${r.stdout}`);
  return {
    installed: true,
    connected: r.code === 0 && login !== null,
    login,
    loginCommand: GH_LOGIN_COMMAND,
  };
}

/**
 * Disconnect the GitHub account.
 *
 * `gh auth logout --hostname github.com` with stdin closed — verified
 * non-interactive on gh 2.4.0, which has no --yes flag. gh forgets its own
 * credential; nothing of ours to clear, because ClawBox never held one.
 *
 * Any repository already pushed stays on GitHub, and any remote already set
 * on a folder stays set — this removes the ability to push, not the history.
 *
 * A logout that was cut short says so, and says nothing more. gh may well have
 * dropped its local credential before it hung, so neither "you are still
 * connected" nor "nothing changed" would be a fact — the owner is pointed back
 * at the status, which re-probes.
 */
export async function disconnectGitHub(): Promise<DisconnectOutcome> {
  const r = await run("gh", ["auth", "logout", "--hostname", "github.com"]);
  if (r.startFailed) {
    // Present but unrunnable is not missing, and must not be answered with an
    // install: the file is there, its permissions are not.
    // Same rule as the status probe: only ENOENT is "not installed". The
    // detail is built from the errno rather than asserted, so an unrecognised
    // one never renders as "(null)" or as a remedy nobody can act on.
    const detail = startFailureDetail(r, "gh");
    return startedMissing(r)
      ? { ok: false, kind: "no_gh", detail }
      : { ok: false, kind: "failed", detail };
  }
  if (wasKilled(r)) {
    return {
      ok: false,
      kind: "gh_unreachable",
      detail: `${killedDetail(r, "Signing out of GitHub")} Then read the connection again.`,
    };
  }
  if (r.code !== 0) return { ok: false, kind: "failed", detail: (r.stderr || r.stdout).slice(0, 300) };
  return { ok: true };
}

/** A repository name GitHub will accept, from a folder name. */
export function repoNameFor(directory: string): string {
  const base = path.basename(path.resolve(directory));
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  return clean || "clawbox-project";
}

/**
 * Push a project folder to GitHub, creating a PRIVATE repository the first
 * time. Never throws; every refusal says which one it was.
 */
export async function backupToGitHub(directory: string): Promise<BackupOutcome> {
  const dir = path.resolve(directory);

  const status = await githubStatus();
  if (status.reason === "not_runnable") {
    // "failed" rather than no_gh, so the route never tells the owner to
    // install a gh that is already sitting on the box.
    return {
      pushed: false,
      reason: "failed",
      detail: "The GitHub CLI is on this ClawBox but would not start. Check its permissions.",
    };
  }
  if (status.reason === "unreachable") {
    // Transient, and nothing to install. Kept distinct from no_gh so the route
    // does not answer a network outage with "install the GitHub CLI".
    return {
      pushed: false,
      reason: "gh_unreachable",
      detail: "Could not reach GitHub from this ClawBox. Check the network connection and try again.",
    };
  }
  if (!status.installed) return { pushed: false, reason: "no_gh" };
  if (!status.connected) return { pushed: false, reason: "not_connected" };

  // Its OWN repository or nothing — the same rule as the per-run commit, and
  // for the same reason: a code project sits inside the ClawBox checkout.
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  // A killed probe is not evidence about the folder. Reading it as one would
  // tell the owner their repository is not a repository.
  if (wasKilled(top)) {
    return transientGit(top, "Reading the folder's git repository");
  }
  if (top.code !== 0 || path.resolve(top.stdout || "") !== dir) {
    return { pushed: false, reason: "not_a_repo", detail: "This folder is not its own git repository." };
  }

  const head = await run("git", ["-C", dir, "rev-parse", "--verify", "HEAD"]);
  // "No commits yet" is a claim about the folder. A killed probe made no such
  // finding, and saying it would tell an owner with a full history that their
  // work is empty.
  if (wasKilled(head)) {
    return transientGit(head, "Reading the folder's commits");
  }
  if (head.code !== 0) return { pushed: false, reason: "nothing_to_push", detail: "The folder has no commits yet." };

  const branchOut = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  // The "main" fallback is a guess, and the push below turns it into
  // `--set-upstream origin main`. Fine when git actually answered and simply
  // had no name to give; wrong when the probe was killed, which would push a
  // `develop` checkout to `main` and bind it there over a transient fault.
  if (wasKilled(branchOut)) {
    return transientGit(branchOut, "Reading the folder's branch");
  }
  const branch = branchOut.code === 0 && branchOut.stdout ? branchOut.stdout : "main";

  const hasRemote = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
  // The consequential one. A non-zero code here means "no remote yet", and the
  // branch below acts on it by CREATING a repository on GitHub. A killed probe
  // returns the same null code, so reading it as "no remote" would create a
  // second repository for a folder that already has one — an irreversible
  // guess made from a transient fault.
  if (wasKilled(hasRemote)) {
    return transientGit(hasRemote, "Reading the folder's git remote");
  }
  let created = false;
  let repo = hasRemote.code === 0 ? hasRemote.stdout : "";

  if (hasRemote.code !== 0) {
    // No remote yet: make one, private, named after the folder. --source
    // wires origin and --push sends the first commits in the same step.
    const name = repoNameFor(dir);
    const create = await run(
      "gh",
      ["repo", "create", name, "--private", "--source", dir, "--push"],
      { cwd: dir, timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (create.code !== 0) {
      // A killed create is a NETWORK fault, and the detail below already says
      // so — "check this ClawBox's network connection and try again". Leaving
      // the reason as "failed" made the route answer 409, a non-retryable
      // client error, to its own retry advice. gh_unreachable is what 503 is
      // wired to, and it is the true statement about a call that hung on the
      // uplink for three minutes.
      if (wasKilled(create)) {
        return {
          pushed: false,
          reason: "gh_unreachable",
          detail: killedDetail(create, "Creating the repository on GitHub"),
          transient: true,
        };
      }
      // GitHub itself refusing — a name already taken, a scope missing — IS a
      // request that cannot be satisfied as it stands. That one keeps its 409.
      return { pushed: false, reason: "failed", detail: (create.stderr || create.stdout).slice(0, 400) };
    }
    created = true;
    const url = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
    repo = url.stdout || name;
    return { pushed: true, repo, created, branch };
  }

  const push = await run(
    "git",
    ["-C", dir, "push", "--set-upstream", "origin", branch],
    { timeoutMs: PUSH_TIMEOUT_MS },
  );
  if (push.code !== 0) {
    // Same rule as the create above: the push is the other call that leaves
    // the box, and a killed one is the network, not the request.
    if (wasKilled(push)) {
      return {
        pushed: false,
        reason: "gh_unreachable",
        detail: killedDetail(push, "Pushing to GitHub"),
        transient: true,
      };
    }
    return { pushed: false, reason: "failed", detail: (push.stderr || push.stdout).slice(0, 400) };
  }
  return { pushed: true, repo, created, branch };
}
