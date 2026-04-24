/**
 * Test helpers for driving the e2e-install docker container.
 *
 * The container runs a real install.sh + systemd + Next.js server, reachable
 * on http://localhost:${CLAWBOX_PORT}. These helpers encapsulate compose
 * lifecycle, restart simulation, and direct `docker exec` access.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CLAWBOX_PORT = process.env.CLAWBOX_PORT ?? "8080";
export const BASE_URL = `http://localhost:${CLAWBOX_PORT}`;
export const CONTAINER_NAME = "clawbox-e2e";
export const COMPOSE_FILE = "e2e-install/docker-compose.test.yml";
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

async function compose(args: string[], opts: { timeoutMs?: number } = {}) {
  const { stdout, stderr } = await execFileAsync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, ...args],
    { cwd: REPO_ROOT, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return { stdout, stderr };
}

export async function composeUp(opts: { build?: boolean } = {}): Promise<void> {
  const args = ["up", "-d"];
  if (opts.build) args.push("--build");
  await compose(args, { timeoutMs: 30 * 60_000 });
}

export async function composeDown(opts: { removeVolumes?: boolean } = {}): Promise<void> {
  const args = ["down"];
  if (opts.removeVolumes) args.push("-v");
  await compose(args);
}

export async function composeRestart(): Promise<void> {
  await compose(["restart"], { timeoutMs: 120_000 });
}

/**
 * Wait until `docker inspect` reports the container is stopped (exit
 * status). Used by the power/reboot test to confirm an in-container
 * `systemctl reboot` actually propagated out to the docker runtime.
 */
export async function waitForContainerStopped(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect", "-f", "{{.State.Running}}", CONTAINER_NAME,
      ], { timeout: 10_000 });
      if (stdout.trim() === "false") return;
    } catch {
      // container may have been removed — count that as stopped
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`container ${CONTAINER_NAME} did not stop within ${timeoutMs}ms`);
}

/** Restart a stopped container without reseeding the volume. */
export async function dockerStart(): Promise<void> {
  await execFileAsync("docker", ["start", CONTAINER_NAME], { timeout: 60_000 });
}

export async function dockerExec(cmd: string[], opts: { user?: string; timeoutMs?: number } = {}): Promise<string> {
  const args = ["exec"];
  if (opts.user) args.push("--user", opts.user);
  args.push(CONTAINER_NAME, ...cmd);
  const { stdout } = await execFileAsync("docker", args, {
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** Wait for the HTTP server to answer 2xx on /setup-api/setup/status. */
export async function waitForHttpReady(timeoutMs = 20 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/setup-api/setup/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Container HTTP not ready after ${timeoutMs}ms: ${String(lastError)}`);
}

/**
 * Wait for install.sh to finish (marker file removed) AND HTTP to be ready.
 * The bootstrap service removes /home/clawbox/clawbox/.needs-install on
 * success; checking for its absence is more reliable than just probing HTTP
 * because the server technically comes up during the install (after the
 * `step_build` / `step_start_services` steps).
 */
export async function waitForInstallComplete(timeoutMs = 40 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await dockerExec(["test", "!", "-f", "/home/clawbox/clawbox/.needs-install"]);
      await waitForHttpReady(60_000);
      return;
    } catch {
      // not done yet
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`install.sh did not finish within ${timeoutMs}ms`);
}

export async function readInstallLog(tailLines = 200): Promise<string> {
  try {
    return await dockerExec(["tail", `-n${tailLines}`, "/var/log/clawbox-install.log"]);
  } catch {
    return "(install log not available)";
  }
}

/** Reset the pinned update branch, used by upgrade tests. */
export async function setUpdateBranch(branch: string): Promise<void> {
  if (!/^[A-Za-z0-9._\-/]+$/.test(branch)) {
    throw new Error(`unsafe branch name: ${branch}`);
  }
  await dockerExec(
    ["bash", "-c", `printf '%s\\n' '${branch}' > /home/clawbox/clawbox/.update-branch && chown clawbox:clawbox /home/clawbox/clawbox/.update-branch`],
    { user: "root" },
  );
}

export async function readGitBranch(): Promise<string> {
  const stdout = await dockerExec(
    ["git", "-c", "safe.directory=/home/clawbox/clawbox", "-C", "/home/clawbox/clawbox", "rev-parse", "--abbrev-ref", "HEAD"],
    { user: "clawbox" },
  );
  return stdout.trim();
}

export async function readConfigValue(key: string): Promise<string | null> {
  try {
    const stdout = await dockerExec([
      "bash",
      "-c",
      `node -e 'const c=JSON.parse(require("fs").readFileSync("/home/clawbox/clawbox/data/config.json","utf8"));process.stdout.write(c.${key} === undefined ? "" : String(c.${key}));'`,
    ], { user: "clawbox" });
    return stdout.length ? stdout : null;
  } catch {
    return null;
  }
}
