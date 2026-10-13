/**
 * Starting a project's own server from its clawbox.json — the half of "put the
 * app on the desktop" the box used to leave to whoever was still around.
 *
 * `registerServerApp` (src/lib/app-proxy.ts) registers an app only while its
 * server is LISTENING, because the listener check is what stops a manifest
 * from pointing the proxy at some other service. But a coding run is told to
 * end what it started, and it does: it builds the app, serves it once to look
 * at it, stops the server and finishes. The settle then found nothing on the
 * port, said "Not on the desktop yet" in a run log nobody was reading, and the
 * owner who had asked for an app got no icon at all.
 *
 * So when a run settles with a manifest that names a `port` AND a `start`
 * command, and nothing is listening, the box runs that command itself — in
 * the project folder, as this user — waits for the project's own listener to
 * come up, and registers the app. The listener check is unchanged and still
 * decides: a `start` that brings up nothing, or something that is not the
 * project's, registers nothing.
 *
 * WHO MAY CAUSE A START. Only a run settling in that project. The command is
 * text the run itself wrote (or found in the repository it was asked to work
 * in), and a run already executes commands there as this user — starting the
 * server it describes hands it nothing new. The owner's "put on the desktop"
 * route and the legacy-stub migration do NOT start anything: they act on a
 * manifest nobody on this box has run yet.
 *
 * WHERE IT RUNS. In a transient systemd user scope of its own when the box
 * has a user manager (the same reason a coding run has one, see
 * coding-run-unit.ts: a plain child sits in the web server's cgroup and is
 * killed with it at the end of every in-app update), and as a detached child
 * otherwise.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "@/lib/runtime-path";
import { listenerOwnedBy, registerServerApp, type RegisterOutcome } from "@/lib/app-proxy";
import { APP_ID_RE } from "@/lib/code-projects";
import { DATA_DIR } from "@/lib/config-store";
import { type ClawboxManifest, isProxyablePort } from "@/lib/clawbox-manifest";
import { probeSystemdRun, scopeEnv } from "@/lib/coding-run-unit";

/** Every unit this module is ever allowed to name. */
export const APP_UNIT_PREFIX = "clawbox-app-";

/** How long a started server has to be found listening. A production build's server answers in seconds; a dev server on this board can take most of a minute. */
export const APP_START_WAIT_MS = 60_000;
const POLL_MS = 500;

/** Where a started server's output goes: one file per app, rewritten on each start. */
export function appServerLogPath(id: string): string {
  return path.join(DATA_DIR, "app-servers", `${id}.log`);
}

// A constant, not an inline literal: the same Turbopack tracing reason as
// child-run.ts's SCRIPT_RUNNER.
const START_SHELL: string = "/bin/sh";

/**
 * `systemd-run`'s prefix in front of the start command. Pure and exported for
 * its test. The unit name is rebuilt from the validated id and a per-start
 * stamp: a scope systemd has not finished collecting would refuse a reused
 * name.
 */
export function buildAppScopeArgv(systemdRunPath: string, id: string, stamp: string, command: string): { bin: string; argv: string[] } | null {
  if (!APP_ID_RE.test(id) || !/^[a-z0-9]{1,16}$/.test(stamp)) return null;
  return {
    bin: systemdRunPath,
    argv: ["--user", "--scope", `--unit=${APP_UNIT_PREFIX}${id}-${stamp}`, "--collect", "--quiet", "--", START_SHELL, "-c", command],
  };
}

export type StartOutcome = { ok: true } | { ok: false; detail: string };

export interface StartServerAppInput {
  id: string;
  /** The project folder: the working directory, and the folder the listener must run from. */
  directory: string;
  manifest: ClawboxManifest;
  /** The PATH the command is resolved with — the caller's run PATH, so `bun` and `npm` are found. */
  searchPath: string;
  /** For the tests: never ask systemd for a scope. */
  noScope?: boolean;
  /** For the tests: a shorter wait. */
  waitMs?: number;
}

const inFlight = new Map<string, Promise<StartOutcome>>();

/**
 * Run the manifest's `start` command in the project folder and wait for the
 * project's own listener on the manifest's port. One start per app at a time:
 * a second caller gets the first one's answer. Never throws.
 */
export function startServerApp(input: StartServerAppInput): Promise<StartOutcome> {
  const running = inFlight.get(input.id);
  if (running) return running;
  const attempt = startOnce(input)
    .catch((err): StartOutcome => ({ ok: false, detail: `Starting the app failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }))
    .finally(() => { inFlight.delete(input.id); });
  inFlight.set(input.id, attempt);
  return attempt;
}

async function startOnce(input: StartServerAppInput): Promise<StartOutcome> {
  const { id, directory, manifest, searchPath } = input;
  const port = manifest.port;
  const command = manifest.start;
  if (!APP_ID_RE.test(id) || !isProxyablePort(port) || !command) return { ok: false, detail: "The manifest names no start command." };
  const stat = await fs.promises.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) return { ok: false, detail: "The project folder is gone." };

  const logFile = appServerLogPath(id);
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  const home = process.env.HOME || directory;
  const user = process.env.USER || process.env.LOGNAME || path.basename(home);
  const env = scopeEnv({
    HOME: home,
    USER: user,
    LOGNAME: user,
    PATH: searchPath,
    LANG: process.env.LANG || "C.UTF-8",
    PORT: String(port),
  });

  const probe = input.noScope ? null : await probeSystemdRun();
  const scoped = probe?.available && probe.path ? buildAppScopeArgv(probe.path, id, Date.now().toString(36), command) : null;
  // The scope first; a plain detached child when the box has no user manager,
  // or when systemd turned the scope away (it exits before anything listens).
  const plans: { bin: string; argv: string[] }[] = [
    ...(scoped ? [scoped] : []),
    { bin: START_SHELL, argv: ["-c", command] },
  ];
  const waitMs = input.waitMs ?? APP_START_WAIT_MS;
  let exited: number | null = null;
  for (const plan of plans) {
    const log = await fs.promises.open(logFile, "w");
    let child: ChildProcess;
    let gone = false;
    try {
      child = spawn(/* turbopackIgnore: true */ plan.bin, plan.argv, {
        cwd: directory,
        env: env as unknown as NodeJS.ProcessEnv,
        detached: true,
        shell: false,
        stdio: ["ignore", log.fd, log.fd],
      });
    } finally {
      await log.close().catch(() => undefined);
    }
    child.once("error", () => { gone = true; });
    child.once("exit", (code) => { gone = true; exited = code; });
    child.unref();

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if ((await listenerOwnedBy(port, directory, { fresh: true })) === "owned") return { ok: true };
      if (gone) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (!gone) {
      // Still running and still silent: end what we started, by its own
      // process group, rather than leave a half-started server behind.
      if (typeof child.pid === "number") { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } }
      return { ok: false, detail: `the box started it (${command}) and nothing of the project's answered on port ${port} within ${Math.round(waitMs / 1000)} seconds.` };
    }
  }
  return { ok: false, detail: `the box started it (${command}) and it stopped${exited === null ? "" : ` with exit code ${exited}`} before anything listened on port ${port}.` };
}

/**
 * Register a project's server app, starting the server first when the only
 * thing in the way is that nothing is listening and the manifest says how to
 * start it. Any other refusal — a port that is somebody else's, a listing
 * that failed — is returned as it is: starting a second server would not
 * change it.
 */
export async function registerOrStartServerApp(input: StartServerAppInput): Promise<RegisterOutcome> {
  const { id, directory, manifest } = input;
  const first = await registerServerApp({ id, directory, manifest });
  if (first.ok || first.reason !== "not_listening" || !manifest.start || !manifest.port) return first;
  const started = await startServerApp(input);
  if (!started.ok) return { ok: false, reason: "not_listening", detail: started.detail };
  return registerServerApp({ id, directory, manifest });
}
