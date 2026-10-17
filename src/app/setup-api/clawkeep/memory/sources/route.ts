import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import path from "@/lib/runtime-path";
import { memoryShardWriter } from "@/lib/memory-shard-writer";
import { isHiddenInsideBrowseRoot, resolveFolderInsideBrowseRoot } from "@/lib/browse-folder";
import { ExtraPathsUnreadableError, mutateExtraPaths, readExtraPaths } from "@/lib/memory-shard";
import { invalidateMemoryStatusCache } from "@/lib/clawkeep-memory";
import { countSourceFiles } from "@/lib/memory-extract";
import { openclawIsAbsent } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

/**
 * The extra folders the owner wants indexed.
 *
 * Backed by whatever actually governs indexing on this edition — so this reads
 * and writes the setting that takes effect, never a mirror of it that could
 * drift away. Where there is an OpenClaw that is its own
 * `memory.search.extraPaths`; where there is not, ClawBox is the indexer
 * (`src/lib/memory-index-local.ts`) and its own store IS the setting. The
 * no-mirror invariant is kept either way, and no box holds two copies.
 *
 * A signed-in person or the box's assistant (`memoryShardWriter`), nobody
 * else. The assistant adds a folder because the owner asked it to in chat —
 * the same choice the folder picker records — and it is held to the picker's
 * rules below, not to looser ones of its own.
 *
 * Contained to the tree the Files app browses, through the same guard the
 * folder picker uses — a folder outside it, or a protected secret store, is
 * refused exactly like one that is not there. And, as the picker lists none,
 * never a hidden (dot-named) folder: 400 `hidden`.
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

const WHAT = "Changing the indexed folders";

/** GET → { paths } */
export async function GET(request: NextRequest) {
  const writer = await memoryShardWriter(request, WHAT);
  if (!writer.ok) return writer.response;
  return NextResponse.json({ paths: await readExtraPaths() });
}

/**
 * POST { path } → add one folder. Idempotent: adding it twice is not an error.
 * `path` is absolute or relative to the Files home. The assistant's answer also
 * carries `wouldRead`: the files a pass would read from that folder, counted
 * the way the pass walks it (the owner's picker does not wait for the walk).
 */
export async function POST(request: NextRequest) {
  const writer = await memoryShardWriter(request, WHAT);
  if (!writer.ok) return writer.response;

  let body: { path?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const resolved = await resolveFolderInsideBrowseRoot(typeof body.path === "string" ? body.path : "");
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.status === 400 ? "That is not a folder." : "Folder not found.", kind: "not_found" },
      { status: resolved.status },
    );
  }
  if (await isHiddenInsideBrowseRoot(resolved.dir)) {
    return NextResponse.json(
      { error: "Hidden folders are left out of Memory Shard, as the folder picker leaves them out.", kind: "hidden" },
      { status: 400 },
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
    console.error(`[memory-shard] source added by the ${writer.by}: ${resolved.dir}`);
    // The status probe counts what the index reads; marked stale the way the
    // provider route does after ITS write, or the home face would show the
    // old reading for STATUS_CACHE_MS.
    invalidateMemoryStatusCache();
  }
  if (writer.by === "assistant") {
    // ClawBox converts PDFs and office documents only where it is the
    // indexer; OpenClaw's index reads the markdown.
    const counted = await countSourceFiles(resolved.dir).catch(() => null);
    const wouldRead = counted && (openclawIsAbsent() ? counted : { ...counted, files: counted.markdown, documents: 0, documentsOverCap: 0 });
    return NextResponse.json({ paths, folder: resolved.dir, added, ...(wouldRead ? { wouldRead } : {}) });
  }
  return NextResponse.json({ paths });
}

/** DELETE { path } → stop indexing one folder. The files are left alone. */
export async function DELETE(request: NextRequest) {
  const writer = await memoryShardWriter(request, WHAT);
  if (!writer.ok) return writer.response;

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
    console.error(`[memory-shard] source removed by the ${writer.by}: ${JSON.stringify(target)}`);
    invalidateMemoryStatusCache();
  }
  return NextResponse.json({ paths });
}
