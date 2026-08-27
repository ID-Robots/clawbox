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

import { spawn } from "child_process";
import path from "path";

const GH_TIMEOUT_MS = 60_000;
/** Pushing over the network gets longer than a local git call. */
const PUSH_TIMEOUT_MS = 180_000;

/** The command the owner runs to connect. Shown in the UI and typed into the
 *  Terminal app, so both say the same thing. */
export const GH_LOGIN_COMMAND = "gh auth login --hostname github.com --git-protocol https";

export interface GitHubStatus {
  /** Whether gh is installed at all. */
  installed: boolean;
  /** Whether it holds a working credential for github.com. */
  connected: boolean;
  /** The account, when connected. */
  login: string | null;
  /** The command that connects, for the UI to offer. */
  loginCommand: string;
}

export type BackupOutcome =
  | { pushed: true; repo: string; created: boolean; branch: string }
  | { pushed: false; reason: BackupFailure; detail?: string };

export type BackupFailure =
  /** gh is not installed on this device. */
  | "no_gh"
  /** Nobody has connected a GitHub account yet. */
  | "not_connected"
  /** The folder has no commits, so there is nothing to back up. */
  | "nothing_to_push"
  /** The folder is not its own repository — see coding-git.ts for why that
   *  matters: it may belong to the ClawBox checkout. */
  | "not_a_repo"
  /** git or gh refused; detail carries what it said. */
  | "failed";

interface Result { code: number | null; stdout: string; stderr: string }

/**
 * Run a command with a deliberate, minimal environment.
 *
 * HOME is the one thing gh genuinely needs — its credential lives in
 * ~/.config/gh/hosts.yml. GIT_TERMINAL_PROMPT=0 so a missing credential fails
 * instead of blocking forever on a prompt nobody can answer.
 */
function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/home/clawbox",
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
        LANG: "C",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? GH_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout, stderr: "could not start" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
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

export async function githubStatus(): Promise<GitHubStatus> {
  const r = await run("gh", ["auth", "status", "--hostname", "github.com"]);
  if (r.code === null) {
    return { installed: false, connected: false, login: null, loginCommand: GH_LOGIN_COMMAND };
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
 */
export async function disconnectGitHub(): Promise<{ ok: boolean; detail?: string }> {
  const r = await run("gh", ["auth", "logout", "--hostname", "github.com"]);
  if (r.code === null) return { ok: false, detail: "gh is not installed on this ClawBox." };
  if (r.code !== 0) return { ok: false, detail: (r.stderr || r.stdout).slice(0, 300) };
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
  if (!status.installed) return { pushed: false, reason: "no_gh" };
  if (!status.connected) return { pushed: false, reason: "not_connected" };

  // Its OWN repository or nothing — the same rule as the per-run commit, and
  // for the same reason: a code project sits inside the ClawBox checkout.
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || path.resolve(top.stdout || "") !== dir) {
    return { pushed: false, reason: "not_a_repo", detail: "This folder is not its own git repository." };
  }

  const head = await run("git", ["-C", dir, "rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) return { pushed: false, reason: "nothing_to_push", detail: "The folder has no commits yet." };

  const branchOut = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchOut.code === 0 && branchOut.stdout ? branchOut.stdout : "main";

  const hasRemote = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
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
    return { pushed: false, reason: "failed", detail: (push.stderr || push.stdout).slice(0, 400) };
  }
  return { pushed: true, repo, created, branch };
}
