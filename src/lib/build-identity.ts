/**
 * What is actually running on this box, and does it match its own source?
 *
 * Three facts, never assumed to agree:
 *   * the DEPLOYED BUILD — the commit stamped into `.next/build-info.json` by
 *     scripts/write-build-info.mjs at build time;
 *   * the CHECKOUT — what `git rev-parse HEAD` says in /home/clawbox/clawbox;
 *   * the PIN — the tested branch the device is supposed to converge on
 *     (`.update-branch`, the mechanism install.sh writes and the updater reads).
 *
 * A QA box was found serving a build from `1b21187` against a checkout of
 * `d285cfd`: two features 404'd although their source was on disk, and the
 * build served four routes that existed in no commit on the checked-out
 * branch. Nothing on the device could say any of that, so every conclusion
 * drawn from reading its source was unsound.
 *
 * The comparisons live in `computeDrift`, which is pure — it takes facts and
 * returns verdicts, so the interesting cases are unit-testable without a
 * device, a build, or a git repository.
 */
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { readFile, stat } from "fs/promises";
import path from "path";
import { isSafeBranch } from "./update-branch";

const execShell = promisify(execCb);

export const PROJECT_ROOT =
  process.env.CLAWBOX_ROOT
  || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");

/** Written by scripts/write-build-info.mjs. Every field can be null: a build that could not identify itself still says so honestly. */
export interface BuildInfo {
  commit: string | null;
  shortCommit: string | null;
  branch: string | null;
  dirty: boolean | null;
  committedAt: string | null;
  builtAt: string | null;
  buildId: string | null;
  node: string | null;
  bun: string | null;
  packageVersion: string | null;
  hermesPin: string | null;
  openclawPin: string | null;
}

export interface CheckoutInfo {
  commit: string | null;
  shortCommit: string | null;
  branch: string | null;
  /** `git status --porcelain` is non-empty — modified or untracked files (ignored paths excluded by git). */
  dirty: boolean | null;
  committedAt: string | null;
}

export interface PinInfo {
  /** The branch recorded in `.update-branch`, or null when the device carries no pin. */
  branch: string | null;
  /** Where the branch came from: the pin file, or (unpinned) whatever the updater would resolve today. */
  source: "pin-file" | "checkout-branch" | "default" | "unknown";
  /** Locally-known tip of `origin/<branch>` — resolved without fetching, so it can lag origin. */
  commit: string | null;
  /** False when `.update-branch` is missing or unusable — the case AUTO-REPIN repairs. */
  pinned: boolean;
}

export type DriftState = "match" | "drift" | "unknown";

export interface DriftReport {
  /** Is the served build reproducible from the code on disk? */
  buildVsCheckout: DriftState;
  /** Is the code on disk the tested commit the fleet is pinned to? */
  checkoutVsPin: DriftState;
  /** True when either comparison came back "drift". Drives the UI banner and the updater warning. */
  detected: boolean;
  /**
   * Plain-language, one line per problem, safe to show a customer and to write
   * into the update log. Machine-readable `codes` travel alongside so the UI
   * can translate rather than parse English.
   */
  reasons: string[];
  codes: DriftCode[];
}

export type DriftCode =
  | "build-from-other-commit"
  | "build-info-not-for-deployed-assets"
  | "build-predates-checkout"
  | "build-unstamped"
  | "checkout-dirty"
  | "checkout-behind-pin"
  | "no-pin";

export interface DriftInputs {
  build: BuildInfo | null;
  /** `.next/BUILD_ID` as actually deployed, for the cross-check against `build.buildId`. */
  deployedBuildId: string | null;
  /** builtAt, or the BUILD_ID mtime when the build carries no stamp at all. */
  buildTimestampMs: number | null;
  checkout: CheckoutInfo;
  pin: PinInfo;
  /**
   * Does the checkout contain scripts/write-build-info.mjs? If it does and the
   * deployed build has no stamp, the build necessarily predates this checkout —
   * which is drift, not "unknown". That inference is the only thing that lets
   * a device upgraded FROM a pre-stamp build report its own condition instead
   * of shrugging.
   */
  stamperInCheckout: boolean;
}

export interface BuildIdentity {
  build: BuildInfo | null;
  deployedBuildId: string | null;
  checkout: CheckoutInfo;
  pin: PinInfo;
  drift: DriftReport;
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

/**
 * Pure comparison of the three facts. No I/O, no clock, no git.
 */
export function computeDrift(input: DriftInputs): DriftReport {
  const { build, deployedBuildId, buildTimestampMs, checkout, pin, stamperInCheckout } = input;
  const reasons: string[] = [];
  const codes: DriftCode[] = [];

  let buildVsCheckout: DriftState = "unknown";

  if (build?.buildId && deployedBuildId && build.buildId !== deployedBuildId) {
    // The stamp describes some other asset set. Whatever commit it names is
    // not evidence about what this device serves — treat it as drift outright
    // rather than letting a matching commit field vouch for the wrong build.
    buildVsCheckout = "drift";
    codes.push("build-info-not-for-deployed-assets");
    reasons.push(
      `The build record describes build ${build.buildId} but ${deployedBuildId} is what is deployed — the running build is unidentified.`,
    );
  } else if (build?.commit && checkout.commit) {
    if (build.commit === checkout.commit) {
      buildVsCheckout = "match";
    } else {
      buildVsCheckout = "drift";
      codes.push("build-from-other-commit");
      reasons.push(
        `This box is running a build made from ${short(build.commit)} but the code on disk is ${short(checkout.commit)} — run Update to realign.`,
      );
    }
  } else if (!build?.commit) {
    if (stamperInCheckout) {
      buildVsCheckout = "drift";
      codes.push("build-unstamped");
      reasons.push(
        "The deployed build carries no build record, so it was made before the code now on disk — run Update to rebuild from this checkout.",
      );
    } else if (
      buildTimestampMs !== null
      && checkout.committedAt
      && Date.parse(checkout.committedAt) > buildTimestampMs
    ) {
      buildVsCheckout = "drift";
      codes.push("build-predates-checkout");
      reasons.push(
        "The code on disk is newer than the deployed build — run Update to rebuild.",
      );
    }
  }

  // A dirty tree is drift on an appliance: an untracked file under src/app/ is
  // a route the next build would serve and this one does not. Reported
  // separately so a matching commit is not quietly downgraded by it.
  if (checkout.dirty) {
    codes.push("checkout-dirty");
    reasons.push(
      "The code on disk has uncommitted changes, so it no longer matches any commit.",
    );
    if (buildVsCheckout === "match") buildVsCheckout = "drift";
  }

  let checkoutVsPin: DriftState = "unknown";
  if (!pin.pinned) {
    codes.push("no-pin");
    reasons.push(
      "This box records no tested branch to update to — the next update will pin it automatically.",
    );
  } else if (pin.commit && checkout.commit) {
    if (pin.commit === checkout.commit) {
      checkoutVsPin = "match";
    } else {
      checkoutVsPin = "drift";
      codes.push("checkout-behind-pin");
      reasons.push(
        `The code on disk (${short(checkout.commit)}) is not the tested commit for ${pin.branch} (${short(pin.commit)}).`,
      );
    }
  }

  return {
    buildVsCheckout,
    checkoutVsPin,
    detected: buildVsCheckout === "drift" || checkoutVsPin === "drift",
    reasons,
    codes,
  };
}

/**
 * Run git and return its trimmed output, or null if the command FAILED.
 *
 * Empty output is not failure. `git status --porcelain` answers with an empty
 * string on a clean tree, and folding that into null made every healthy box
 * report `dirty: null` — "we could not tell" — when the truth was "nothing is
 * modified". Callers that cannot meaningfully receive an empty string
 * normalise it themselves.
 */
async function git(projectDir: string, args: string): Promise<string | null> {
  try {
    const { stdout } = await execShell(
      `git -c safe.directory=${projectDir} -C ${projectDir} ${args}`,
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/** git output where an empty answer is as useless as a failure (a SHA, a branch name). */
async function gitValue(projectDir: string, args: string): Promise<string | null> {
  return (await git(projectDir, args)) || null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the running server's build lives.
 *
 * The service runs with cwd=`.next/standalone`, so the assets it serves are the
 * ones under `.next/standalone/.next` — NOT `.next`, which can be a newer
 * half-finished build. Prefer the standalone tree and fall back to `.next` for
 * `next dev` and for CI, where no standalone copy exists.
 */
export async function resolveBuildDir(projectDir: string): Promise<string> {
  const standalone = path.join(projectDir, ".next", "standalone", ".next");
  if (await fileExists(path.join(standalone, "BUILD_ID"))) return standalone;
  return path.join(projectDir, ".next");
}

async function readPin(projectDir: string): Promise<PinInfo> {
  let branch: string | null = null;
  let source: PinInfo["source"] = "unknown";
  let pinned = false;

  try {
    const raw = (await readFile(path.join(projectDir, ".update-branch"), "utf-8")).trim();
    if (raw && isSafeBranch(raw)) {
      branch = raw;
      source = "pin-file";
      pinned = true;
    }
  } catch {
    // No pin file — fall through to what the updater would resolve today.
  }

  if (!branch) {
    const current = await git(projectDir, "symbolic-ref --short HEAD");
    if (current && current !== "main" && isSafeBranch(current)) {
      branch = current;
      source = "checkout-branch";
    } else {
      branch = "main";
      source = "default";
    }
  }

  // Deliberately no `git fetch`: this is read on every About-screen open, and a
  // network round-trip there would make the page hang on an offline box. The
  // updater fetches before it acts; here we report the tested commit as far as
  // this device currently knows it.
  const commit = branch ? await gitValue(projectDir, `rev-parse --verify --quiet origin/${branch}`) : null;

  return { branch, source, commit, pinned };
}

/** Gather the three facts and compare them. Never throws — an unreadable device reports "unknown", not a 500. */
export async function collectBuildIdentity(
  projectDir: string = PROJECT_ROOT,
): Promise<BuildIdentity> {
  const buildDir = await resolveBuildDir(projectDir);

  const [build, deployedBuildId, commit, branch, status, committedAt, pin, stamperInCheckout] =
    await Promise.all([
      readJson<BuildInfo>(path.join(buildDir, "build-info.json")),
      readFile(path.join(buildDir, "BUILD_ID"), "utf-8").then((s) => s.trim() || null).catch(() => null),
      gitValue(projectDir, "rev-parse HEAD"),
      gitValue(projectDir, "rev-parse --abbrev-ref HEAD"),
      git(projectDir, "status --porcelain"),
      gitValue(projectDir, "log -1 --format=%cI"),
      readPin(projectDir),
      fileExists(path.join(projectDir, "scripts", "write-build-info.mjs")),
    ]);

  // A stamped build dates itself; an unstamped one is dated by its BUILD_ID's
  // mtime, which is the only timestamp a pre-stamp build ever had.
  let buildTimestampMs: number | null = build?.builtAt ? Date.parse(build.builtAt) : null;
  if (buildTimestampMs === null || Number.isNaN(buildTimestampMs)) {
    buildTimestampMs = await stat(path.join(buildDir, "BUILD_ID"))
      .then((s) => s.mtimeMs)
      .catch(() => null);
  }

  const checkout: CheckoutInfo = {
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
    branch,
    dirty: status === null ? null : status.length > 0,
    committedAt,
  };

  return {
    build,
    deployedBuildId,
    checkout,
    pin,
    drift: computeDrift({ build, deployedBuildId, buildTimestampMs, checkout, pin, stamperInCheckout }),
  };
}
