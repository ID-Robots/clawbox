import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { hasOwnerSession } from "@/lib/owner-session";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";
import { readExtraPaths, writeExtraPaths } from "@/lib/memory-shard";

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
 */

async function resolveInsideRoot(asked: string): Promise<{ ok: true; dir: string } | { ok: false; status: 400 | 403 | 404 }> {
  if (!asked || typeof asked !== "string") return { ok: false, status: 400 };
  const configured = path.resolve(filesBrowseRoot());
  let root: string;
  try {
    root = await fs.realpath(configured);
  } catch {
    root = configured;
  }
  const requested = path.isAbsolute(asked) ? path.resolve(asked) : path.resolve(root, asked);
  const within = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!within(requested)) return { ok: false, status: 404 };
  try {
    const real = await fs.realpath(requested);
    if (!within(real)) return { ok: false, status: 404 };
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

  const paths = await readExtraPaths();
  if (!paths.includes(resolved.dir)) {
    await writeExtraPaths([...paths, resolved.dir]);
    console.error(`[memory-shard] source added by the owner: ${resolved.dir}`);
  }
  return NextResponse.json({ paths: await readExtraPaths() });
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

  const paths = await readExtraPaths();
  const kept = paths.filter((p) => path.resolve(p) !== target);
  if (kept.length !== paths.length) {
    await writeExtraPaths(kept);
    console.error(`[memory-shard] source removed by the owner: ${target}`);
  }
  return NextResponse.json({ paths: await readExtraPaths() });
}
