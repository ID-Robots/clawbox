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
}

export async function filesFenceFor(request: Request): Promise<FilesFenceAnswer> {
  const { personSession } = await import("@/lib/owner-session");
  const who = await personSession(request);
  if (!who || who.isOwner) return { ok: true, fence: fenceFor(ownerScope()) };
  const { readOrgModeStrict } = await import("@/lib/org-mode-server");
  const on = await readOrgModeStrict();
  if (on === null) return refuse(503, "org_mode_unknown", "The box's settings could not be read just now. Try again in a moment.");
  if (!on) return { ok: true, fence: fenceFor(ownerScope()) };

  const username = who.username;
  const home = await homeOf(username);
  if (!home) return refuse(503, "home_unavailable", "Your home folder could not be found on this box. Ask your administrator.");
  if (reachable(home)) {
    lastGrantFailure.delete(username);
  } else {
    const failedAt = lastGrantFailure.get(username);
    let asked = false;
    if (failedAt === undefined || Date.now() - failedAt >= GRANT_RETRY_MS) {
      asked = true;
      const { grantHomeAccess } = await import("@/lib/clawbox-users");
      const result = await grantHomeAccess(username);
      if (result !== "ok") console.error(`[files] ${username}'s home could not be opened to the Files app (${result})`);
    }
    if (!reachable(home)) {
      // The window runs from the last time the helper was ASKED.
      if (asked) lastGrantFailure.set(username, Date.now());
      return refuse(503, "home_unavailable", "Your home folder is not ready on this box yet. Ask your administrator to update the ClawBox.");
    }
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
