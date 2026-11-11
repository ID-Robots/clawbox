/**
 * The web server's one way to start a root update step.
 *
 * Every caller used to run `/usr/bin/systemctl start
 * clawbox-root-update@<step>.service` with no sudo at all, and
 * `config/49-clawbox-updates.pkla` authorised it with
 * `org.freedesktop.systemd1.manage-units` and no unit condition — `.pkla` on
 * polkit 0.105 (what JetPack ships) cannot express one. That action is what
 * systemd checks for `StartTransientUnit`, so it was `systemd-run /bin/sh -c …`:
 * arbitrary root, no password, for the account the web server, the in-UI
 * terminal and the agent's shell all run as. It made the sudoers allow-list
 * bypassable, which is why it is gone rather than narrowed (TASK-539).
 *
 * sudoers can express a scope, so the operation goes through one root-owned
 * entrypoint instead: `/usr/local/libexec/clawbox/clawbox-run-root-step.sh`,
 * granted once, which validates the step against WEB_ROOT_STEPS and builds the
 * unit name itself. The root dispatcher validates it again on the far side.
 */
import { execFile as execFileCb } from "child_process";
import fs from "fs";
import { promisify } from "util";
import path from "./runtime-path";
import { X64_DESKTOP_ROOT_STEPS, X64_INSTALL_ROOT_STEPS, rootStepNotImplementedMessage, type X64RootSide } from "./root-steps";

const execFile = promisify(execFileCb);

/** Installed by install.sh::install_root_libexec, root:root 0755. */
export const ROOT_STEP_LAUNCHER = "/usr/local/libexec/clawbox/clawbox-run-root-step.sh";

/**
 * Either file makes this an x64 desktop: the integration package's, or the
 * record install-x64.sh writes beside its root dispatcher (X64_INSTALL_FILE in
 * x64-integration.ts — spelled out here because several suites mock that
 * module whole). install-x64.sh never writes the first, so checking it alone
 * sent an install-x64.sh PC to the appliance's install.sh — whose
 * systemd_services step would lay Jetson units over the desktop's.
 */
const X64_HOST_FILES = ["/etc/clawbox/x64-integration.env", "/etc/clawbox/x64.env"] as const;

/** Which x86 install's root side this PC has; the appliance has neither. */
type X64Host = X64RootSide;

/**
 * The x86 root side this PC has, or null on the appliance. The integration
 * package's contract wins over install-x64.sh's record, as it does for every
 * other caller (x64-integration.ts).
 */
function x64Host(): X64Host | null {
  try {
    // Two fixed paths under /etc, never the project: the comment keeps
    // Turbopack from tracing these calls across the whole checkout (data/
    // included), which is what failed the build (scripts/check-build-isolation.sh).
    const [desktop, install] = X64_HOST_FILES.map((file) => fs.existsSync(/* turbopackIgnore: true */ file));
    if (desktop) return "desktop";
    if (install) return "install";
  } catch {
    // Unreadable: answer as the appliance, as the repair command always has.
  }
  return null;
}

/**
 * Whether this PC's root side has `step` at all (TASK-2418): null on the
 * appliance, whose install.sh implements every step on WEB_ROOT_STEPS; on an
 * x86 PC, whether that install implements it (root-steps.ts says which).
 */
export function rootStepImplementedHere(step: string): boolean | null {
  const host = x64Host();
  if (!host) return null;
  return (host === "desktop" ? X64_DESKTOP_ROOT_STEPS : X64_INSTALL_ROOT_STEPS).includes(step);
}

/**
 * The ONE command that puts the root side of the launcher contract back — the
 * launcher, the root dispatcher and the sudoers grant — from the code on disk.
 * It is what install.sh itself prints when a root step refuses; the x64 desktop
 * install has its own installer and its own step for the same contract.
 */
export function rootStepRepairCommand(projectDir: string = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox"): string {
  return x64Host() !== null
    ? `sudo bash ${path.join(projectDir, "install-x64.sh")} --step root_step_contract`
    : `sudo bash ${path.join(projectDir, "install.sh")} --step systemd_services`;
}

type ExecError = Error & { code?: number | string; stderr?: string; killed?: boolean; signal?: string | null };

/**
 * Why the launcher could not even be asked — or `null` when it WAS asked and
 * the failure is the step's own (a unit that failed, a timeout), which callers
 * already explain from the unit's journal.
 *
 * Every one of these means the web server and the box's root side disagree
 * about how a root step is started, which is what an update cut short between
 * installing one half and the other leaves behind. Shown raw, the owner read
 * `Command failed: /usr/bin/sudo -n … sudo: a password is required` — or, from
 * a build older than the launcher, polkit's "Interactive authentication
 * required" — and neither says what to do (TASK-1316).
 */
function launcherRefusal(err: ExecError): string | null {
  if (err.killed) return null;
  const said = `${err.stderr ?? ""}\n${err.message ?? ""}`;
  // sudo's own words, so a step whose unit printed the same phrase is not read
  // as a missing launcher.
  if (/^sudo:[^\n]*(command not found|No such file or directory)/im.test(said)) {
    return `its root-step launcher (${ROOT_STEP_LAUNCHER}) is not installed`;
  }
  if (/step not permitted from the web server/i.test(said)) {
    return "the root-step launcher installed on this box is older than this build and does not know the step";
  }
  if (/a password is required|a terminal is required|no tty present|not allowed to execute|is not in the sudoers file|may not run sudo/i.test(said)) {
    return "the web server is not allowed to start root steps (the sudoers grant for the root-step launcher is missing)";
  }
  if (/Interactive authentication required/i.test(said)) {
    return "the web server tried to start a root step in a way this box no longer allows";
  }
  return null;
}

/**
 * The launcher could not be asked at all. Carries the original error's
 * properties (`code`, `stderr`, `killed`) so a caller that reads them keeps
 * working, and `rootStepUnavailable` so one that must not dress the failure up
 * with an older journal line can tell — duck-typed on purpose: several route
 * tests mock this module whole.
 */
export class RootStepUnavailableError extends Error {
  readonly rootStepUnavailable = true;
  readonly step: string;
  readonly repairCommand: string;
  code?: number | string;
  stderr?: string;
  killed?: boolean;

  constructor(step: string, what: string, cause: ExecError) {
    const repair = rootStepRepairCommand();
    super(
      `This ClawBox could not start its root step "${step}": ${what}. `
      + "The web server and the box's system permissions are out of step — usually an update that was cut short. "
      + `To repair it, open the Terminal app and run:  ${repair}  — then try again.`,
    );
    this.name = "RootStepUnavailableError";
    this.step = step;
    this.repairCommand = repair;
    this.code = cause.code;
    this.stderr = cause.stderr;
    this.killed = cause.killed;
  }
}

/**
 * The launcher refused a step this PC's root side does not implement at all
 * (TASK-2418) — not an update cut short, so there is no repair command to
 * name, and the message says so instead of sending the owner to one that
 * would change nothing. `rootStepUnavailable` like the error above (the
 * launcher could not be asked, so no journal line of an earlier run belongs
 * to this one); `rootStepNotImplemented` for a caller that must tell the two
 * apart. Carries no `repairCommand`.
 */
export class RootStepNotImplementedError extends Error {
  readonly rootStepUnavailable = true;
  readonly rootStepNotImplemented = true;
  readonly step: string;
  code?: number | string;
  stderr?: string;
  killed?: boolean;

  constructor(step: string, host: X64Host, cause: ExecError) {
    super(rootStepNotImplementedMessage(step, host));
    this.name = "RootStepNotImplementedError";
    this.step = step;
    this.code = cause.code;
    this.stderr = cause.stderr;
    this.killed = cause.killed;
  }
}

/**
 * Start `clawbox-root-update@<step>.service`.
 *
 * `sudo -n`, never a bare `sudo`: on a device whose allow-list is missing this
 * grant the call has to fail in milliseconds, not block a route handler on a
 * password prompt nobody can answer. The launcher clears a previous failure
 * itself, so callers do not need their own `reset-failed`.
 *
 * A launcher that is missing, not granted or too old for the step is thrown as
 * a {@link RootStepUnavailableError}, whose message names the one Terminal
 * command that repairs it — unless this is an x86 PC whose install does not
 * implement the step at all, which no command repairs: that is a
 * {@link RootStepNotImplementedError}. Any other failure is rethrown untouched.
 */
export async function startRootStep(
  step: string,
  opts: { noBlock?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const argv = ["-n", ROOT_STEP_LAUNCHER];
  if (opts.noBlock) argv.push("--no-block");
  argv.push(step);
  try {
    // A cwd of its own, never the web server's: that is `.next/standalone`,
    // which a rebuild replaces under a server still running (a hand-run
    // `bun run build`, the in-app update's own build before its restart),
    // and a child spawned from a deleted directory dies on `getcwd` before
    // the launcher runs. The launcher is an absolute path and reads nothing
    // relative, so `/` is the honest working directory.
    await execFile("/usr/bin/sudo", argv, { cwd: "/", timeout: opts.timeoutMs ?? 30_000 });
  } catch (err) {
    const what = err instanceof Error ? launcherRefusal(err as ExecError) : null;
    if (what) {
      // Asked only once the launcher has refused: the step's own run, and the
      // updater's reading of it, are exactly what they were.
      const host = x64Host();
      if (host && rootStepImplementedHere(step) === false) {
        throw new RootStepNotImplementedError(step, host, err as ExecError);
      }
      throw new RootStepUnavailableError(step, what, err as ExecError);
    }
    throw err;
  }
}
