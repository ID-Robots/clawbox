/**
 * GitHub for the coding agent, through the `gh` CLI.
 *
 * WHY gh RATHER THAN OUR OWN OAUTH
 *
 * GitHub's device flow needs a registered OAuth App's client id. ClawBox has
 * none — but `gh` does, published in its open source and honoured by
 * github.com for exactly this flow. So "connect" runs the SAME device flow gh
 * itself would run, just without the terminal: startDeviceLogin() asks
 * github.com for a one-time code the UI shows with a tappable link (a
 * terminal `gh auth login` on a phone tries xdg-open on the box, fails
 * noisily, and buries the URL — measured from a phone through the tunnel),
 * pollDeviceLogin() waits for the owner to approve on github.com from any
 * device, and the resulting token is handed straight to
 * `gh auth login --with-token` on stdin. gh stores it in its own config and
 * lends it to git as a credential helper; ClawBox holds the token for the
 * milliseconds between GitHub's answer and gh's stdin, never in argv, a
 * file, or a log.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not log in on the owner's behalf: the owner approves the code on
 * github.com, and the routes behind these functions refuse the agent's
 * bearer. It reads the state and it pushes; the owner does the authorising.
 *
 * Every repository this creates is PRIVATE. A backup of a half-finished
 * project is not a publication, and a run that guessed wrong about a secret
 * in a file should not have that mistake amplified into a public repo.
 */

import path from "path";
import {
  type ChildResult,
  failureDetail,
  inconclusive,
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

// ── Device-flow login ────────────────────────────────────────────────────────

/** The GitHub CLI's own OAuth client id — public in gh's source, and the id
 *  the token must be minted under for `gh auth login --with-token` to be
 *  indistinguishable from a terminal login. Env-overridable for a fork that
 *  registered its own app. */
const GH_OAUTH_CLIENT_ID = process.env.CLAWBOX_GITHUB_CLIENT_ID?.trim() || "178c6fc778ccc68e1d6a";
/** The scopes a terminal `gh auth login` requests. */
const DEVICE_SCOPES = "repo read:org gist workflow";
const DEVICE_HTTP_TIMEOUT_MS = 15_000;

/** The one login in flight. Module state like the runs store: one owner, one
 *  web-server process, one pending code at a time — a second start replaces
 *  the first, exactly as re-running `gh auth login` would. */
let pendingLogin: { deviceCode: string; interval: number; expiresAt: number } | null = null;

export interface DeviceLoginStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DeviceLoginPoll =
  | { status: "pending" }
  | { status: "connected"; login: string | null }
  /** Over — declined, expired, or gh refused the token. A new start is the retry. */
  | { status: "failed"; detail: string };

async function githubJson(url: string, body: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEVICE_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Ask github.com for a one-time code the owner will approve from any device. */
export async function startDeviceLogin(): Promise<DeviceLoginStart | { error: string }> {
  const data = await githubJson("https://github.com/login/device/code", {
    client_id: GH_OAUTH_CLIENT_ID,
    scope: DEVICE_SCOPES,
  });
  const deviceCode = data?.device_code;
  const userCode = data?.user_code;
  const verificationUri = data?.verification_uri;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    return { error: "Could not reach github.com to start the login. Check the network connection and try again." };
  }
  const interval = typeof data?.interval === "number" ? Math.max(5, data.interval) : 5;
  const expiresIn = typeof data?.expires_in === "number" ? data.expires_in : 900;
  pendingLogin = { deviceCode, interval, expiresAt: Date.now() + expiresIn * 1000 };
  return { userCode, verificationUri, expiresIn, interval };
}

/**
 * One poll of the login in flight. "pending" until the owner approves the
 * code on github.com; on approval the token goes straight to gh's stdin and
 * is forgotten.
 */
export async function pollDeviceLogin(): Promise<DeviceLoginPoll> {
  if (!pendingLogin) return { status: "failed", detail: "No login is in progress. Start again." };
  if (Date.now() > pendingLogin.expiresAt) {
    pendingLogin = null;
    return { status: "failed", detail: "The code expired before it was entered. Start again for a fresh one." };
  }
  const data = await githubJson("https://github.com/login/oauth/access_token", {
    client_id: GH_OAUTH_CLIENT_ID,
    device_code: pendingLogin.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (!data) return { status: "pending" };
  if (data.error === "authorization_pending") return { status: "pending" };
  if (data.error === "slow_down") {
    pendingLogin.interval += 5;
    return { status: "pending" };
  }
  if (typeof data.access_token !== "string") {
    pendingLogin = null;
    return {
      status: "failed",
      detail: data.error === "access_denied"
        ? "The login was declined on github.com."
        : "GitHub ended the login. Start again for a fresh code.",
    };
  }
  pendingLogin = null;
  const stored = await run("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], {
    input: data.access_token,
  });
  if (stored.code !== 0) {
    return { status: "failed", detail: `gh would not store the credential: ${(stored.stderr || stored.stdout).slice(0, 200)}` };
  }
  return { status: "connected", login: (await githubStatus()).login };
}

/** Forget the login in flight; the code on github.com simply goes unused. */
export function cancelDeviceLogin(): void {
  pendingLogin = null;
}

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

/**
 * What each refusal reads as when nothing more specific is known.
 *
 * It lives here, next to the type, because both halves of the problem need it:
 * `backupToGitHub` had two refusals that carried no detail at all — `no_gh` and
 * `not_connected`, the two branches #518 rewrote when it split `no_gh` away
 * from `gh_unreachable` — and the route answers `detail ?? reason`, so those two
 * reached the owner's error banner as the literal token `not_connected`.
 *
 * `Record<BackupFailure, string>` is the part that fixes the class rather than
 * the two instances: adding a reason without a sentence for it is a compile
 * error, not a bug an owner finds.
 */
export const BACKUP_MESSAGE: Record<BackupFailure, string> = {
  no_gh: "The GitHub CLI is not installed on this ClawBox, so there is nothing to back up with.",
  gh_unreachable: "Could not reach GitHub from this ClawBox. Check the network connection and try again.",
  not_connected: "No GitHub account is connected yet. Use Connect on the Coding Agent card to sign in first.",
  nothing_to_push: "The folder has no commits yet, so there is nothing to back up.",
  not_a_repo: "This folder is not its own git repository, so it cannot be backed up on its own.",
  failed: "The backup did not finish. Try again.",
};

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
function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<ChildResult> {
  return runChild(bin, args, {
    cwd: opts.cwd,
    input: opts.input,
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

/** Advice for a call that never left the box, and for one that tried to. */
const RETRY_LOCAL = "Try again.";
const RETRY_NETWORK = "Check this ClawBox's network connection and try again.";

/**
 * The refusal for a call that carried NO FINDING — one our own timer killed, or
 * one that never started at all. `inconclusive()` is the single question worth
 * asking here, and asking only `wasKilled()` is what this whole follow-up is
 * about: that helper is defined as `!r.startFailed && r.code === null`, so it
 * deliberately answers false for a spawn that failed, and every guard built on
 * it alone lets a `git` that could not be forked fall through to the line below
 * — which then reads the null code as a fact about the owner's folder.
 *
 * `transient` is what tells the route this is a fault to retry (503) and not a
 * request that cannot be satisfied (409).
 */
function noFinding(r: ChildResult, what: string, reach: "local" | "network"): BackupOutcome {
  // Only a call that actually STARTED can support a claim about the network.
  // A spawn that never began says nothing about GitHub — it is a fault on this
  // box — so it must carry neither `gh_unreachable` nor the "check your
  // connection" remedy. One expression, used for both, because the review on
  // this PR caught the reason and the advice disagreeing: the reason had it
  // right and the advice told an owner with an ENOMEM to go and check their
  // uplink, which is the wrong-remedy defect this whole change removes.
  const reachedNetwork = reach === "network" && !r.startFailed;
  return {
    pushed: false,
    reason: reachedNetwork ? "gh_unreachable" : "failed",
    detail: failureDetail(r, what, reachedNetwork ? RETRY_NETWORK : RETRY_LOCAL),
    transient: true,
  };
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
  // Never the raw `(stderr || stdout)`: a non-zero exit that wrote to neither
  // stream renders the empty string, and the route hands `detail` straight to
  // the owner's error banner. failureDetail() is the one place that guarantees
  // a sentence.
  if (r.code !== 0) return { ok: false, kind: "failed", detail: failureDetail(r, "Signing out of GitHub") };
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
  // Both of these carry a sentence for the same reason every other refusal in
  // this function does: the route answers `detail ?? reason` and the card shows
  // `data.error` verbatim, so a refusal with no detail reaches the owner as the
  // literal token `no_gh`.
  if (!status.installed) return { pushed: false, reason: "no_gh", detail: BACKUP_MESSAGE.no_gh };
  if (!status.connected) return { pushed: false, reason: "not_connected", detail: BACKUP_MESSAGE.not_connected };

  // Its OWN repository or nothing — the same rule as the per-run commit, and
  // for the same reason: a code project sits inside the ClawBox checkout.
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  // A probe that carried no finding is not evidence about the folder. Reading
  // one as evidence would tell the owner their repository is not a repository.
  if (inconclusive(top)) {
    return noFinding(top, "Reading the folder's git repository", "local");
  }
  if (top.code !== 0 || path.resolve(top.stdout || "") !== dir) {
    return { pushed: false, reason: "not_a_repo", detail: "This folder is not its own git repository." };
  }

  const head = await run("git", ["-C", dir, "rev-parse", "--verify", "HEAD"]);
  // "No commits yet" is a claim about the folder. A killed probe made no such
  // finding, and neither did one that never started — saying it would tell an
  // owner with a full history that their work is empty.
  if (inconclusive(head)) {
    return noFinding(head, "Reading the folder's commits", "local");
  }
  if (head.code !== 0) return { pushed: false, reason: "nothing_to_push", detail: "The folder has no commits yet." };

  const branchOut = await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  // The "main" fallback is a guess, and the push below turns it into
  // `--set-upstream origin main`. Fine when git actually answered and simply
  // had no name to give; wrong when the probe told us nothing, which would push
  // a `develop` checkout to `main` and bind it there over a transient fault.
  if (inconclusive(branchOut)) {
    return noFinding(branchOut, "Reading the folder's branch", "local");
  }
  const branch = branchOut.code === 0 && branchOut.stdout ? branchOut.stdout : "main";

  const hasRemote = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
  // The consequential one. A non-zero code here means "no remote yet", and the
  // branch below acts on it by CREATING a repository on GitHub. A killed probe
  // returns the same null code — and so does one that could not be forked at
  // all, which is why this asks `inconclusive` and not `wasKilled`. Reading
  // either as "no remote" would create a SECOND repository for a folder that
  // already has one: an irreversible guess made from a transient fault.
  if (inconclusive(hasRemote)) {
    return noFinding(hasRemote, "Reading the folder's git remote", "local");
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
      // A create that carried no finding is a FAULT, not a refusal: killed on
      // the uplink after three minutes, or never forked at all. Leaving the
      // reason as "failed" with no `transient` made the route answer 409, a
      // non-retryable client error, to its own retry advice. `wasKilled` alone
      // covered only the first half — a failed spawn fell through to the line
      // below and was reported as GitHub refusing, carrying runChild's
      // five-word "could not start" placeholder as the owner's message.
      if (inconclusive(create)) {
        return noFinding(create, "Creating the repository on GitHub", "network");
      }
      // GitHub itself refusing — a name already taken, a scope missing — IS a
      // request that cannot be satisfied as it stands. That one keeps its 409,
      // and failureDetail keeps its message from ever being blank.
      return { pushed: false, reason: "failed", detail: failureDetail(create, "Creating the repository on GitHub") };
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
    // the box, and one that produced no finding is the machine or the network,
    // not the request.
    if (inconclusive(push)) {
      return noFinding(push, "Pushing to GitHub", "network");
    }
    return { pushed: false, reason: "failed", detail: failureDetail(push, "Pushing to GitHub") };
  }
  return { pushed: true, repo, created, branch };
}
