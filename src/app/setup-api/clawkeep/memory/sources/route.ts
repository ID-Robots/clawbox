import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { hasOwnerSession } from "@/lib/owner-session";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";
import { ExtraPathsUnreadableError, mutateExtraPaths, readExtraPaths } from "@/lib/memory-shard";
import { invalidateMemoryStatusCache } from "@/lib/clawkeep-memory";

export const dynamic = "force-dynamic";

/**
 * The extra folders the owner wants indexed.
 *
 * Backed by OpenClaw's own `memory.search.extraPaths`, which is what actually
 * governs indexing — so this reads and writes the setting that takes effect,
 * rather than a ClawBox-side mirror that could drift away from it.
 *
 * OWNER ONLY. The agent must not be able to widen what gets indexed: the whole
 * point of the list is that the owner chose it.
 *
 * Contained to the tree the Files app browses, through the same guard the
 * folder picker uses — a folder outside it, or a protected secret store, is
 * refused exactly like one that is not there.
 *
 * Every change goes through `mutateExtraPaths`, so two of them cannot
 * interleave: each write is one CLI spawn that the gateway restarts on, and
 * an add and a remove that overlapped once left the list empty with the add
 * having answered that the folder was in it. A refusal here carries `kind`,
 * the name this file's refusals have always carried (`owner_only`,
 * `not_found`), so the panel reads one field for all of them.
 */

/**
 * The mutation failed, and nothing is on disk that was not there before. Two
 * kinds, because they have different fixes: `read_failed` is openclaw.json
 * unreadable or half-written — the list was NOT touched, precisely so a
 * momentary read failure can never save one folder over the owner's whole
 * list — and `write_failed` is the CLI refusing or timing out. Both are said
 * with a stable kind so the panel shows a sentence rather than a bare 500,
 * and without the CLI's own text, which names paths.
 */
function mutationFailed(err: unknown) {
  if (err instanceof ExtraPathsUnreadableError) {
    return NextResponse.json(
      { error: "The folder list could not be read. Try again.", kind: "read_failed" },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { error: "The folder list could not be saved. Try again.", kind: "write_failed" },
    { status: 500 },
  );
}

async function resolveInsideRoot(asked: string): Promise<{ ok: true; dir: string } | { ok: false; status: 400 | 403 | 404 }> {
  if (!asked || typeof asked !== "string") return { ok: false, status: 400 };
  const configured = path.resolve(filesBrowseRoot());
  let root: string;
  try {
    root = await fs.realpath(configured);
  } catch {
    root = configured;
  }
  // Written as relative-then-join rather than a `startsWith` helper, the same
  // way the folder picker's own resolveDir is: it is the same rule, but a
  // scanner can only tie a guard to the sink when the guard is inline on the
  // very value that reaches it (js/path-injection stayed open here behind the
  // closure, exactly as it did in the chat media route). `rel` is empty for
  // the root itself, so the root still resolves.
  const requested = path.isAbsolute(asked) ? path.resolve(asked) : path.resolve(root, asked);
  const rel = path.relative(root, requested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, status: 404 };
  const candidate = path.join(root, rel);
  try {
    // Checked AGAIN after resolving links: the lexical check above cannot see
    // that a folder inside the root is a symlink pointing out of it.
    const real = await fs.realpath(candidate);
    const realRel = path.relative(root, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return { ok: false, status: 404 };
    if (isProtectedFilePath(real)) return { ok: false, status: 404 };
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) return { ok: false, status: 400 };
    return { ok: true, dir: real };
  } catch {
    return { ok: false, status: 404 };
  }
}

function forbidden() {
  return NextResponse.json(
    { error: "Changing the indexed folders needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

/** GET → { paths } */
export async function GET(request: NextRequest) {
  if (!(await hasOwnerSession(request))) return forbidden();
  return NextResponse.json({ paths: await readExtraPaths() });
}

/** POST { path } → add one folder. Idempotent: adding it twice is not an error. */
export async function POST(request: NextRequest) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: { path?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const resolved = await resolveInsideRoot(typeof body.path === "string" ? body.path : "");
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.status === 400 ? "That is not a folder." : "Folder not found.", kind: "not_found" },
      { status: resolved.status },
    );
  }

  let added = false;
  let paths: string[];
  try {
    paths = await mutateExtraPaths((current) => {
      if (current.includes(resolved.dir)) return current;
      added = true;
      return [...current, resolved.dir];
    });
  } catch (err) {
    console.error(`[memory-shard] adding a source failed: ${err instanceof Error ? err.message : String(err)}`);
    return mutationFailed(err);
  }
  if (added) {
    console.error(`[memory-shard] source added by the owner: ${resolved.dir}`);
    // The status probe counts what the index reads; marked stale the way the
    // provider route does after ITS write, or the home face would show the
    // old reading for STATUS_CACHE_MS.
    invalidateMemoryStatusCache();
  }
  return NextResponse.json({ paths });
}

/** DELETE { path } → stop indexing one folder. The files are left alone. */
export async function DELETE(request: NextRequest) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: { path?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const target = typeof body.path === "string" ? path.resolve(body.path) : "";
  if (!target) return NextResponse.json({ error: "Which folder?" }, { status: 400 });

  let removed = false;
  let paths: string[];
  try {
    paths = await mutateExtraPaths((current) => {
      const kept = current.filter((p) => path.resolve(p) !== target);
      removed = kept.length !== current.length;
      return kept;
    });
  } catch (err) {
    console.error(`[memory-shard] removing a source failed: ${err instanceof Error ? err.message : String(err)}`);
    return mutationFailed(err);
  }
  if (removed) {
    // JSON-quoted: the request body's path is what is being printed, and the
    // quoting is the sanitizer js/log-injection models (see 3ef684a1).
    console.error(`[memory-shard] source removed by the owner: ${JSON.stringify(target)}`);
    invalidateMemoryStatusCache();
  }
  return NextResponse.json({ paths });
}
