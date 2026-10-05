import { NextRequest, NextResponse } from "next/server";
import { ownerOnlyResponse, sessionIdentity } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  backUpNow,
  backupOverview,
  disconnectFolder,
  firstBackup,
  folderBackupStatus,
  ProjectBackupError,
  runningStage,
  setAutoBackup,
} from "@/lib/project-backup";
import { dismissSuggestion } from "@/lib/project-backup-store";
import { logSafe } from "@/lib/log-safe";

export const dynamic = "force-dynamic";

// Projects → GitHub backup (TASK-1358, src/lib/project-backup.ts).
//
// GET                                   → overview: { github, folders, suggestionDismissedAt }
// GET  ?path=…                          → one folder: FolderBackupStatus
// GET  ?path=…&stage=1                  → { running } — the progress line's poll, no network
// POST { action: "first_backup", path, name? }   → the private copy, first upload
// POST { action: "backup_now", path }            → commit what changed and push
// POST { action: "auto", path, enabled }         → the daily auto-backup switch
// POST { action: "disconnect", path }            → stop backing it up (the GitHub copy stays)
// POST { action: "dismiss_suggestion" }          → "Not now" on the Projects card
//
// OWNER ONLY, every verb, by the session cookie — not the agent's bearer: this
// pushes the owner's files to the owner's GitHub account with the owner's gh
// login, and the party that holds that login must be the one asking. A
// signed-in non-owner (TASK-1256) gets 403 `owner_only`; Files is not one of
// their apps, and the GitHub sign-in is not per user. Writes are also OUR
// PAGES ONLY (src/lib/same-origin.ts), like the GitHub sign-in itself.

async function gate(req: Request, write: boolean): Promise<NextResponse | null> {
  const who = await sessionIdentity(req);
  if (!who) return NextResponse.json({ error: "Sign in to back up project folders.", code: "unauthenticated" }, { status: 401 });
  if (!who.isOwner) return ownerOnlyResponse();
  if (write && !isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Backups only start from this ClawBox's own pages.", code: "cross_origin" }, { status: 403 });
  }
  return null;
}

function refusal(err: unknown, fallback: string): NextResponse {
  if (err instanceof ProjectBackupError) {
    return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
  }
  console.error(`[project-backup] ${fallback}:`, err instanceof Error ? logSafe(err.message) : err);
  return NextResponse.json({ error: fallback, code: "failed" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const denied = await gate(req, false);
  if (denied) return denied;
  const folder = req.nextUrl.searchParams.get("path");
  try {
    if (folder !== null && req.nextUrl.searchParams.get("stage") === "1") {
      return NextResponse.json({ running: runningStage(folder) });
    }
    if (folder !== null) return NextResponse.json(await folderBackupStatus(folder));
    return NextResponse.json(await backupOverview());
  } catch (err) {
    return refusal(err, "Could not read the backup state");
  }
}

const ACTIONS = ["first_backup", "backup_now", "auto", "disconnect", "dismiss_suggestion"] as const;

export async function POST(req: NextRequest) {
  const denied = await gate(req, true);
  if (denied) return denied;
  const parsed: unknown = await req.json().catch(() => null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "Invalid request body", code: "invalid" }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;
  // Drawn from the allow-list, not compared against it (see github-login).
  const action = ACTIONS.find((a) => a === body.action);
  if (!action) {
    return NextResponse.json({ error: `Unknown action: ${logSafe(String(body.action))}`, code: "invalid" }, { status: 400 });
  }
  try {
    switch (action) {
      case "first_backup":
        return NextResponse.json(await firstBackup(body.path, { name: body.name }));
      case "backup_now":
        return NextResponse.json(await backUpNow(body.path));
      case "auto":
        return NextResponse.json({ ok: true, ...(await setAutoBackup(body.path, body.enabled)) });
      case "disconnect":
        return NextResponse.json({ ok: true, ...(await disconnectFolder(body.path)) });
      case "dismiss_suggestion":
        return NextResponse.json({ ok: true, dismissedAt: await dismissSuggestion() });
    }
  } catch (err) {
    return refusal(err, "The backup did not finish");
  }
}
