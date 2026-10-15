/**
 * Shared bits of the `/setup-api/prime-radiant/*` routes: one JSON shape for
 * answers (never cached) and one for failures (`{ error, code }`).
 *
 * SERVER ONLY.
 */

import { NextResponse } from "next/server";
import { resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { isOwnOutput } from "./ingest-sources";

/** Folders one ingest (or its preview) may name. */
export const MAX_INGEST_FOLDERS = 20;

/**
 * The folders an ingest was asked to read, each resolved the folder picker's
 * way (inside the tree the Files app browses, never a credential store) and
 * never ClawBox's own output; duplicates folded. The failure names the
 * offending folder's `index`.
 */
export async function resolveIngestFolders(asked: unknown): Promise<{ ok: true; folders: string[] } | { ok: false; response: NextResponse }> {
  if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAX_INGEST_FOLDERS) {
    return { ok: false, response: fail("invalid", `Choose between 1 and ${MAX_INGEST_FOLDERS} folders.`, 400) };
  }
  const folders: string[] = [];
  for (const [index, folder] of asked.entries()) {
    const resolved = await resolveFolderInsideBrowseRoot(folder);
    if (!resolved.ok) {
      return {
        ok: false,
        response: json({ error: resolved.status === 400 ? "That is not a folder." : "Folder not found.", code: "folder_not_found", index }, resolved.status),
      };
    }
    if (isOwnOutput(resolved.dir)) {
      return { ok: false, response: json({ error: "That folder holds ClawBox's own files.", code: "folder_refused", index }, 400) };
    }
    if (!folders.includes(resolved.dir)) folders.push(resolved.dir);
  }
  return { ok: true, folders };
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(code: string, error: string, status: number): NextResponse {
  return json({ error, code }, status);
}

/** A failure inside the vault layer, logged with its reason and answered without it. */
export function vaultFailure(where: string, err: unknown): NextResponse {
  console.error(`[prime-radiant] ${where}:`, err instanceof Error ? err.message : err);
  return fail("vault_unavailable", "The Prime Radiant vault could not be read.", 500);
}

/**
 * The gate every mutating Prime Radiant route keeps: a session (owner or the
 * MCP bearer, through `requireSession`), then the owner's own browser cookie
 * (the bearer is refused 403 `owner_only`), then our own page (a cross-site
 * form riding the cookie is refused 403 `cross_origin`). Null when admitted.
 */
export async function ownerWriteGuard(req: Request, what: string): Promise<NextResponse | null> {
  const denied = await requireSession(req);
  if (denied) return denied;
  if (!(await hasOwnerSession(req))) return fail("owner_only", `${what} needs a signed-in browser session.`, 403);
  if (!isSameOriginRequest(req)) return fail("cross_origin", "This request did not come from the ClawBox desktop.", 403);
  return null;
}

/** A JSON request body of at most `maxBytes`, or the failure to answer with. */
export async function readJsonBody(req: Request, maxBytes = 64 * 1024): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: fail("invalid", "The request body could not be read.", 400) };
  }
  if (text.length > maxBytes) return { ok: false, response: fail("invalid", "The request is too large.", 413) };
  if (text.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: fail("invalid", "The request body is not JSON.", 400) };
  }
}

/** The non-blocking `same origin` half of the write guard, for a write the MCP bearer may make. */
export function crossOriginRefusal(req: Request): NextResponse | null {
  return isSameOriginRequest(req) ? null : fail("cross_origin", "This request did not come from the ClawBox desktop.", 403);
}
