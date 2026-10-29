import fs from "fs";
import path from "./runtime-path";

const INTEGRATION_FILE = "/etc/clawbox/x64-integration.env";

/**
 * Written root-owned (0644) by install-x64.sh::step_root_step_contract, with
 * CLAWBOX_USER, PROJECT_DIR and ROOT_INSTALLER — the same file that PC's root
 * dispatcher (scripts/x64-migration/clawbox-x64-root-step.sh) parses.
 */
export const X64_INSTALL_FILE = "/etc/clawbox/x64.env";

/**
 * The PROJECT_DIR a root-owned host file names, or null when the file is not
 * there. Never source the host file as shell code: it is parsed, one key, and
 * anything that is not a small root-owned plain file is refused outright —
 * a file another account can write is not evidence of what root installed.
 */
function readRootOwnedHostFile(file: string, label: string): string | null {
  const subject = label.charAt(0).toUpperCase() + label.slice(1);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read ${label}; repair it before updating.`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) {
      throw new Error(`${subject} must be a small, root-owned file without group or other write access.`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readRootOwnedProjectDir(file: string, label: string): string | null {
  const text = readRootOwnedHostFile(file, label);
  if (text === null) return null;
  const subject = label.charAt(0).toUpperCase() + label.slice(1);
  const projects = text.split(/\r?\n/).filter((line) => line.startsWith("PROJECT_DIR="));
  const match = projects.length === 1 && /^PROJECT_DIR=([A-Za-z0-9_./-]+)$/.exec(projects[0]);
  if (!match || !path.isAbsolute(match[1])) {
    throw new Error(`${subject} has no valid project directory; repair it before updating.`);
  }
  return match[1];
}

/**
 * The existing-desktop package owns its gateway maintenance and rollback.
 * Detect that installed contract, not the CPU: ordinary x64/ARM installs
 * still use the appliance updater. Never source the host file as shell code.
 */
export function hasX64DesktopIntegration(projectDir: string): boolean {
  const configured = readRootOwnedProjectDir(INTEGRATION_FILE, "the installed x64 integration");
  return configured !== null && path.resolve(configured) === path.resolve(projectDir);
}

/**
 * A PC installed with install-x64.sh, for THIS checkout.
 *
 * Its root side is the x64 dispatcher, not install.sh: there is no
 * bootstrap_updater or rebuild_reboot behind clawbox-root-update@, no Jetson
 * gateway-maintenance helper, and a reboot is never the way to end an update on
 * somebody's desktop. The updater reads this to route those steps through the
 * desktop owner instead (src/lib/x64-install-update.ts). The same gate as the
 * integration file above: root-owned, no group/other write, and a PROJECT_DIR
 * that names this checkout — another checkout on the same PC is not the one
 * the installer set up.
 *
 * Checked AFTER hasX64DesktopIntegration by every caller: a PC with the
 * integration package installed takes that package's contract.
 */
export function hasX64Install(projectDir: string): boolean {
  const configured = readRootOwnedProjectDir(X64_INSTALL_FILE, `the x64 install record (${X64_INSTALL_FILE})`);
  return configured !== null && path.resolve(configured) === path.resolve(projectDir);
}

/**
 * The wait budget the updater gives the desktop integration's `openclaw_install`
 * step, in place of the appliance's five minutes.
 *
 * On the desktop that step REPLACES the core when the pin moves (see
 * `scripts/x64-migration/clawbox-x64-step.sh`): it writes a verified archive
 * of the state with the installed core, copies the databases it would have to
 * put back, and runs the new core's migration — over agent databases that
 * measure in gigabytes on the desktop this package was built for. The root
 * unit's own ceiling (`TimeoutStartSec=7200` in
 * `config/clawbox-root-update@.service`) is what bounds the step; this budget
 * only has to outlast an honest run, because an overrun of the client's wait
 * is reported as the step's failure while the unit carries on migrating in
 * the background — and a Retry then meets a core already replaced.
 *
 * 110 minutes, just under that ceiling: the step's archive is the whole
 * state directory less the workspaces (`backup create` takes no narrower
 * exclusion), which measured 48 GB on the desktop this package was built
 * for — tens of minutes to write and verify before the migration has even
 * started — so an hour was the budget most likely to be the thing that
 * failed an honest run.
 */
export const X64_DESKTOP_CORE_STEP_TIMEOUT_MS = 6_600_000;

/**
 * How long the updater waits for the desktop's user gateway to answer, both
 * after the core step restarts it and again after the updater's own restart.
 *
 * The appliance's 30 s + 45 s used to be the whole budget here too, and an
 * owner gateway with many agents and a large state database does not boot in
 * that: the desktop this package was built for took 52 s to open its port and
 * 75 s to report ready after a core upgrade. The 30 s wait expired mid-boot,
 * the restart threw that boot away, and the 45 s after it expired seconds
 * before the port opened, so a finished, healthy upgrade was reported as
 * failed. Four minutes covers that with room for a cold page cache, and only
 * runs out on a gateway that is genuinely not coming back.
 */
export const X64_DESKTOP_GATEWAY_READY_WAIT_MS = 240_000;

/** The verified mirror the desktop's root adapter runs from and reads the pin out of. */
const DESKTOP_MIRROR = "/var/lib/clawbox/root-exec-mirror";

/** The owner's own core patches the adapter re-applies on every run (`reapply_owner_core_patches`). */
const OWNER_CORE_PATCH_HELPERS = ["openclaw-patch-backup-sqlite", "openclaw-patch-memory-maintenance"] as const;

export type DesktopCoreStepCheck = { noop: true; version: string } | { noop: false; reason: string };

/** One `KEY=value` line of the integration file, as build-package.py's shlex.quote wrote it; a plain absolute path only. */
function hostPath(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`));
  if (lines.length !== 1) return null;
  const raw = lines[0].slice(key.length + 1);
  const value = /^'[^']*'$/.test(raw) ? raw.slice(1, -1) : raw;
  return /^[A-Za-z0-9_./-]+$/.test(value) && path.isAbsolute(value) ? value : null;
}

/** Whether anything, a dangling link included, sits at `p`. Anything but "nothing there" counts as there. */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Whether the desktop integration's `openclaw_install` would change nothing,
 * so the update can leave the gateway running instead of handing the step to
 * the root adapter.
 *
 * The adapter (`scripts/x64-migration/clawbox-x64-step.sh`) runs that step as
 * `with_gateway_stopped` → `update_openclaw`: it stops the owner's gateway
 * FIRST and only then finds out whether the core needs replacing. At the pin,
 * with nothing to recover, the stop is pure downtime — the gateway drains for
 * its stop timeout and every running agent run is lost (issue #1269). The
 * appliance's fast path (install.sh `openclaw_install_fast`) does not reach
 * this desktop: the adapter is installed by the package, never replaced by an
 * update, and refuses step names it does not know. This check runs here, as
 * the desktop owner, and reads only what `update_openclaw` itself acts on:
 *
 * - the pin the adapter reads, `<mirror>/config/openclaw-target.txt`, and the
 *   installed core's `package.json` version — the same comparison it makes;
 * - nothing for its recovery helpers to do: no `.openclaw-stage` or
 *   `.openclaw-migration-pending` under the npm prefix, and no
 *   `set-aside-links.txt` under `~/backups/openclaw-core-update/*`;
 * - none of the owner's core patch helpers in `~/bin`: the adapter re-applies
 *   them into the live core on every run, and running them under a live
 *   gateway is not something this package has ever done.
 *
 * Every doubt — a file that cannot be read, a value that is not a version or a
 * plain path — answers `noop: false` with the reason, and the caller runs the
 * adapter's step exactly as before. The adapter's read-only `config validate`
 * is the one thing a skipped step does not repeat: neither the core nor its
 * configuration changes in this step.
 */
export function desktopCoreStepIsNoop(): DesktopCoreStepCheck {
  const text = readRootOwnedHostFile(INTEGRATION_FILE, "the installed x64 integration");
  if (text === null) return { noop: false, reason: "no x64 integration file" };
  const prefix = hostPath(text, "NPM_PREFIX");
  const home = hostPath(text, "INSTALL_HOME");
  if (!prefix || !home) return { noop: false, reason: "the integration file names no plain NPM_PREFIX and INSTALL_HOME" };
  let target = "";
  try {
    target = fs.readFileSync(path.join(DESKTOP_MIRROR, "config", "openclaw-target.txt"), "utf8").split(/\r?\n/)[0].trim();
  } catch {
    return { noop: false, reason: "the pinned OpenClaw version could not be read" };
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/.test(target)) {
    return { noop: false, reason: "the pinned OpenClaw version is not a version" };
  }
  let installed: unknown = null;
  try {
    installed = (JSON.parse(fs.readFileSync(path.join(prefix, "lib", "node_modules", "openclaw", "package.json"), "utf8")) as { version?: unknown }).version;
  } catch {
    return { noop: false, reason: "the installed OpenClaw core could not be read" };
  }
  if (installed !== target) {
    return { noop: false, reason: `OpenClaw ${typeof installed === "string" ? installed : "(unknown)"} is installed and the pin is ${target}` };
  }
  for (const leftover of [".openclaw-stage", ".openclaw-migration-pending"]) {
    if (present(path.join(prefix, leftover))) return { noop: false, reason: `an earlier core swap left ${leftover} to settle` };
  }
  const recovery = path.join(home, "backups", "openclaw-core-update");
  let points: string[] = [];
  try {
    points = fs.readdirSync(recovery);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { noop: false, reason: "the core recovery points could not be read" };
  }
  if (points.some((point) => present(path.join(recovery, point, "set-aside-links.txt")))) {
    return { noop: false, reason: "an earlier core swap left links set aside" };
  }
  for (const helper of OWNER_CORE_PATCH_HELPERS) {
    if (present(path.join(home, "bin", helper))) {
      return { noop: false, reason: `the owner's core patch ${helper} is re-applied with the gateway stopped` };
    }
  }
  return { noop: true, version: target };
}
