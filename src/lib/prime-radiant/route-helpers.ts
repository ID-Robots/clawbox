/**
 * Shared bits of the `/setup-api/prime-radiant/*` routes: one JSON shape for
 * answers (never cached) and one for failures (`{ error, code }`).
 *
 * SERVER ONLY.
 */

import { NextResponse } from "next/server";
import { resolveFileInsideBrowseRoot, resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { PageEditError } from "./edit";
import { ASSISTANT_AUTHOR, VAULT_AUTHOR, type VaultAuthor } from "./git";
import { isOwnOutput } from "./ingest-sources";
import { MAX_UPLOAD_FILES_PER_BATCH } from "./ingest-upload";
import { VaultLintBlockedError } from "./vault";
import { VerifyError } from "./verify";

/** Folders one ingest (or its preview) may name. */
export const MAX_INGEST_FOLDERS = 20;
/** Files one ingest may name: one upload batch's worth. */
export const MAX_INGEST_FILES = MAX_UPLOAD_FILES_PER_BATCH;

/**
 * The files an ingest was asked to read, each resolved like a folder (inside
 * the Files app's tree, never a credential store), never ClawBox's own output;
 * duplicates folded. The failure names the offending file's `index`.
 */
export async function resolveIngestFiles(asked: unknown): Promise<{ ok: true; files: Array<{ path: string; bytes: number }> } | { ok: false; response: NextResponse }> {
  if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAX_INGEST_FILES) {
    return { ok: false, response: fail("invalid", `Name between 1 and ${MAX_INGEST_FILES} files.`, 400) };
  }
  const files: Array<{ path: string; bytes: number }> = [];
  for (const [index, file] of asked.entries()) {
    const resolved = await resolveFileInsideBrowseRoot(file);
    if (!resolved.ok) {
      return {
        ok: false,
        response: json({ error: resolved.status === 400 ? "That is not a file." : "File not found.", code: "file_not_found", index }, resolved.status),
      };
    }
    if (isOwnOutput(resolved.file)) {
      return { ok: false, response: json({ error: "That file is one of ClawBox's own.", code: "file_refused", index }, 400) };
    }
    if (!files.some((f) => f.path === resolved.file)) files.push({ path: resolved.file, bytes: resolved.bytes });
  }
  return { ok: true, files };
}

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

/** The refusal a change the vault's lint would not take answers: 409 `lint_blocked`, naming the rules. */
export function lintBlocked(err: VaultLintBlockedError, error = "That change breaks a rule of the vault."): NextResponse {
  return json({ error, code: "lint_blocked", findings: err.findings.map((f) => ({ rule: f.rule, path: f.path, message: f.message })) }, 409);
}

const VERIFY_STATUS = { invalid: 400, not_found: 404, retired: 409, no_page: 404 } as const;

/** A failure of a page or claim edit (edit.ts, verify.ts), answered as its own code; anything else is {@link vaultFailure}. */
export function editFailure(where: string, err: unknown): NextResponse {
  if (err instanceof PageEditError) return fail(err.code, err.message, err.status);
  if (err instanceof VerifyError) return fail(err.code, err.message, VERIFY_STATUS[err.code]);
  if (err instanceof VaultLintBlockedError) return lintBlocked(err);
  return vaultFailure(where, err);
}

/**
 * The gate every owner-only Prime Radiant route keeps: a session (owner or the
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

/**
 * Who is making a Prime Radiant change, as stamps and commits record it:
 * the owner (`person`: their word), or the assistant through the box's MCP
 * server, whose commits are authored by {@link ASSISTANT_AUTHOR} so History
 * names it and the owner can undo it.
 */
export interface VaultWriter {
  by: "owner" | "assistant";
  author: VaultAuthor;
  person: boolean;
}

export const OWNER_WRITER: VaultWriter = Object.freeze({ by: "owner", author: VAULT_AUTHOR, person: true });
export const ASSISTANT_WRITER: VaultWriter = Object.freeze({ by: "assistant", author: ASSISTANT_AUTHOR, person: false });

/**
 * The gate a Prime Radiant change the ASSISTANT may also make keeps: a
 * session (`requireSession`), then our own page (a cross-site form riding the
 * owner's cookie is refused 403 `cross_origin`; the MCP server sends no
 * Origin), then WHO — the owner's own browser cookie, or the MCP bearer itself
 * (checked here again, not taken from the session check: middleware and
 * `requireSession` admit either, and only the bearer makes the caller the
 * assistant). Anything else — test mode with neither, a bootstrap window — is
 * refused 403 `owner_only`, as before.
 */
export async function writerGuard(req: Request, what: string): Promise<{ ok: true; writer: VaultWriter } | { ok: false; response: NextResponse }> {
  const denied = await requireSession(req);
  if (denied) return { ok: false, response: denied };
  if (!isSameOriginRequest(req)) return { ok: false, response: fail("cross_origin", "This request did not come from the ClawBox desktop.", 403) };
  if (await hasOwnerSession(req)) return { ok: true, writer: OWNER_WRITER };
  if (verifyMcpBearer(req.headers.get("authorization"))) return { ok: true, writer: ASSISTANT_WRITER };
  return { ok: false, response: fail("owner_only", `${what} needs a signed-in browser session or the box's assistant.`, 403) };
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
