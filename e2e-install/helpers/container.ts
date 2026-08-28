/**
 * Test helpers for driving the e2e-install docker container.
 *
 * The container runs a real install.sh + systemd + Next.js server, reachable
 * on http://localhost:${CLAWBOX_PORT}. These helpers encapsulate compose
 * lifecycle, restart simulation, and direct `docker exec` access.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export const CLAWBOX_PORT = process.env.CLAWBOX_PORT ?? "8080";
export const BASE_URL = `http://localhost:${CLAWBOX_PORT}`;
export const CONTAINER_NAME = "clawbox-e2e";
export const COMPOSE_FILE = "e2e-install/docker-compose.test.yml";
// Resolve via __dirname so this works under both the CJS transpiler
// Playwright uses by default and the ESM transpiler some setups opt into.
// Avoid `import.meta.url` — it forces ESM mode and breaks the default loader.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function compose(args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}) {
  const { stdout, stderr } = await execFileAsync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, ...args],
    {
      cwd: REPO_ROOT,
      timeout: opts.timeoutMs ?? 300_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(opts.env ?? {}) },
    },
  );
  return { stdout, stderr };
}

/**
 * Build the test image via `docker build` directly (legacy builder). We
 * bypass `docker compose build` because that path now requires buildx
 * 0.17+ which isn't available on every host. Legacy builder + qemu is
 * enough for a single-platform arm64 build.
 */
async function imageExists(tag: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", tag],
      { timeout: 10_000 },
    );
    return !!stdout.trim();
  } catch {
    return false;
  }
}

export async function buildImage(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && await imageExists("clawbox-e2e:latest")) return;
  await execFileAsync(
    "docker",
    [
      "build",
      "-f", "e2e-install/Dockerfile",
      "-t", "clawbox-e2e:latest",
      ".",
    ],
    {
      cwd: REPO_ROOT,
      timeout: 45 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      // DOCKER_BUILDKIT=0 forces the legacy builder, which builds for the
      // host arch without needing buildx 0.17+.
      env: { ...process.env, DOCKER_BUILDKIT: "0" },
    },
  );
}

export async function composeUp(opts: { build?: boolean } = {}): Promise<void> {
  // Build first (if needed) so compose can just reference the pre-built
  // image without invoking buildx under the hood.
  await buildImage({ force: !!opts.build });
  await compose(["up", "-d"], { timeoutMs: 10 * 60_000 });
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
 *
 * Defaults to 4 min: `systemctl reboot` stops every unit first, and a couple of
 * services hitting their default 90s `TimeoutStopSec` can cascade past 2 min on
 * a loaded CI runner. The container does exit — it's just slow — so the old
 * 120s ceiling flaked intermittently (seen on `main` too). Give it room rather
 * than force-killing, which would mask a genuine reboot regression.
 */
export async function waitForContainerStopped(timeoutMs = 240_000): Promise<void> {
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

/**
 * Force-stop the container (SIGTERM to PID 1, SIGKILL after the grace period).
 * Fallback for the power test when an in-container `systemctl reboot` doesn't
 * propagate to a container exit on its own (a CI Docker-in-systemd flake).
 */
export async function dockerStop(): Promise<void> {
  await execFileAsync("docker", ["stop", "-t", "30", CONTAINER_NAME], { timeout: 60_000 });
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

/** The systemd unit that runs install.sh on first boot (e2e-install/clawbox-bootstrap.service). */
export const BOOTSTRAP_UNIT = "clawbox-bootstrap.service";
/** Removed by the bootstrap unit only after install.sh exited 0 (see its ExecStart). */
export const INSTALL_MARKER = "/home/clawbox/clawbox/.needs-install";
export const INSTALL_LOG = "/var/log/clawbox-install.log";
const INSTALL_POLL_MS = 5_000;

export interface BootstrapUnitState {
  /** systemd ActiveState: activating | active | failed | inactive | unknown. */
  activeState: string;
  /** systemd Result: success | exit-code | timeout | signal | ... | unknown. */
  result: string;
}

/**
 * Parse `systemctl show -p ActiveState -p Result <unit>` output. Property
 * lines, not `--value`, because the order `--value` prints multiple
 * properties in is not something we want to depend on across systemd
 * versions; a missing property reads as "unknown", which is never "failed".
 */
export function parseUnitState(stdout: string): BootstrapUnitState {
  const props = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return {
    activeState: props.get("ActiveState") || "unknown",
    result: props.get("Result") || "unknown",
  };
}

export type InstallVerdict = "done" | "failed" | "wait";

/**
 * The decision one poll of waitForInstallComplete makes, kept pure so the
 * unit test can pin it without a container.
 *
 * "done" wins over "failed": the marker only disappears after install.sh
 * exited 0, so a gone marker plus a live server is the success the harness
 * has always accepted, whatever systemd says in that instant. A failed unit
 * with the marker still present means install.sh has EXITED non-zero (or
 * systemd timed it out) and nothing will ever remove the marker — waiting
 * for the deadline can only add time, never information.
 */
export function classifyInstallState(state: {
  markerGone: boolean;
  httpReady: boolean;
  unitFailed: boolean;
}): InstallVerdict {
  if (state.markerGone && state.httpReady) return "done";
  if (state.unitFailed) return "failed";
  return "wait";
}

/**
 * Thrown by waitForInstallComplete the moment the bootstrap unit fails. It
 * carries the tail of the install log so the cause is in the error Playwright
 * prints, not only in a dump further down the job log; global-setup.ts knows
 * this and does not print the log a second time for this error.
 */
export class InstallBootstrapFailedError extends Error {
  readonly unit: BootstrapUnitState;
  readonly installLogTail: string;

  constructor(unit: BootstrapUnitState, installLogTail: string, elapsedMs: number) {
    super(
      `bootstrap failed: ${BOOTSTRAP_UNIT} is ${unit.activeState} (Result=${unit.result}) after ` +
      `${Math.round(elapsedMs / 1000)}s — install.sh exited, or systemd stopped it (Result=${unit.result}), ` +
      `without removing ${INSTALL_MARKER}, ` +
      `so the install cannot complete; giving up now instead of at the deadline.\n` +
      `Tail of ${INSTALL_LOG}:\n${installLogTail}`,
    );
    this.name = "InstallBootstrapFailedError";
    this.unit = unit;
    this.installLogTail = installLogTail;
  }
}

/** What one poll of the install asks the container; swapped for fakes in the unit test. */
export interface InstallProbes {
  markerGone(): Promise<boolean>;
  httpReady(): Promise<boolean>;
  bootstrapUnit(): Promise<BootstrapUnitState>;
  installLogTail(): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * The real probes. Every one of them answers the conservative value when the
 * container cannot be asked (docker exec failing, HTTP refused): "marker
 * still there", "HTTP not ready", "unit state unknown". A transient docker
 * hiccup must keep the loop waiting, never end it either way.
 */
export const dockerInstallProbes: InstallProbes = {
  async markerGone() {
    try {
      await dockerExec(["test", "!", "-f", INSTALL_MARKER]);
      return true;
    } catch {
      return false;
    }
  },
  async httpReady() {
    try {
      const res = await fetch(`${BASE_URL}/setup-api/setup/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  async bootstrapUnit() {
    try {
      // `systemctl show` exits 0 whatever the state, so a non-zero exit here
      // is docker or systemd itself being unreachable — reported as unknown.
      const stdout = await dockerExec(
        ["systemctl", "show", "-p", "ActiveState", "-p", "Result", BOOTSTRAP_UNIT],
        { user: "root", timeoutMs: 15_000 },
      );
      return parseUnitState(stdout);
    } catch {
      return { activeState: "unknown", result: "unknown" };
    }
  },
  // 500 lines, the same amount the deadline path's dump in global-setup shows:
  // this tail REPLACES that dump for a bootstrap failure, and the cause of a
  // failed install.sh is rarely in its last 200 lines.
  installLogTail: () => readInstallLog(500),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * Wait for install.sh to finish (marker file removed) AND HTTP to be ready.
 * The bootstrap service removes /home/clawbox/clawbox/.needs-install on
 * success; checking for its absence is more reliable than just probing HTTP
 * because the server technically comes up during the install (after the
 * `step_build` / `step_start_services` steps).
 *
 * Every poll also asks systemd whether the bootstrap unit has FAILED, and
 * gives up at once when it has. Measured on PR #558: the unit exited 1 at
 * ~3 min and this loop kept polling the marker until its 40-minute deadline,
 * so the job took 41 minutes to report a failure it could have reported at
 * minute 3. The deadline stays as the backstop for an installer that hangs
 * without failing.
 */
export async function waitForInstallComplete(
  timeoutMs = 40 * 60_000,
  probes: InstallProbes = dockerInstallProbes,
): Promise<void> {
  const started = probes.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const markerGone = await probes.markerGone();
    // HTTP is only meaningful once the marker is gone; before that a live
    // server is the installer's own mid-run start, not completion.
    const httpReady = markerGone ? await probes.httpReady() : false;
    const unit = await probes.bootstrapUnit();
    const verdict = classifyInstallState({ markerGone, httpReady, unitFailed: unit.activeState === "failed" });
    if (verdict === "done") return;
    if (verdict === "failed") {
      throw new InstallBootstrapFailedError(unit, await probes.installLogTail(), probes.now() - started);
    }
    if (probes.now() >= deadline) break;
    await probes.sleep(INSTALL_POLL_MS);
  }
  throw new Error(`install.sh did not finish within ${timeoutMs}ms (${BOOTSTRAP_UNIT} never reported failure)`);
}

export async function readInstallLog(tailLines = 200): Promise<string> {
  try {
    return await dockerExec(["tail", `-n${tailLines}`, INSTALL_LOG]);
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

