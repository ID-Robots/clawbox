import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { filesBrowseRoot, isProtectedFilePath } from "@/lib/file-guard";
import { activeRunDirectory, activeRunId } from "@/lib/coding-agent";
import { artifactsDir, INLINE_IMAGE_MIME } from "@/lib/coding-agent-artifacts";
import { describeImage, isVisionImageMime, type VisionImageMime } from "@/lib/vision-describe";

export const dynamic = "force-dynamic";

/** Longest prompt override accepted, in characters. */
const MAX_PROMPT_CHARS = 600;
/** Largest image the route will read and upload. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ext → MIME for what can be described: the artifacts store's inline-image
// table, less what the vision proxy does not take (.gif). Derived rather than
// written out so a type added to one table cannot be forgotten in the other.
const MIME_FOR: Record<string, VisionImageMime> = Object.fromEntries(
  Object.entries(INLINE_IMAGE_MIME).filter((entry): entry is [string, VisionImageMime] => isVisionImageMime(entry[1])),
);
const ACCEPTED_EXTENSIONS = Object.keys(MIME_FOR).join(", ").replace(/, ([^,]+)$/, " and $1");

/**
 * The folders the caller may read from — decided HERE, not in the MCP tool
 * that calls this. The tool's own check is a courtesy for a mistyped path,
 * and a courtesy is not a boundary: the bearer it holds is also the
 * credential a prompt-injected run holds.
 *
 * A person at the desktop (session cookie) may describe any image under the
 * tree the Files app browses. The bearer — the agent's, and the run's — gets
 * the fence browser_view_local lives behind: while a run is live, its working
 * folder and its evidence folder, the two places its own pictures are; with
 * no run live, the same Files tree. Credential stores are refused for
 * everyone before this is asked. Roots are resolved through realpath so a
 * symlinked root grants exactly what it points at; one that does not exist
 * grants nothing.
 */
async function allowedRoots(request: Request): Promise<{ roots: string[]; refusal: string }> {
  const owner = await hasOwnerSession(request);
  const runId = owner ? null : activeRunId();
  const runDir = owner ? null : activeRunDirectory();
  const wanted = runId && runDir ? [runDir, artifactsDir(runId)] : [filesBrowseRoot()];
  const roots: string[] = [];
  for (const root of wanted) {
    try {
      roots.push(await fs.realpath(root));
    } catch {
      // a root that does not exist grants nothing
    }
  }
  const refusal = runId && runDir
    ? "That file is outside the active coding run's working and evidence folders."
    : "That file is outside the home folder.";
  return { roots, refusal };
}

/**
 * POST { path, prompt? } → { description, error } — a written description of a
 * local image file, through the box's vision model.
 *
 * Exists because the coding-agent run models are image-blind: the browser
 * tools describe what the BROWSER is showing, but a run that saved a frame of
 * its own had no way to look at the file — run-d8816d78 built a viewer.html
 * and drove the device browser at it just to see its own JPEGs. Same failure
 * contract as vision-describe: an unlinked account or an offline proxy is an
 * answer in `error`, never a 500.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  let body: { path?: unknown; prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const given = typeof body.path === "string" ? body.path.trim() : "";
  if (!given || !path.isAbsolute(given)) {
    return NextResponse.json({ error: "Pass the absolute path of an image file." }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" && body.prompt.trim()
    ? body.prompt.trim().slice(0, MAX_PROMPT_CHARS)
    : undefined;

  // Two containment checks, both as `startsWith(root + sep)` on a normalised
  // path, written out here rather than behind a helper so the guard sits
  // right before the filesystem call it protects. The first is on the path
  // as typed, before anything touches the disk; the second is on the real
  // file after symlinks are resolved, so a link planted under a root cannot
  // lead out of it. A root itself is a folder, never an image.
  const { roots, refusal } = await allowedRoots(request);
  const resolved = path.resolve(given);
  let typed: string | null = null;
  for (const root of roots) {
    if (resolved.startsWith(root + path.sep)) {
      typed = resolved;
      break;
    }
  }
  if (typed === null) return NextResponse.json({ error: refusal }, { status: 403 });

  // realpath before the extension check: the type must belong to the file
  // actually read, never to a symlink's name.
  let real: string;
  try {
    real = await fs.realpath(typed);
  } catch {
    return NextResponse.json({ error: "There is no file at that path." }, { status: 404 });
  }
  // A secret store answers exactly like a missing file: "protected" would
  // itself be a map of where the secrets live.
  if (isProtectedFilePath(real)) {
    return NextResponse.json({ error: "There is no file at that path." }, { status: 404 });
  }
  let target: string | null = null;
  for (const root of roots) {
    if (real.startsWith(root + path.sep)) {
      target = real;
      break;
    }
  }
  if (target === null) return NextResponse.json({ error: refusal }, { status: 403 });

  const mime = MIME_FOR[path.extname(target).toLowerCase()];
  if (!mime) {
    return NextResponse.json({ error: `Only ${ACCEPTED_EXTENSIONS} files can be described.` }, { status: 400 });
  }
  // One open handle for the size check and the read: a file swapped between
  // a stat and a readFile would be read as whatever it became.
  let data: Buffer;
  try {
    const handle = await fs.open(target, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return NextResponse.json({ error: "That path is not a file." }, { status: 400 });
      if (stat.size > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: `The image is too large: at most ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.` },
          { status: 413 },
        );
      }
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return NextResponse.json({ error: "The file could not be read." }, { status: 400 });
  }
  const described = await describeImage(data.toString("base64"), prompt, mime);
  return NextResponse.json({ description: described.text, error: described.error });
}
