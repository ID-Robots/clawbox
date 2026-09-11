import fs from "fs";
import path from "path";

const INTEGRATION_FILE = "/etc/clawbox/x64-integration.env";

/**
 * The existing-desktop package owns its gateway maintenance and rollback.
 * Detect that installed contract, not the CPU: ordinary x64/ARM installs
 * still use the appliance updater. Never source the host file as shell code.
 */
export function hasX64DesktopIntegration(projectDir: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(INTEGRATION_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Cannot read the installed x64 integration; repair it before updating.");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) {
      throw new Error("The installed x64 integration must be a small, root-owned file without group or other write access.");
    }
    const projects = fs.readFileSync(fd, "utf8").split(/\r?\n/)
      .filter((line) => line.startsWith("PROJECT_DIR="));
    const match = projects.length === 1 && /^PROJECT_DIR=([A-Za-z0-9_./-]+)$/.exec(projects[0]);
    if (!match || !path.isAbsolute(match[1])) {
      throw new Error("The installed x64 integration has no valid project directory; repair it before updating.");
    }
    return path.resolve(match[1]) === path.resolve(projectDir);
  } finally {
    fs.closeSync(fd);
  }
}
