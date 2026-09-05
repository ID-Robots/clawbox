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
 * WHICH PORT
 *
 * The project's clawbox.json (`port`, src/lib/clawbox-manifest.ts) is the
 * declaration; `registerServerApp` copies it into the app's
 * data/webapps/<id>/meta.json when the run settles, so the proxy has one
 * place to read at request time and production-server.js's upgrade router
 * (plain CJS, no imports from here) can mirror the same read for the app's
 * websockets. The manifest is the fallback, for a project that carries one
 * but has not been registered yet.
 *
 * WHAT PROTECTS THE DESKTOP
 *
 * The app is code the agent wrote, and here it is served from the DESKTOP'S
 * origin. Framed without a sandbox it would run with the owner's session
 * and reach every owner-only route; the iframe sandbox that boxes a one-file
 * webapp does not fit, because a sandboxed frame's navigation carries no
 * cookies and the document itself must be authenticated. So the containment
 * is the response's own `Content-Security-Policy: sandbox …` (no
 * allow-same-origin): the document gets an opaque origin, its fetches carry
 * no cookie, and the desktop's cookie is out of its reach. Its own requests
 * back to `/apps/<id>/…` — assets, its API — are let through by the
 * middleware WITHOUT a cookie for that reason (a document navigation still
 * needs one), which exposes the app's routes to whoever has the address
 * exactly as its port on 0.0.0.0 is exposed on the LAN today.
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
import { APP_ID_RE, webappPath, writeWebappIndex } from "@/lib/code-projects";
import { get as configGet } from "@/lib/config-store";
import { appProxyPath, type ClawboxManifest, isProxyablePort, readClawboxManifest } from "@/lib/clawbox-manifest";
import { pushPendingAction } from "@/lib/pending-actions";
import { registerWebappInPreferences } from "@/lib/webapp-registry";

export const APP_PROXY_PREFIX = "/apps/";

/** The sandbox every proxied document is served under — everything but allow-same-origin. */
export const APP_PROXY_CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-orientation-lock";

export interface AppProxyTarget {
  id: string;
  port: number;
  stripBasePath: boolean;
}

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
  port?: unknown;
  stripBasePath?: unknown;
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

/** The project folder an app id names: `<project folder>/<id>`, when there is a project folder. */
export async function projectFolderFor(id: string): Promise<string | null> {
  if (!APP_ID_RE.test(id)) return null;
  const root = await configGet(PROJECT_FOLDER_CONFIG_KEY);
  return typeof root === "string" && path.isAbsolute(root) ? path.join(root, id) : null;
}

/**
 * Where `/apps/<id>/` goes: the registered meta's port first, the project's
 * manifest second, nothing otherwise.
 */
export async function resolveAppProxyTarget(id: string): Promise<AppProxyTarget | null> {
  if (!APP_ID_RE.test(id)) return null;
  const meta = await readMeta(id);
  if (meta && isProxyablePort(meta.port)) return { id, port: meta.port, stripBasePath: meta.stripBasePath === true };
  const folder = await projectFolderFor(id);
  const manifest = folder ? await readClawboxManifest(folder) : null;
  if (manifest?.port) return { id, port: manifest.port, stripBasePath: manifest.stripBasePath };
  return null;
}

/** The one-file stub the webapp route still serves for the id: it sends the frame to the proxied path. */
export function serverAppStubHtml(name: string, id: string): string {
  const safeName = name.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeName}</title><style>body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}a{color:#f97316}</style></head><body><p>Opening ${safeName}… <a href="${appProxyPath(id)}" target="_top">Open</a></p><script>location.replace(${JSON.stringify(appProxyPath(id))});</script></body></html>`;
}

/**
 * Put a project with a server on the desktop: its icon opens
 * `/apps/<id>/`, and the port lands in meta.json for the proxy to read.
 * Never throws — an app that cannot be registered is a line in the log,
 * not a failed run.
 */
export async function registerServerApp(input: { id: string; manifest: ClawboxManifest }): Promise<boolean> {
  const { id, manifest } = input;
  if (!APP_ID_RE.test(id) || !manifest.port) return false;
  try {
    const existing = await readMeta(id);
    await writeWebappIndex(id, serverAppStubHtml(manifest.name, id));
    await fs.promises.writeFile(
      path.join(webappPath(id), "meta.json"),
      JSON.stringify({
        name: manifest.name,
        color: typeof (existing as { color?: unknown } | null)?.color === "string" ? (existing as { color: string }).color : "#f97316",
        icon: typeof (existing as { icon?: unknown } | null)?.icon === "string" ? (existing as { icon: string }).icon : "",
        port: manifest.port,
        ...(manifest.stripBasePath ? { stripBasePath: true } : {}),
      }),
      "utf-8",
    );
    await registerWebappInPreferences(id, manifest.name, {
      webappUrl: appProxyPath(id),
      description: manifest.description ?? undefined,
    });
    await pushPendingAction({ type: "register_webapp", appId: id, name: manifest.name, color: "#f97316", url: appProxyPath(id) }).catch(() => undefined);
    return true;
  } catch (err) {
    console.error(`[app-proxy] could not register ${id}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
