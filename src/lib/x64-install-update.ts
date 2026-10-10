/**
 * The update on a PC installed with install-x64.sh (and no integration package).
 *
 * That PC's root side is scripts/x64-migration/clawbox-x64-root-step.sh behind
 * clawbox-root-update@<step>.service, and it is a much smaller contract than the
 * appliance's install.sh: no `bootstrap_updater`, no `rebuild_reboot`, no Jetson
 * gateway-maintenance helper — and an update must never end by rebooting
 * somebody's desktop. The updater (src/lib/updater.ts) therefore routes the two
 * steps that move and rebuild the checkout through the desktop OWNER, which is
 * the account this web server already runs as, and keeps every other root step
 * best-effort: a step the installed root helper cannot run is skipped with one
 * warning that names the command which installs a newer helper, never a red
 * update.
 *
 * This file holds the parts that are not the step machinery: the journal
 * classifier, the owner-facing card, the rebuild and the UI restart.
 */
import { execFile as execFileCb } from "child_process";
import { existsSync, promises as fsp } from "fs";
import { promisify } from "util";
import path from "./runtime-path";

const execFile = promisify(execFileCb);

/** The warning card for root steps this PC's helper could not run. */
export const X64_ROOT_STEPS_SKIPPED = "x64-root-steps-skipped";

/**
 * The ONE command that installs this checkout's root helpers on an x64 PC — the
 * launcher, the dispatcher, the root-owned installer copy and the unit template
 * (install-x64.sh::step_root_step_contract). Root never runs the checkout
 * itself, so a newer dispatcher reaches the PC only when its owner runs this.
 */
export function x64RootContractRepairCommand(projectDir: string): string {
  return `sudo bash ${path.join(projectDir, "install-x64.sh")} --step root_step_contract`;
}

/**
 * Why the installed root helper could not run a step, read off what THIS run of
 * the unit wrote — or null when it did run the step and the step itself failed,
 * which stays a failure.
 *
 * - `not-implemented`: the dispatcher has no such step (exit 64). This is what
 *   every pre-fix x64 PC answers for set_timezone, gateway_setup and post_update.
 * - `installer-missing`: the root-owned installer copy it forwards to is gone
 *   (exit 69).
 * - `installer-user`: the forwarded installer could not tell which account it
 *   installs for. The dispatcher shipped before this fix ran it from a systemd
 *   unit without CLAWBOX_USER, where `logname` and SUDO_USER are both empty, so
 *   EVERY forwarded step stopped at its first line.
 * - `installer-step`: the installer copy predates the step the dispatcher
 *   forwarded.
 */
export type X64RootStepGap = "not-implemented" | "installer-missing" | "installer-user" | "installer-step" | "launcher";

const X64_ROOT_STEP_GAPS: ReadonlyArray<readonly [X64RootStepGap, RegExp]> = [
  ["not-implemented", /^clawbox-root-step: step '[a-z0-9_]+' has no implementation on the x64 install$/m],
  ["installer-missing", /^clawbox-root-step: \/\S+ not found$/m],
  ["installer-user", /^Error: could not resolve an unprivileged install user\b/m],
  ["installer-step", /^Unknown step: [a-z0-9_]+$/m],
];

/** Anchored to whole lines: a step that merely QUOTES one of these did not say it. */
export function classifyX64RootStepGap(journal: string): X64RootStepGap | null {
  const lines = journal.split(/\r?\n/).map((line) => line.trim()).join("\n");
  for (const [gap, pattern] of X64_ROOT_STEP_GAPS) {
    if (pattern.test(lines)) return gap;
  }
  return null;
}

/**
 * The same answer from the unit's exit status, ONLY for a run whose journal this
 * account could not read at all: the x64 dispatcher exits 64 for a step it has
 * no implementation of and 69 when its installer copy is missing. A journal
 * that can be read is the better witness — a step that ran can exit with any
 * code its last command chose.
 */
export function classifyX64RootStepExit(status: string | null): X64RootStepGap | null {
  if (status === "64") return "not-implemented";
  if (status === "69") return "installer-missing";
  return null;
}

/** The card for the steps one half of a run had to skip, in the owner's words. */
export function x64SkippedStepsWarning(labels: readonly string[], projectDir: string): string {
  const one = labels.length === 1;
  const list = labels.map((label) => `“${label}”`).join(", ");
  return `This PC's root helper could not run ${one ? "one system step" : `${labels.length} system steps`}, `
    + `so ${one ? "it was" : "they were"} skipped: ${list}. The rest of the update carried on without `
    + `${one ? "it" : "them"}. To let future updates run ${one ? "it" : "them"}, open the Terminal and run once: `
    + x64RootContractRepairCommand(projectDir);
}

/**
 * The environment the owner's rebuild runs in: an allow-list, not this
 * process's environment minus a few names.
 *
 * The web server's own environment is wrong for a build in ways that are easy to
 * miss: NODE_ENV=production makes `bun install` leave out the devDependencies
 * `next build` needs, and the standalone server exports `__NEXT_PRIVATE_*`
 * values describing the build that is RUNNING, which a child `next build` would
 * read as its own. install-x64.sh and install.sh both build from a fresh login
 * shell for the same reason; this is the same clean slate.
 */
const OWNER_ENV_KEYS = [
  "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR",
  "CLAWBOX_HOME_DIR", "CLAWBOX_OPENCLAW_HOME",
] as const;

export function ownerBuildEnv(source: NodeJS.ProcessEnv, projectDir: string): NodeJS.ProcessEnv {
  // No NODE_ENV — deliberately; `next build` sets its own.
  const env: Record<string, string> = {};
  for (const key of OWNER_ENV_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  // The node this server runs on first, then bun's own install: the unit's PATH
  // already carries both, but a build must not depend on that.
  const extra = [path.dirname(process.execPath)];
  if (env.HOME) extra.push(path.join(env.HOME, ".bun", "bin"));
  env.PATH = [...extra, env.PATH || "/usr/local/bin:/usr/bin:/bin"].join(":");
  env.CLAWBOX_ROOT = projectDir;
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env as unknown as NodeJS.ProcessEnv;
}

function bunBinary(env: NodeJS.ProcessEnv): string {
  const installed = env.HOME ? path.join(env.HOME, ".bun", "bin", "bun") : "";
  return installed && existsSync(installed) ? installed : "bun";
}

/** The line of a failed command's output that says why, kept short for a card. */
function failureLine(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const error = [...lines].reverse().find((line) => /\berror\b/i.test(line));
  return (error ?? lines.at(-1) ?? "").slice(0, 300);
}

function outputOf(err: unknown): string {
  const e = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [e.stdout, e.stderr, e.message].filter((part) => typeof part === "string" && part).join("\n");
}

/**
 * A file `next build` was tracing changed while it ran — the one build failure
 * a second attempt repairs (install.sh's run_next_build, install-x64.sh's
 * step_build: the same rule, copied).
 */
function tracedFileRace(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /ENOENT.*copyfile/.test(line) && !/Failed to copy traced files for/.test(line));
}

export interface OwnerRebuildOptions {
  /** What the rebuild is doing now, for the step's detail line. */
  onProgress?: (detail: string) => void;
  /** Test seam: the bun to run. Defaults to the owner's ~/.bun/bin/bun, then PATH. */
  bun?: string;
  /** Test seam: the environment the commands start from. */
  env?: NodeJS.ProcessEnv;
}

const INSTALL_TIMEOUT_MS = 900_000;
const BUILD_TIMEOUT_MS = 1_200_000;

/**
 * Rebuild the checkout as its owner, with the build that is serving now kept
 * until a new one is proved — install.sh's do_rebuild, minus the parts that
 * need root.
 *
 * The previous build is parked at `.next-old`, the name do_rebuild uses, so a
 * server that dies mid-build comes back on it: production-server.js reclaims a
 * parked build whenever `.next/standalone/server.js` is missing. Any failure
 * puts it back before this throws, and the error says which stage failed.
 *
 * The server keeps running from the build it loaded while this runs, so the
 * update screen stays up; pages it has not opened yet may fail until the
 * restart that follows. That is less than the appliance, whose dashboard is
 * stopped for the whole build.
 */
export async function rebuildAsOwner(projectDir: string, options: OwnerRebuildOptions = {}): Promise<void> {
  const env = ownerBuildEnv(options.env ?? process.env, projectDir);
  const bun = options.bun ?? bunBinary(env);
  const progress = options.onProgress ?? (() => {});
  const buildDir = path.join(projectDir, ".next");
  const keptDir = path.join(projectDir, ".next-old");
  const run = (file: string, args: string[], timeout: number) =>
    execFile(file, args, { cwd: projectDir, env, timeout, maxBuffer: 64 * 1024 * 1024 });

  let stage = "bun install";
  let parked = false;
  try {
    progress("Installing packages");
    await run(bun, ["install"], INSTALL_TIMEOUT_MS);

    stage = "the node-pty rebuild";
    try {
      await run(process.execPath, ["-e", "require('node-pty')"], 60_000);
    } catch {
      progress("Rebuilding the terminal's native module");
      const npm = path.join(path.dirname(process.execPath), "npm");
      await execFile(existsSync(npm) ? npm : "npm", ["rebuild", "node-pty", "--foreground-scripts"], {
        cwd: projectDir,
        env: { ...env, npm_config_python: "/usr/bin/python3" },
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
    }

    stage = "setting the previous build aside";
    await fsp.rm(keptDir, { recursive: true, force: true });
    if (existsSync(buildDir)) {
      await fsp.rename(buildDir, keptDir);
      parked = true;
    }

    stage = "bun run build";
    progress("Building ClawBox");
    for (let attempt = 1; ; attempt++) {
      try {
        await run(bun, ["run", "build"], BUILD_TIMEOUT_MS);
        break;
      } catch (err) {
        if (attempt >= 2 || !tracedFileRace(outputOf(err))) throw err;
        console.warn("[Updater] a file the build was tracing changed while it ran — building once more");
      }
    }

    stage = "checking the new build";
    const buildId = (await fsp.readFile(path.join(buildDir, "BUILD_ID"), "utf8").catch(() => "")).trim();
    if (!buildId) throw new Error("the build exited 0 but left no .next/BUILD_ID");
    if (!existsSync(path.join(buildDir, "standalone", "server.js"))) {
      throw new Error("the build produced no .next/standalone/server.js — nothing the dashboard can load");
    }
    const identity = path.join(projectDir, "scripts", "verify-build-identity.sh");
    if (existsSync(identity)) {
      await run("/bin/bash", [identity, "--project-dir", projectDir, "--quiet"], 120_000).catch(() => {
        throw new Error("the build on disk does not match the checked-out commit");
      });
    }
  } catch (err) {
    const why = (failureLine(outputOf(err)) || (err instanceof Error ? err.message : String(err)))
      .replace(/[.\s]+$/, "");
    let restore = "";
    if (parked) {
      try {
        await fsp.rm(buildDir, { recursive: true, force: true });
        await fsp.rename(keptDir, buildDir);
        restore = " The previous build was put back.";
      } catch (restoreErr) {
        restore = ` The previous build could not be put back (${restoreErr instanceof Error ? restoreErr.message : restoreErr});`
          + " it is still at .next-old, and the next start of the dashboard reclaims it.";
      }
    }
    throw new Error(`${stage} did not succeed: ${why}.${restore}`);
  }

  // Never fatal: a parked tree that could not be removed is harmless, and the
  // next rebuild clears it first.
  await fsp.rm(keptDir, { recursive: true, force: true }).catch((err) => {
    console.warn("[Updater] could not remove the previous build at .next-old:", err instanceof Error ? err.message : err);
  });
}

const RESTART_SIGNAL_DELAY_MS = 1_500;
const RESTART_GIVE_UP_MS = 60_000;

/**
 * Restart ONLY the dashboard, as its own account, by ending this process.
 *
 * install-x64.sh writes clawbox-setup.service with `Restart=always`, and its
 * sudoers grant carries no restart for that unit — so the unprivileged way to
 * restart the UI is to exit and let systemd start it again on the new build.
 * SIGTERM rather than `process.exit`, so production-server.js closes its
 * listeners the way it does for any stop. The short delay lets the step's state
 * and log lines leave first.
 *
 * Never returns normally: the restart is the success path, and a process still
 * here a minute later is one systemd did not replace.
 */
export async function restartUiProcess(): Promise<never> {
  console.log("[Updater] restarting the ClawBox UI on the new build (systemd brings clawbox-setup back)");
  setTimeout(() => process.kill(process.pid, "SIGTERM"), RESTART_SIGNAL_DELAY_MS);
  await new Promise((resolve) => setTimeout(resolve, RESTART_GIVE_UP_MS));
  throw new Error(
    "The new build is in place, but ClawBox did not restart on its own. "
    + "Restart it from the Terminal with: sudo systemctl restart clawbox-setup — the update continues after the restart.",
  );
}
