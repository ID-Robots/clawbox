/**
 * `/apps/<id>/…` — a project's own server, reached through the box.
 *
 * WHY
 *
 * An app the coding agent builds with a server of its own (a Next.js app on
 * :4230, a game engine) used to be opened by sending the browser to
 * `location.hostname:4230`. That works on the LAN and nowhere else: through
 * a Cloudflare quick tunnel only the box's port 80 exists, the hostname
 * changes every time the tunnel restarts, and a link that named either was
 * dead the next morning (the owner's report, 2026-09-05). The fix is to put
 * no host in any link: the box serves the app under a path of its own
 * origin, so `/apps/tinder-clone/` is right on the LAN, over mDNS, through
 * any tunnel, and after every reset.
 *
 * WHICH PORT, AND WHOSE
 *
 * A project's clawbox.json declares its `port` (src/lib/clawbox-manifest.ts);
 * `registerServerApp` copies it — with the project folder — into the app's
 * data/webapps/<id>/meta.json, and ONLY a registered app is proxied. The
 * manifest alone is not enough, because the proxy forwards unauthenticated
 * requests (see below) and a manifest is a file a run or an imported
 * repository can write: one naming port 2375 would have put the Docker API
 * on the tunnel. So every registration and every proxied request checks
 * that the port's LISTENER is the project's own — a process of this user
 * whose working directory is inside the project folder (`ss -ltnp`, then
 * /proc/<pid>/cwd; a listener of another user shows no pid and is refused
 * outright). Verdicts are cached briefly. production-server.js mirrors the
 * same read for the app's websockets.
 *
 * WHAT PROTECTS THE DESKTOP
 *
 * The app is code the agent wrote, and here it is served from the DESKTOP'S
 * origin. Framed without a sandbox it would run with the owner's session
 * and reach every owner-only route; the iframe sandbox that boxes a one-file
 * webapp does not fit, because a sandboxed frame's navigation carries no
 * cookies and the document itself must be authenticated. So the containment
 * is the response's own `Content-Security-Policy: sandbox …` (no
 * allow-same-origin) on EVERY proxied response: the document gets an opaque
 * origin, its fetches carry no cookie, and the desktop's cookie is out of
 * its reach. Its own requests back to `/apps/<id>/…` — assets, its API —
 * are let through by the middleware WITHOUT a cookie for that reason (a
 * document navigation still needs one), which exposes the app's routes to
 * whoever has the address — the reason the listener check above exists.
 *
 * THE BASE PATH
 *
 * The path reaches the app unchanged: `/apps/<id>/api/x` is what the
 * upstream sees, so an app built for this serves under that base path
 * (Next.js `basePath`, Vite `base`, an Express `app.use("/apps/<id>")`) and
 * its absolute asset URLs keep working. A manifest may say
 * `stripBasePath: true` for an app that serves at `/` with relative links.
 */
import fs from "fs";
import path from "path";
import { runChild } from "@/lib/child-run";
import { APP_ID_RE, projectPath, webappPath, writeWebappIndex } from "@/lib/code-projects";
import { get as configGet } from "@/lib/config-store";
import { isInside } from "@/lib/file-guard";
import { appProxyPath, type ClawboxManifest, isProxyablePort } from "@/lib/clawbox-manifest";
import { pushPendingAction } from "@/lib/pending-actions";
import { registerWebappInPreferences } from "@/lib/webapp-registry";

export const APP_PROXY_PREFIX = "/apps/";

/** The sandbox every proxied response is served under — everything but allow-same-origin. */
export const APP_PROXY_CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-orientation-lock";

/**
 * The `Access-Control-Allow-Origin` a proxied response needs, or null when it
 * needs none.
 *
 * The sandbox above is what makes this necessary. A document served under
 * `Content-Security-Policy: sandbox` (no allow-same-origin) has the opaque
 * origin `null`, and a module script or a `crossorigin` stylesheet — which
 * is everything a Vite build emits, and every ES-module app whatever built it
 * — is fetched WITH CORS. The app's own server never had a reason to answer
 * CORS, so both fetches died with "from origin 'null' has been blocked" and
 * the window was an empty #root with nothing on screen to say why.
 *
 * The proxy imposes the opaque origin, so the proxy answers for it — and
 * only for it: `null` is echoed back, any other origin gets nothing, and an
 * app that sets its own policy keeps it. Never with
 * `Access-Control-Allow-Credentials`: the cookie is stripped on the way in
 * (a document here could not use one anyway), and answering an origin WITH
 * credentials is the hole this is not.
 */
export function appProxyAllowOrigin(requestOrigin: string | null, upstreamAllowOrigin: string | null): string | null {
  if (upstreamAllowOrigin) return null;
  return requestOrigin === "null" ? "null" : null;
}

/** How long a listener verdict is trusted: an "owned" one for this long, a refusal for a fraction of it, so a server just started is picked up on the next try. */
export const LISTENER_CHECK_TTL_MS = 30_000;
export const LISTENER_REFUSAL_TTL_MS = 3_000;

export interface AppProxyTarget {
  id: string;
  port: number;
  stripBasePath: boolean;
  /** The project folder the listener must run from. */
  directory: string;
}

export type ListenerVerdict = "owned" | "not_listening" | "not_owned" | "unverifiable";

export type AppProxyResolution =
  | { ok: true; target: AppProxyTarget }
  | { ok: false; reason: "unregistered" | ListenerVerdict; detail: string };

/** `/apps/<id>/rest` → the id and the rest, or null when the path is not one of ours. */
export function parseAppProxyPath(pathname: string): { id: string; rest: string } | null {
  if (!pathname.startsWith(APP_PROXY_PREFIX)) return null;
  const after = pathname.slice(APP_PROXY_PREFIX.length);
  const slash = after.indexOf("/");
  const id = slash === -1 ? after : after.slice(0, slash);
  if (!id || !APP_ID_RE.test(id)) return null;
  return { id, rest: slash === -1 ? "" : after.slice(slash) };
}

/** Is this request for a document (a navigation), as opposed to an asset or an API call the document makes? */
export function isDocumentRequest(headers: Headers): boolean {
  const dest = headers.get("sec-fetch-dest");
  if (dest) return dest === "document" || dest === "iframe" || dest === "frame" || dest === "embed" || dest === "object";
  // No fetch metadata (an older browser, curl): a navigation asks for HTML.
  const accept = headers.get("accept") ?? "";
  return accept.includes("text/html");
}

interface StoredMeta {
  name?: unknown;
  color?: unknown;
  icon?: unknown;
  port?: unknown;
  stripBasePath?: unknown;
  directory?: unknown;
}

async function readMeta(id: string): Promise<StoredMeta | null> {
  try {
    const text = await fs.promises.readFile(path.join(webappPath(id), "meta.json"), "utf-8");
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as StoredMeta) : null;
  } catch {
    return null;
  }
}

/**
 * The owner's project folder, read straight from the config store: the same
 * key coding-agent.ts's CODING_AGENT_DIR_CONFIG_KEY names (pinned by the
 * test), read here rather than imported because coding-agent.ts imports
 * THIS module for the settle-time registration.
 */
export const PROJECT_FOLDER_CONFIG_KEY = "coding_agent_default_directory";

/**
 * The folder an app id names when its registration predates the `directory`
 * field: `<project folder>/<id>`, or the code project of that id. Null when
 * neither is a folder.
 */
export async function projectFolderFor(id: string): Promise<string | null> {
  if (!APP_ID_RE.test(id)) return null;
  const root = await configGet(PROJECT_FOLDER_CONFIG_KEY);
  const candidates = [
    ...(typeof root === "string" && path.isAbsolute(root) ? [path.join(root, id)] : []),
    projectPath(id),
  ];
  for (const dir of candidates) {
    const stat = await fs.promises.stat(dir).catch(() => null);
    if (stat?.isDirectory()) return dir;
  }
  return null;
}

// ── Whose listener is it ─────────────────────────────────────────────────────

const verdicts = new Map<string, { verdict: ListenerVerdict; at: number }>();

/** For the tests: forget every cached verdict. */
export function _resetListenerCacheForTests(): void {
  verdicts.clear();
}

/**
 * Does a process of THIS user, running from inside `directory`, listen on
 * `port`? `ss -ltnp` names the pid of a listener the caller may see — its
 * own processes, which is what a run's server is — and nothing for another
 * user's, which is how the box's own port 80 and a root daemon are refused.
 */
export async function listenerOwnedBy(port: number, directory: string): Promise<ListenerVerdict> {
  const key = `${port}:${directory}`;
  const cached = verdicts.get(key);
  const now = Date.now();
  if (cached && now - cached.at < (cached.verdict === "owned" ? LISTENER_CHECK_TTL_MS : LISTENER_REFUSAL_TTL_MS)) return cached.verdict;
  const verdict = await checkListener(port, directory);
  verdicts.set(key, { verdict, at: now });
  return verdict;
}

async function checkListener(port: number, directory: string): Promise<ListenerVerdict> {
  if (!isProxyablePort(port)) return "not_owned";
  const r = await runChild("ss", ["-H", "-l", "-t", "-n", "-p", `sport = :${port}`], {
    timeoutMs: 5_000,
    env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
  });
  if (r.code !== 0) return "unverifiable";
  const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "not_listening";
  // Only a row the proxy can actually reach at 127.0.0.1 vouches for the
  // port: a project's listener bound to some other local address must not
  // authorise a different service answering on loopback.
  const reachable = lines.filter((l) => isLoopbackListenRow(l));
  if (reachable.length === 0) return "not_listening";
  const pids = [...new Set([...reachable.join("\n").matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  if (pids.length === 0) return "not_owned";
  const real = await fs.promises.realpath(directory).catch(() => directory);
  for (const pid of pids) {
    const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => null);
    if (cwd && isInside(cwd, real)) return "owned";
  }
  return "not_owned";
}

/** Is this `ss -H -ltn` row bound where 127.0.0.1 reaches it — loopback or every address? */
export function isLoopbackListenRow(row: string): boolean {
  // State Recv-Q Send-Q Local:Port Peer:Port [Process]
  const local = row.split(/\s+/)[3] ?? "";
  const host = local.slice(0, local.lastIndexOf(":"));
  return host === "127.0.0.1" || host === "0.0.0.0" || host === "*" || host === "[::]" || host === "::" || host === "[::1]" || host === "::ffff:127.0.0.1" || host === "[::ffff:127.0.0.1]";
}

/** The sentence for a listener verdict, for the owner. */
export function listenerRefusal(verdict: Exclude<ListenerVerdict, "owned">, port: number): string {
  switch (verdict) {
    case "not_listening": return `Nothing is listening on port ${port}. Start the app in its project folder — its clawbox.json says how.`;
    case "not_owned": return `Port ${port} is not served by the project: the box proxies only a server started from inside the project folder, by this user.`;
    case "unverifiable": return `The box could not tell who is listening on port ${port} (the socket listing failed).`;
  }
}

/**
 * Where `/apps/<id>/` goes: a REGISTERED app (meta.json carries the port),
 * whose listener runs from its project folder right now.
 */
export async function resolveAppProxyTarget(id: string): Promise<AppProxyResolution> {
  if (!APP_ID_RE.test(id)) return { ok: false, reason: "unregistered", detail: "No app is served under this name." };
  const meta = await readMeta(id);
  if (!meta || !isProxyablePort(meta.port)) {
    return { ok: false, reason: "unregistered", detail: "No app is served under this name. A project declares its server's port in clawbox.json and is put on the desktop from the Coding Agent." };
  }
  const directory = typeof meta.directory === "string" && path.isAbsolute(meta.directory) ? meta.directory : await projectFolderFor(id);
  if (!directory) return { ok: false, reason: "not_owned", detail: listenerRefusal("not_owned", meta.port) };
  const verdict = await listenerOwnedBy(meta.port, directory);
  if (verdict !== "owned") return { ok: false, reason: verdict, detail: listenerRefusal(verdict, meta.port) };
  return { ok: true, target: { id, port: meta.port, stripBasePath: meta.stripBasePath === true, directory } };
}

/** The one-file stub the webapp route still serves for the id: it sends the frame to the proxied path. */
export function serverAppStubHtml(name: string, id: string): string {
  const safeName = name.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeName}</title><style>body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}a{color:#f97316}</style></head><body><p>Opening ${safeName}… <a href="${appProxyPath(id)}" target="_top">Open</a></p><script>location.replace(${JSON.stringify(appProxyPath(id))});</script></body></html>`;
}

export type RegisterOutcome = { ok: true } | { ok: false; reason: Exclude<ListenerVerdict, "owned"> | "failed"; detail: string };

/**
 * Put a project with a server on the desktop: its icon opens
 * `/apps/<id>/`, and the port and the folder land in meta.json for the
 * proxy to read — AFTER the listener has been found to be the project's
 * own. Never throws.
 */
export async function registerServerApp(input: { id: string; directory: string; manifest: ClawboxManifest }): Promise<RegisterOutcome> {
  const { id, directory, manifest } = input;
  if (!APP_ID_RE.test(id) || !manifest.port) return { ok: false, reason: "failed", detail: "The manifest names no port." };
  const verdict = await listenerOwnedBy(manifest.port, directory);
  if (verdict !== "owned") return { ok: false, reason: verdict, detail: listenerRefusal(verdict, manifest.port) };
  try {
    const existing = await readMeta(id);
    await writeWebappIndex(id, serverAppStubHtml(manifest.name, id));
    await fs.promises.writeFile(
      path.join(webappPath(id), "meta.json"),
      JSON.stringify({
        name: manifest.name,
        color: typeof existing?.color === "string" ? existing.color : "#f97316",
        icon: typeof existing?.icon === "string" ? existing.icon : "",
        port: manifest.port,
        directory: path.resolve(directory),
        ...(manifest.stripBasePath ? { stripBasePath: true } : {}),
      }),
      "utf-8",
    );
    await registerWebappInPreferences(id, manifest.name, {
      webappUrl: appProxyPath(id),
      description: manifest.description ?? undefined,
    });
    await pushPendingAction({ type: "register_webapp", appId: id, name: manifest.name, color: "#f97316", url: appProxyPath(id) }).catch(() => undefined);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[app-proxy] could not register ${id}: ${detail}`);
    return { ok: false, reason: "failed", detail: `Registering the app failed: ${detail}`.slice(0, 300) };
  }
}
