import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { filesBrowseRoot, isInside, isProtectedFilePath } from "@/lib/file-guard";
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

/** `real` sits under `root` after both are resolved; a root that does not exist grants nothing. */
async function isInsideReal(real: string, root: string): Promise<boolean> {
  try {
    return isInside(real, await fs.realpath(root));
  } catch {
    return false;
  }
}

/**
 * How far the caller may look — decided HERE, not in the MCP tool that calls
 * this. The tool's own check is a courtesy for a mistyped path, and a
 * courtesy is not a boundary: the bearer it holds is also the credential a
 * prompt-injected run holds.
 *
 * A person at the desktop (session cookie) keeps the wide contract: any image
 * the box can read. The bearer — the agent's, and the run's — gets the fence
 * browser_view_local lives behind: while a run is live, its working folder
 * and its evidence folder, the two places its own pictures are; with no run
 * live, the tree the Files app browses. Credential stores are refused for
 * everyone before this is asked. Returns the refusal, or null.
 */
async function bearerFence(request: Request, real: string): Promise<string | null> {
  if (await hasOwnerSession(request)) return null;
  const runId = activeRunId();
  const runDir = activeRunDirectory();
  if (runId && runDir) {
    for (const root of [runDir, artifactsDir(runId)]) {
      if (await isInsideReal(real, root)) return null;
    }
    return "That file is outside the active coding run's working and evidence folders.";
  }
  if (await isInsideReal(real, filesBrowseRoot())) return null;
  return "That file is outside the home folder.";
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

  // realpath before the extension check: the type must belong to the file
  // actually read, never to a symlink's name.
  let real: string;
  try {
    real = await fs.realpath(given);
  } catch {
    return NextResponse.json({ error: "There is no file at that path." }, { status: 404 });
  }
  // A secret store answers exactly like a missing file: "protected" would
  // itself be a map of where the secrets live.
  if (isProtectedFilePath(real)) {
    return NextResponse.json({ error: "There is no file at that path." }, { status: 404 });
  }
  const fence = await bearerFence(request, real);
  if (fence) return NextResponse.json({ error: fence }, { status: 403 });

  const mime = MIME_FOR[path.extname(real).toLowerCase()];
  if (!mime) {
    return NextResponse.json({ error: `Only ${ACCEPTED_EXTENSIONS} files can be described.` }, { status: 400 });
  }
  let data: Buffer;
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return NextResponse.json({ error: "That path is not a file." }, { status: 400 });
    if (stat.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `The image is too large: at most ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.` },
        { status: 413 },
      );
    }
    data = await fs.readFile(real);
  } catch {
    return NextResponse.json({ error: "The file could not be read." }, { status: 400 });
  }
  const described = await describeImage(data.toString("base64"), prompt, mime);
  return NextResponse.json({ description: described.text, error: described.error });
}
