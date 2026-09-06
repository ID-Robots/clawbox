export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import {
  APP_ID_RE,
  LEGACY_STUB_MAX_BYTES,
  ValidationError,
  deployWebapp,
  legacyRedirectPort,
  serverAppDownHtml,
  webappPath,
  writeWebappIndex,
} from "@/lib/code-projects";
import { listenerOwnedBy, listenerRefusal, projectFolderFor, registerServerApp, serverAppStubHtml } from "@/lib/app-proxy";
import { readClawboxManifest } from "@/lib/clawbox-manifest";
import { createSerialLock } from "@/lib/serial-lock";

/**
 * One desktop registration at a time.
 *
 * Putting an app on the desktop reads `pref:installed_apps` and
 * `pref:installed_meta` out of config.json, adds one entry and writes the whole
 * map back (`registerWebappInPreferences`, reached from both
 * `registerServerApp` and `deployWebapp`). There are awaits between that read
 * and the write, so two registrations in flight together each start from the
 * same snapshot and the second one's write drops the first one's entry: a
 * legacy stub migrated while another app was being created took that app off
 * the desktop — its files still on disk, no icon anywhere.
 *
 * This lock covers the two registrations started HERE, which is where the
 * migration below made a second one reachable from a plain GET. The
 * read-modify-write itself lives in src/lib/webapp-registry.ts, so a
 * registration begun on another route (apps/install, a coding run's settle)
 * can still race one of ours — closing that off needs the same lock one level
 * down, in the registry.
 */
const withDesktopRegistration = createSerialLock();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function htmlPage(html: string, status = 200): NextResponse {
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** The app's saved display name, or its id when there is no readable meta.json. */
async function appDisplayName(appId: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(webappPath(appId), "meta.json"), "utf-8"));
    const name = parsed && typeof parsed === "object" ? (parsed as { name?: unknown }).name : null;
    return typeof name === "string" && name.trim() ? name : appId;
  } catch {
    return appId;
  }
}

/**
 * What to serve INSTEAD of a legacy `location.hostname:<port>` stub — or null
 * when the stub is still the right answer.
 *
 * Those stubs predate `/apps/<id>/` (src/lib/app-proxy.ts) and are still on
 * disk on every box that shipped. Two things go wrong with one:
 *
 *  - the link names a host and a port, which is right only on the LAN: through
 *    a tunnel the box is port 80 and nothing else, and the hostname changes
 *    every time the tunnel restarts;
 *  - when the app's server is not running the window is whatever the browser
 *    makes of ERR_CONNECTION_REFUSED — an empty white rectangle with no way to
 *    tell "not started" from "broken", which is the defect this fixes.
 *
 * So: a project that declares a port in its clawbox.json knows the proxy
 * convention and is MIGRATED once (the same registration the Coding Agent
 * performs, listener check included, so nothing here trusts the manifest
 * alone). Anything else is left exactly as it is while something answers on
 * the port — the stub works on the LAN today and a page of ours in its place
 * would be a regression — and is replaced by the box's own sentence only when
 * the port is silent, which is the white rectangle.
 */
async function answerForLegacyStub(appId: string, html: string): Promise<NextResponse | null> {
  const port = legacyRedirectPort(html);
  if (port === null) return null;

  const directory = await projectFolderFor(appId);
  const manifest = directory ? await readClawboxManifest(directory) : null;
  if (directory && manifest?.port) {
    const outcome = await withDesktopRegistration(() => registerServerApp({ id: appId, directory, manifest }));
    // A refusal is not the end of it: the manifest may name a port the owner
    // has not started while the stub's own port is serving happily.
    if (outcome.ok) return htmlPage(serverAppStubHtml(manifest.name, appId));
  }

  const verdict = await listenerOwnedBy(port, directory ?? webappPath(appId));
  if (verdict !== "not_listening") return null;
  return htmlPage(serverAppDownHtml(await appDisplayName(appId), listenerRefusal("not_listening", port)), 502);
}

/**
 * GET /setup-api/webapps?app=<appId>           — serve index.html
 * GET /setup-api/webapps?app=<appId>&file=x.js — serve asset file
 */
export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("app");
  if (!appId || !APP_ID_RE.test(appId)) {
    return NextResponse.json({ error: "Invalid app ID" }, { status: 400 });
  }

  const file = request.nextUrl.searchParams.get("file") || "index.html";

  // Prevent path traversal, in both halves of the path: the app's own folder
  // comes from `webappPath`, which builds it from the id REBUILT out of the
  // alphabet rather than from the string that passed APP_ID_RE (a `.test()`
  // leaves the caller's value in play — the discipline safeProjectId,
  // safeSkillName and safeAppId all state), and the containment check below
  // covers the `file` half.
  //
  // Caught, because `webappPath` REFUSES by throwing. APP_ID_RE and the
  // alphabet it rebuilds from say the same thing today, so this cannot fire —
  // but this route's whole point is that the two are separate rules that have
  // moved before, and the POST below already answers 400 for that throw. An
  // uncaught one here would be a 500 over a bad query string.
  let appDir: string;
  try {
    appDir = webappPath(appId);
  } catch {
    return NextResponse.json({ error: "Invalid app ID" }, { status: 400 });
  }
  const filePath = path.resolve(appDir, file);
  if (!filePath.startsWith(appDir + path.sep) && filePath !== appDir) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  try {
    const content = await fs.readFile(filePath);

    // Only the app's own document, and only one small enough to BE a stub:
    // an app's real index.html must never be decoded to look at.
    if (filePath === path.join(appDir, "index.html") && content.length <= LEGACY_STUB_MAX_BYTES) {
      // Its own catch: the enclosing one answers 404 "File not found", and a
      // failed listener probe must not turn a file that IS there into one that
      // is not. Falling through serves the stub, which is what happened before.
      let answer: NextResponse | null = null;
      try {
        answer = await answerForLegacyStub(appId, content.toString("utf-8"));
      } catch (err) {
        console.warn(`[webapps] could not check the ${appId} stub: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (answer) return answer;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    return new NextResponse(content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}

/** POST /setup-api/webapps — create/update a webapp */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appId, html, name, color, icon } = body;

    if (!appId || !APP_ID_RE.test(appId)) {
      return NextResponse.json({ error: "Invalid app ID" }, { status: 400 });
    }
    if (!html || typeof html !== "string") {
      return NextResponse.json({ error: "HTML content required" }, { status: 400 });
    }
    if (Buffer.byteLength(html, "utf-8") > 1_048_576) {
      return NextResponse.json({ error: "HTML content too large (max 1MB)" }, { status: 413 });
    }

    // Distinguish a create from an update by whether the payload carries a
    // `name` property — not its truthiness. A POST with `name: ""` is an
    // invalid create (400), not a silent update that would leave the app
    // without meta.json or desktop registration.
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    if (hasName) {
      // Create: write index.html + meta.json and durably register on the
      // desktop via the shared chokepoint (keeps the on-disk layout in lockstep
      // with buildProject, and the app appears even if the desktop wasn't open
      // to consume the ui:pending-action handoff).
      if (typeof name !== "string" || name.trim() === "") {
        return NextResponse.json({ error: "Name is required" }, { status: 400 });
      }
      await withDesktopRegistration(() => deployWebapp(appId, html, { name, color, icon }));
    } else {
      // Update: only rewrite the HTML. Re-stamping meta.json here would clobber
      // the saved display name (an update carries no `name`), and re-registering
      // is unnecessary — the app is already on the desktop. Reject updates to an
      // app that was never created so a typo'd appId can't half-deploy.
      const exists = await fs
        .stat(path.join(webappPath(appId), "meta.json"))
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return NextResponse.json({ error: "Webapp not found" }, { status: 404 });
      }
      await writeWebappIndex(appId, html);
    }

    return NextResponse.json({
      success: true,
      url: `/setup-api/webapps?app=${appId}`,
    });
  } catch (err) {
    // A rejected field is the caller's to fix, so answer 400 rather than
    // reporting it as a server failure.
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create webapp" },
      { status: 500 }
    );
  }
}
