import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { hasOwnerSession } from "@/lib/owner-session";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";

export const dynamic = "force-dynamic";

/** Folders per listing. A home directory with thousands of entries should not
 *  turn a picker into a 2 MB response. */
const MAX_ENTRIES = 500;

/** A single folder NAME, not a path. Rejects separators, the two dot names and
 *  anything that would make a hidden or shell-hostile folder. */
const SAFE_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * The folder picker behind the setup wizard's Browse button.
 *
 * Directories ONLY — the setting it fills is a working folder, and a listing
 * that offered files would invite picking one. Rooted at the same tree the
 * Files app browses (`filesBrowseRoot()`, the owner's home), resolved through
 * the same guard, so this cannot become a second, weaker way to walk the disk:
 * a path that escapes the root, or that names a protected secret store,
 * answers 404 exactly like a folder that is not there.
 *
 * Hidden folders are skipped (`.ssh`, `.openclaw`, `.git` and friends are not
 * project folders and one of them is the reason the guard exists), except that
 * a folder the owner has ALREADY chosen still resolves — this route only
 * lists, it never validates the saved value.
 *
 * OWNER ONLY, like every other coding-agent settings route: middleware admits
 * the MCP bearer, and "show me the folder tree" is not a question the agent
 * asks through the owner's picker.
 *
 * GET /setup-api/coding-agent/browse?dir=<path relative to the root, or absolute>
 * → { root, path, parent, entries: [{ name, path }] }
 *   `path` is ABSOLUTE — it is what the caller posts back as defaultDirectory.
 */
/**
 * Resolve `dir` (absolute or root-relative) to a real directory inside the
 * browse root, or say why not. Shared by the listing and the mkdir below so
 * there is ONE containment rule, not two that can drift apart.
 */
async function resolveDir(asked: string): Promise<
  { ok: true; root: string; dir: string } | { ok: false; status: 403 | 404 }
> {
  const configured = path.resolve(filesBrowseRoot());
  let root: string;
  try {
    root = await fs.realpath(configured);
  } catch {
    root = configured;
  }
  const within = (p: string) => p === root || p.startsWith(root + path.sep);

  // ABSOLUTE stays absolute. The picker posts back the absolute `path` from a
  // previous listing, so reading it as root-relative would look for
  // <root>/home/clawbox/Projects and answer "not found" for the folder the
  // owner just tapped. Containment — not the spelling — is what keeps this in
  // the tree, and `path.resolve` normalises `..` away before that check.
  const requested = path.isAbsolute(asked) ? path.resolve(asked) : path.resolve(root, asked);
  if (!within(requested)) return { ok: false, status: 404 };

  try {
    // Checked AGAIN after resolving links: the lexical check above cannot see
    // that a folder inside the root is a symlink pointing out of it.
    const real = await fs.realpath(requested);
    if (!within(real)) return { ok: false, status: 404 };
    if (isProtectedFilePath(real)) return { ok: false, status: 404 };
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return { ok: false, status: 404 };
    return { ok: true, root, dir: real };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, status: code === "EACCES" || code === "EPERM" ? 403 : 404 };
  }
}

async function listing(root: string, target: string) {
  const dirents = await fs.readdir(target, { withFileTypes: true });
  const entries = dirents
    // `isDirectory()` is false for a symlink, which is what keeps a link loop
    // out of the picker — the same reason the Files app walks it this way.
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
    .filter((e) => !isProtectedFilePath(e.path))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES);
  return {
    root,
    path: target,
    // Null at the root, so the picker knows not to offer "up".
    parent: target === root ? null : path.dirname(target),
    entries,
    truncated: dirents.length > MAX_ENTRIES,
  };
}

export async function GET(request: NextRequest) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Browsing folders needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  const resolved = await resolveDir(request.nextUrl.searchParams.get("dir") ?? "");
  if (!resolved.ok) {
    return resolved.status === 403
      ? NextResponse.json({ error: "Permission denied", kind: "forbidden" }, { status: 403 })
      : NextResponse.json({ error: "Folder not found", kind: "not_found" }, { status: 404 });
  }
  try {
    return NextResponse.json(await listing(resolved.root, resolved.dir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied", kind: "forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Folder not found", kind: "not_found" }, { status: 404 });
  }
}

/**
 * Create one folder inside the picker's current directory.
 *
 * POST { dir, name } → the listing of `dir`, with the new folder in it.
 *
 * A NAME, never a path: the picker's "Create folder" field is one text box,
 * and a value with a separator in it would be a way to write outside the
 * folder on screen even though `dir` itself was checked. Owner-only, and
 * contained by exactly the rule the listing uses.
 */
export async function POST(request: NextRequest) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Creating a folder needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }

  let body: { dir?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!SAFE_FOLDER_NAME.test(name)) {
    return NextResponse.json(
      { error: "Use letters, digits, spaces, dots, dashes or underscores — and no slashes.", kind: "invalid" },
      { status: 400 },
    );
  }

  const resolved = await resolveDir(typeof body.dir === "string" ? body.dir : "");
  if (!resolved.ok) {
    return resolved.status === 403
      ? NextResponse.json({ error: "Permission denied", kind: "forbidden" }, { status: 403 })
      : NextResponse.json({ error: "Folder not found", kind: "not_found" }, { status: 404 });
  }

  const target = path.join(resolved.dir, name);
  try {
    // `mkdir` without `recursive`, so an existing name is an error rather than
    // a silent success that would tell the owner they created something they
    // did not.
    await fs.mkdir(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return NextResponse.json({ error: "That folder already exists.", kind: "exists" }, { status: 409 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied", kind: "forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Could not create the folder.", kind: "failed" }, { status: 500 });
  }

  console.error(`[coding-agent] folder created by the owner: ${target}`);
  return NextResponse.json({ ...(await listing(resolved.root, resolved.dir)), created: target });
}
