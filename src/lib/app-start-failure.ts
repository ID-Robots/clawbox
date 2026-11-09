/**
 * What the box remembers about an app server it could not start, so the app's
 * window can say why. SERVER ONLY.
 *
 * WHY. An app is put on the desktop (`registerServerApp`, src/lib/app-proxy.ts)
 * only once its own server listens, so an app whose start failed was never
 * registered at all, and `/apps/<id>/` answered it with the proxy's plain 404
 * "No app is served under this name". That is what a Store app whose own
 * build fails looked like (TASK-2323: the Audiobook Player package's
 * `next build` stopped on its own favicon): the install said ok, and every
 * window, reopen and App Router fetch of the app said 404, while the reason
 * sat in a log file nobody was shown.
 *
 * So `startServerApp` (src/lib/app-server-start.ts) writes down every start
 * that did not come up — the command, its exit code, the one line that says
 * why and the end of what it printed — and the proxy answers `/apps/<id>/`
 * with that, as a 503, for as long as the app is not being served. A start
 * that comes up, a registration and an uninstall forget it.
 *
 * Kept beside the start's own log, under data/app-servers/, as
 * `<id>.start-failed.json`. Only an id `APP_ID_RE` accepts is ever written or
 * read, so the name cannot leave that folder.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import path, { untraced } from "@/lib/runtime-path";
import { APP_ID_RE } from "@/lib/code-projects";
import { DATA_DIR } from "@/lib/config-store";
import { readStoreMarker } from "@/lib/store-install-receipt";

export interface AppStartFailure {
  id: string;
  /** The app's name from its manifest. */
  name: string;
  /** When the start gave up, ISO 8601. */
  at: string;
  /** The manifest's `start` command. */
  command: string;
  port: number;
  /** The project folder the command ran in. */
  directory: string;
  /** What failed: installing the dependencies (the command never ran), or the command itself. */
  stage: "dependencies" | "start";
  /** The command's exit code; null when it was still running (it never listened) or never ran. */
  exitCode: number | null;
  /** The sentence the install answer and the run's feed carry. */
  detail: string;
  /** The end of what the start printed, a line per entry, as it printed them. */
  output: string[];
}

/** How many of a failed start's last lines are kept, and how long one may be. */
export const FAILURE_OUTPUT_LINES = 40;
const FAILURE_LINE_MAX = 300;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Every control character but the tab, which is indentation. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Where the record of `id`'s failed start is kept. */
export function appStartFailurePath(id: string): string {
  return untraced(path.join(DATA_DIR, "app-servers", `${id}.start-failed.json`));
}

/**
 * The end of a start's output as lines to show: colours and control
 * characters gone, tabs as spaces, blank lines dropped, each line bounded,
 * at most `max` of the last ones.
 */
export function failureOutputLines(output: string, max: number = FAILURE_OUTPUT_LINES): string[] {
  const lines = output
    .replace(ANSI_RE, "")
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/\t/g, "  ").replace(CONTROL_RE, "").trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => (line.length > FAILURE_LINE_MAX ? `${line.slice(0, FAILURE_LINE_MAX - 1)}…` : line));
  return lines.slice(-max);
}

/** Write down a start that did not come up. Never throws: the start's own answer is what matters. */
export async function recordAppStartFailure(failure: Omit<AppStartFailure, "at" | "output"> & { output?: string }): Promise<void> {
  if (!APP_ID_RE.test(failure.id)) return;
  const record: AppStartFailure = {
    id: failure.id,
    name: failure.name,
    at: new Date().toISOString(),
    command: failure.command,
    port: failure.port,
    directory: failure.directory,
    stage: failure.stage,
    exitCode: failure.exitCode,
    detail: failure.detail,
    output: failureOutputLines(failure.output ?? ""),
  };
  const file = appStartFailurePath(failure.id);
  // Two writers of one app's record (a Store install and the start it
  // shares a dependency install with) must not share a temp name.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    console.warn(`[app-start] could not record the failed start of ${failure.id}:`, err instanceof Error ? err.message : err);
  }
}

/** Forget `id`'s failed start: it has come up since, or the app is gone. Never throws. */
export async function clearAppStartFailure(id: string): Promise<void> {
  if (!APP_ID_RE.test(id)) return;
  await fs.promises.rm(appStartFailurePath(id), { force: true }).catch(() => undefined);
}

/**
 * The failed start of `id`, while its project folder is still there; null
 * when there is none, the record cannot be read, or the folder has gone (the
 * app was removed by hand: there is nothing left to start).
 */
export async function readAppStartFailure(id: string): Promise<AppStartFailure | null> {
  if (!APP_ID_RE.test(id)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(appStartFailurePath(id), "utf-8"));
  } catch {
    return null;
  }
  const r = parsed as Partial<AppStartFailure> | null;
  if (!r || typeof r !== "object" || r.id !== id || typeof r.detail !== "string" || typeof r.directory !== "string" || !path.isAbsolute(r.directory)) return null;
  const folder = await fs.promises.stat(untraced(r.directory)).catch(() => null);
  if (!folder?.isDirectory()) return null;
  return {
    id,
    name: typeof r.name === "string" && r.name ? r.name : id,
    at: typeof r.at === "string" ? r.at : "",
    command: typeof r.command === "string" ? r.command : "",
    port: typeof r.port === "number" ? r.port : 0,
    directory: r.directory,
    stage: r.stage === "dependencies" ? "dependencies" : "start",
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
    detail: r.detail,
    output: Array.isArray(r.output) ? r.output.filter((line): line is string => typeof line === "string").slice(-FAILURE_OUTPUT_LINES) : [],
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

/**
 * The one-line answer for a request that is not the owner's window: an App
 * Router fetch, an API call, a preflight. Those reach the proxy with no
 * session, so it names nothing the start printed: the window says that.
 */
export function appStartFailureText(failure: AppStartFailure): string {
  return `${failure.name} is not running: its server did not start. Its window on the desktop says why.`;
}

/**
 * The page `/apps/<id>/` shows in the app's window while its start has
 * failed: what failed, the end of what it printed, and whose it is to fix.
 */
export async function appStartFailureHtml(failure: AppStartFailure): Promise<string> {
  const store = await readStoreMarker(failure.directory).catch(() => null);
  const fromStore = store?.slug === failure.id;
  const what = fromStore ? `${failure.name}${store?.version ? ` ${store.version}` : ""} from the ClawBox Store` : failure.name;
  const command = `<code>${escapeHtml(failure.command)}</code>`;
  const folder = `<code>${escapeHtml(failure.directory)}</code>`;
  const ran = failure.stage === "dependencies"
    ? `The box installs an app's dependencies before it runs its start command, ${command}. In ${folder} that install failed, so the command was not run.`
    : `The box ran its start command, ${command}, in ${folder}` + (failure.exitCode === null
      ? `, and nothing answered on port ${failure.port}.`
      : `. It stopped with exit code ${failure.exitCode} before anything answered on port ${failure.port}.`);
  const when = failure.at
    ? ` <small>(<time datetime="${escapeHtml(failure.at)}">${escapeHtml(failure.at.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC"))}</time>)</small>`
    : "";
  const next = fromStore
    ? "An error in the app's own files is for its publisher to fix. Once the Store has a fixed version, uninstall the app and install it again. The project folder is in the Coding Agent if you want to look at it yourself."
    : "Open the project in the Coding Agent to fix it, then put it on the desktop again.";
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    `<title>${escapeHtml(failure.name)} did not start</title><style>` +
    "body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;margin:0;padding:24px;box-sizing:border-box}" +
    "main{max-width:52rem;margin:0 auto}h1{font-size:1.1rem;font-weight:600;margin:0 0 .8rem}p{margin:.5rem 0;font-size:.9rem;line-height:1.6;color:#b9b9c6}" +
    ".why{color:#fca5a5}code{color:#f9a66c}small{color:#8a8aa0}" +
    "pre{background:#11111f;border:1px solid #2c2c44;border-radius:6px;padding:12px;font-size:.78rem;line-height:1.45;color:#d6d6e0;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto}" +
    `</style></head><body><main data-clawbox-app-start-failed="${escapeHtml(failure.id)}"><h1>${escapeHtml(what)} did not start</h1>` +
    `<p class="why">${escapeHtml(failure.detail)}</p>` +
    `<p>${ran}${when}</p>` +
    (failure.output.length > 0 ? `<p>The end of what it printed:</p><pre>${escapeHtml(failure.output.join("\n"))}</pre>` : "") +
    `<p>${escapeHtml(next)}</p></main></body></html>`;
}
