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
function readRootOwnedProjectDir(file: string, label: string): string | null {
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
    const projects = fs.readFileSync(fd, "utf8").split(/\r?\n/)
      .filter((line) => line.startsWith("PROJECT_DIR="));
    const match = projects.length === 1 && /^PROJECT_DIR=([A-Za-z0-9_./-]+)$/.exec(projects[0]);
    if (!match || !path.isAbsolute(match[1])) {
      throw new Error(`${subject} has no valid project directory; repair it before updating.`);
    }
    return match[1];
  } finally {
    fs.closeSync(fd);
  }
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
