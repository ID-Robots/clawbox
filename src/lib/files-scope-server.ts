import fs from "fs";
import path from "@/lib/runtime-path";
import { NextResponse } from "next/server";
import { fenceFor, memberRoots, ownerScope, type FilesFence } from "@/lib/files-scope";

/**
 * Who a Files request is served as (TASK-2377) — the request half of
 * src/lib/files-scope.ts. SERVER ONLY.
 *
 *   - no person (the agent's MCP bearer), the owner, or any user of a HOME box
 *     (`org_mode` off): the owner's browse root, exactly as before;
 *   - a member of staff on an ORGANISATION box: their own home and the shared
 *     folder, nothing else;
 *   - a signed-in user other than the owner on a box whose switch cannot be
 *     read: refused 503 `org_mode_unknown` — never handed the owner's home
 *     because data/config.json was unreadable for a moment.
 *
 * A home the web server cannot reach yet is handed to the root-owned helper
 * once (`home_access`, which lays the owner's ACL on it) and then served; a
 * box whose helper predates the verb, or whose filesystem carries no ACL,
 * answers 503 `home_unavailable` rather than anything of the owner's.
 */

export type FilesFenceAnswer = { ok: true; fence: FilesFence } | { ok: false; response: NextResponse };

function refuse(status: number, code: string, error: string): FilesFenceAnswer {
  return { ok: false, response: NextResponse.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } }) };
}

/** Homes looked up recently (getent forks a process): name → home, for a minute. */
const homeCache = new Map<string, { home: string; at: number }>();
const HOME_CACHE_MS = 60_000;
/** A helper that just failed for a user is not asked again for this long. */
const GRANT_RETRY_MS = 60_000;
const lastGrantFailure = new Map<string, number>();
/** One helper run per user at a time: the Files app sends several requests at once. */
const grantsInFlight = new Map<string, Promise<string>>();

/**
 * Ask the helper for a user's home once, whoever else is waiting for it. A
 * run that did not answer `ok` is remembered as a failure even when the home
 * itself opened (the helper lays the home's own ACL first, then walks what is
 * inside it, and a walk that failed half-way leaves folders unreadable), so
 * it is asked again after GRANT_RETRY_MS.
 */
function grantOnce(username: string): Promise<string> {
  const running = grantsInFlight.get(username);
  if (running) return running;
  const run = (async () => {
    const { grantHomeAccess } = await import("@/lib/clawbox-users");
    const result = await grantHomeAccess(username);
    if (result === "ok") lastGrantFailure.delete(username);
    else {
      lastGrantFailure.set(username, Date.now());
      console.error(`[files] ${username}'s home could not be opened to the Files app (${result})`);
    }
    return result;
  })().finally(() => grantsInFlight.delete(username));
  grantsInFlight.set(username, run);
  return run;
}

async function homeOf(username: string): Promise<string | null> {
  const cached = homeCache.get(username);
  if (cached && Date.now() - cached.at < HOME_CACHE_MS) return cached.home;
  const { userHomeDir } = await import("@/lib/clawbox-users");
  const home = await userHomeDir(username);
  if (home) homeCache.set(username, { home, at: Date.now() });
  return home;
}

function reachable(dir: string): boolean {
  try {
    fs.accessSync(/* turbopackIgnore: true */ dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the caches between cases. */
export function resetFilesScopeCachesForTests(): void {
  homeCache.clear();
  lastGrantFailure.clear();
  grantsInFlight.clear();
}

export async function filesFenceFor(request: Request): Promise<FilesFenceAnswer> {
  const { personSession } = await import("@/lib/owner-session");
  const who = await personSession(request);
  if (!who) {
    // No person: the agent's bearer. A request that DOES carry a session
    // cookie whose identity could not be resolved here (a registry read that
    // failed) is not the owner — refused, never served the owner's home.
    if (/(?:^|;\s*)clawbox_session=/.test(request.headers.get("cookie") ?? "")) {
      return refuse(503, "session_unknown", "Who is signed in could not be checked just now. Try again in a moment.");
    }
    return { ok: true, fence: fenceFor(ownerScope()) };
  }
  if (who.isOwner) return { ok: true, fence: fenceFor(ownerScope()) };
  const { readOrgModeStrict } = await import("@/lib/org-mode-server");
  const on = await readOrgModeStrict();
  if (on === null) return refuse(503, "org_mode_unknown", "The box's settings could not be read just now. Try again in a moment.");
  if (!on) return { ok: true, fence: fenceFor(ownerScope()) };

  const username = who.username;
  const home = await homeOf(username);
  if (!home) return refuse(503, "home_unavailable", "Your home folder could not be found on this box. Ask your administrator.");
  const failedAt = lastGrantFailure.get(username);
  const retryDue = failedAt !== undefined && Date.now() - failedAt >= GRANT_RETRY_MS;
  if (!reachable(home)) {
    // Never asked yet in this process, or the last run failed long enough ago.
    const asked = failedAt === undefined || retryDue;
    if (asked) await grantOnce(username);
    if (!reachable(home)) {
      // Even an `ok` that left the home closed is a failure to wait out.
      if (asked) lastGrantFailure.set(username, Date.now());
      return refuse(503, "home_unavailable", "Your home folder is not ready on this box yet. Ask your administrator to update the ClawBox.");
    }
  } else if (retryDue) {
    // The home opened but the last run failed part-way: finish it, without
    // holding this request up.
    void grantOnce(username);
  }
  const roots = memberRoots(home);
  if (!roots.ok) {
    return roots.code === "shared_unavailable"
      ? refuse(503, "shared_unavailable", "The shared folder could not be prepared. Ask your administrator.")
      : refuse(503, "home_unavailable", "Your home folder cannot be served on this box. Ask your administrator.");
  }
  // The same three folders the owner's home is given, so the Files app's
  // places lead somewhere; the default ACL makes them the member's too.
  for (const sub of ["Documents", "Downloads", "Desktop"]) {
    const dir = path.join(roots.roots[0].real, sub);
    try {
      if (!fs.existsSync(/* turbopackIgnore: true */ dir)) fs.mkdirSync(/* turbopackIgnore: true */ dir);
    } catch {
      // a read-only or full home still lists
    }
  }
  return { ok: true, fence: fenceFor({ kind: "member", username, roots: roots.roots }) };
}
