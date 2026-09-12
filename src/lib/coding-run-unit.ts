/**
 * A coding run's own transient systemd scope — what makes a run outlive the web
 * server that started it.
 *
 * Until this module existed every run was a plain child of `clawbox-setup`, so
 * the `systemctl restart` at the end of an in-app update (or a crash, or an OOM
 * kill of the service) took the whole cgroup with it and a forty-minute run
 * died at minute thirty-nine with "The ClawBox web server restarted while this
 * run was in progress". `systemd-run --user --scope` moves the harness into a
 * cgroup of its OWN — `/user.slice/…/clawbox-run-<id>.scope`, outside the
 * service's — before exec'ing it, so stopping the service reaches nothing but
 * the web server.
 *
 * `--scope` rather than `--service` on purpose: systemd-run exec's the command
 * in its own process, so the pid the web server gets back IS the harness's pid
 * (the process group leader, which is what `CodingRun.pgid` records and what
 * the Kill button signals), stdio is inherited rather than journalled, and the
 * working directory is the one `spawn` was given.
 *
 * Everything here is best-effort by design. A box whose clawbox user has no
 * systemd user manager — no `loginctl enable-linger`, no `/run/user/<uid>` —
 * cannot have this, and refusing to run at all there would be far worse than
 * running the way the device always has. `probeSystemdRun()` is what readiness
 * reports and what the spawn path asks; when it says no, the run is a plain
 * child again and says so.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Every unit this module is ever allowed to name, and the shape it must have. */
export const RUN_UNIT_PREFIX = "clawbox-run-";

/**
 * The memory the box will let one run have. Sane defaults, hardcoded for now:
 * MemoryHigh is the point where the kernel starts reclaiming hard and the run
 * merely slows down, MemoryMax the wall where it is killed. Together they are
 * what stops one runaway harness from taking the desktop, the gateway and the
 * web server down with it — the failure mode this device actually sees.
 */
export const RUN_MEMORY_HIGH = "3G";
export const RUN_MEMORY_MAX = "4G";

/** A run id as it may appear in a unit name: the generator's own alphabet. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** How long a systemd question is given before it counts as unanswered. */
const SYSTEMD_TIMEOUT_MS = 5_000;
/** How long the `--scope true` probe is given, bus round trip included. */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * How long a probe answer is reused, and why the two differ.
 *
 * A YES is cached for much longer because it does not go stale — a box whose
 * user manager is up does not stop being able to make a scope — and because the
 * probe is the one thing here that costs something visible: it creates a real
 * transient unit, so systemd writes a journal line for every probe, and the
 * Coding Agent app polls readiness for as long as its window is open.
 *
 * A NO is cached briefly, so a box that has just been given `enable-linger` is
 * not told "no" for the rest of the web server's life.
 */
const PROBE_TTL_OK_MS = 600_000;
const PROBE_TTL_FAIL_MS = 60_000;

/**
 * A scope unit name, or null when the token is not something this module will
 * put on a command line.
 *
 * Rebuilt from a validated token rather than escaped: a unit name reaches
 * `systemctl stop`, and the one rule that cannot be got wrong is that nothing
 * but the generator's own alphabet ever gets there.
 *
 * The caller passes the run id with a per-SPAWN suffix, not the bare id: one
 * record can spawn more than once (the transient-failure retry, a completion
 * attempt, a resume) and a scope systemd has not finished collecting yet would
 * refuse the name. The chosen name is persisted on the record, so nothing has to
 * derive it twice.
 */
export function runScopeUnit(token: string): string | null {
  if (typeof token !== "string" || !RUN_ID.test(token)) return null;
  return `${RUN_UNIT_PREFIX}${token}.scope`;
}

/** Is this a unit name this module produced? The gate on anything read back off disk. */
export function isRunScopeUnit(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(RUN_UNIT_PREFIX) || !value.endsWith(".scope")) return false;
  return RUN_ID.test(value.slice(RUN_UNIT_PREFIX.length, -".scope".length));
}

/**
 * `systemd-run`'s own prefix, in front of whatever the caller was going to
 * spawn. Pure and exported for the contract test: the capability drop
 * (`buildSpawnArgv`) has to stay intact on the far side of the `--`, because
 * that prefix is a security boundary and this one is only a cgroup.
 */
export function buildScopeArgv(
  systemdRunPath: string,
  unit: string,
  bin: string,
  argv: readonly string[],
): { bin: string; argv: string[] } {
  return {
    bin: systemdRunPath,
    argv: [
      "--user",
      "--scope",
      `--unit=${unit.replace(/\.scope$/, "")}`,
      "--collect",
      // Without it systemd-run writes "Running scope as unit …" to the run's
      // stderr, which is the text the box shows the owner when a run dies
      // without a result.
      "--quiet",
      "-p",
      `MemoryHigh=${RUN_MEMORY_HIGH}`,
      "-p",
      `MemoryMax=${RUN_MEMORY_MAX}`,
      "--",
      bin,
      ...argv,
    ],
  };
}

/**
 * The two variables a `--user` call needs when it comes from a SYSTEM service.
 *
 * Derived rather than inherited: the run's environment is deliberately built
 * from nothing (see `buildRunEnv`), and `/run/user/<uid>` is the only thing
 * systemd-run needs to find the user bus — it composes the bus address from it
 * when `DBUS_SESSION_BUS_ADDRESS` is unset. PATH is here because Node resolves
 * the binary we hand it out of the env we hand it, and a run's PATH is a fixed
 * appliance list that need not have systemd in it.
 */
export function scopeEnv(base: Record<string, string> = {}): Record<string, string> {
  return {
    ...base,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
  };
}

function toolSearchPath(): string {
  const fromEnv = process.env.PATH;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
}

/**
 * Where `systemd-run` / `systemctl` actually are.
 *
 * The web server's own PATH, which on this appliance is systemd's default and
 * root-owned throughout; the absolute fallback is what a stripped environment
 * gets. Resolved rather than hardcoded so a test can put a shim in front.
 */
export async function findSystemdTool(binary: "systemd-run" | "systemctl"): Promise<string | null> {
  for (const dir of toolSearchPath().split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      const stat = await fs.promises.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next directory
    }
  }
  return null;
}

export interface SystemdRunProbe {
  /** Can this box put a run in its own scope right now? */
  available: boolean;
  /** Where systemd-run is, when it is usable. */
  path: string | null;
  /** Why not, in the owner's words. Null when it works. */
  detail: string | null;
}

const NO_SYSTEMD_RUN =
  "systemd-run is not installed, so a coding run is an ordinary child of the web server and does not survive a restart.";

let probeCache: { at: number; value: SystemdRunProbe } | null = null;
let probeInFlight: Promise<SystemdRunProbe> | null = null;

/**
 * Does `systemd-run --user --scope` WORK for this user — not "is the binary
 * there", which answers nothing on a box with no user manager.
 *
 * So the probe actually creates a throwaway scope around `true`. That is one
 * bus round trip, cached for a minute and shared between concurrent callers,
 * which is what keeps it off the status poll's bill. The same environment the
 * spawn will use, or the probe would be answering a different question from the
 * one asked.
 */
export async function probeSystemdRun(): Promise<SystemdRunProbe> {
  const now = Date.now();
  if (probeCache && now - probeCache.at < (probeCache.value.available ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS)) {
    return probeCache.value;
  }
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async (): Promise<SystemdRunProbe> => {
    const binary = await findSystemdTool("systemd-run");
    if (!binary) return { available: false, path: null, detail: NO_SYSTEMD_RUN };
    const unit = `${RUN_UNIT_PREFIX}probe-${process.pid}-${now.toString(36)}`;
    const { argv } = buildScopeArgv(binary, unit, "/bin/true", []);
    try {
      await execFileAsync(binary, argv, {
        timeout: PROBE_TIMEOUT_MS,
        env: scopeEnv({ PATH: toolSearchPath() }) as NodeJS.ProcessEnv,
      });
      return { available: true, path: binary, detail: null };
    } catch (err) {
      return { available: false, path: null, detail: probeRefusal(err) };
    }
  })();
  try {
    const value = await probeInFlight;
    probeCache = { at: Date.now(), value };
    return value;
  } finally {
    probeInFlight = null;
  }
}

/**
 * systemd's own reason, normalised to one line and bounded.
 *
 * Kept rather than replaced with a generic sentence: "Failed to connect to bus"
 * and "Interactive authentication required" need different answers from the
 * operator, and this field is the only place either is ever said.
 */
function probeRefusal(err: unknown): string {
  const raw = [
    (err as { stderr?: string } | null)?.stderr,
    (err as { message?: string } | null)?.message,
  ]
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  const line = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return line
    ? `systemd-run --user does not work for this user, so a coding run does not survive a web-server restart: ${line}`
    : "systemd-run --user does not work for this user, so a coding run does not survive a web-server restart.";
}

/** Forget the cached probe. Test hook, and the reset a swapped environment needs. */
export function _resetSystemdRunProbeForTests(): void {
  probeCache = null;
  probeInFlight = null;
}

/**
 * Is that scope still running? TRI-STATE, and the null matters: "systemd could
 * not be asked" is not "the run is gone", and reading it as gone would settle a
 * live run as lost every time the bus hiccuped.
 */
export async function unitActive(unit: string): Promise<boolean | null> {
  if (!isRunScopeUnit(unit)) return false;
  const binary = await findSystemdTool("systemctl");
  if (!binary) return null;
  try {
    const { stdout } = await execFileAsync(binary, ["--user", "is-active", unit], {
      timeout: SYSTEMD_TIMEOUT_MS,
      env: scopeEnv({ PATH: toolSearchPath() }) as NodeJS.ProcessEnv,
    });
    return readActive(stdout);
  } catch (err) {
    // `is-active` exits non-zero for every state but active and still prints
    // the word — "inactive", "failed", "unknown" — so a failure with usable
    // stdout is a real answer. Only silence is silence.
    const out = (err as { stdout?: string } | null)?.stdout;
    if (typeof out === "string" && out.trim()) return readActive(out);
    return null;
  }
}

function readActive(stdout: string): boolean {
  const state = stdout.trim().split("\n")[0]?.trim() ?? "";
  return state === "active" || state === "activating" || state === "reloading";
}

/**
 * Stop that scope — the whole cgroup, so nothing the run forked is left behind.
 *
 * Answers whether systemd took the request, not whether anything was there:
 * stopping a scope that has already gone is a success the caller wanted anyway.
 * Never throws — every caller is on a path where failing to clean up must not
 * change what the run's record says about the run.
 */
export async function stopUnit(unit: string): Promise<boolean> {
  if (!isRunScopeUnit(unit)) return false;
  const binary = await findSystemdTool("systemctl");
  if (!binary) return false;
  try {
    await execFileAsync(binary, ["--user", "stop", unit], {
      timeout: SYSTEMD_TIMEOUT_MS,
      env: scopeEnv({ PATH: toolSearchPath() }) as NodeJS.ProcessEnv,
    });
    return true;
  } catch {
    return false;
  }
}
