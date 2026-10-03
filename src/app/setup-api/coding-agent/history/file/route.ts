import fs from "fs";
import { NextResponse } from "next/server";
import { artifactMimeType } from "@/lib/coding-agent-artifacts";
import { archivedEvidencePath } from "@/lib/coding-run-history";

export const dynamic = "force-dynamic";

/**
 * GET ?runId=run-xxxxxxxx&file=<name> → one file of an ARCHIVED run's
 * evidence folder, for the archived run's read-only page.
 *
 * The artifacts route's rules exactly, because these are the same files moved
 * somewhere else: the name/id validation and the realpath containment live in
 * archivedEvidencePath(), the open is O_NOFOLLOW and every later question is
 * asked of the handle, images and audio are served inline and everything else
 * — HTML a run saved included — as plain text with nosniff. Read-only; the
 * middleware's cookie-or-bearer gate is the whole gate, as it is there.
 */
const MAX_SERVED_BYTES = 20 * 1024 * 1024;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") ?? "";
  const name = url.searchParams.get("file") ?? "";

  const filePath = archivedEvidencePath(runId, name);
  if (!filePath) {
    return NextResponse.json({ error: "There is no such archived file.", kind: "not_found" }, { status: 404 });
  }
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return NextResponse.json({ error: "There is no such archived file.", kind: "not_found" }, { status: 404 });
    }
    if (stat.size > MAX_SERVED_BYTES) {
      return NextResponse.json({ error: "This file is too large to show; export the run to get it.", kind: "too_large" }, { status: 413 });
    }
    const body = new Uint8Array(stat.size);
    const { bytesRead } = await handle.read(body, 0, stat.size, 0);
    const bytes = bytesRead === stat.size ? body : body.subarray(0, bytesRead);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": artifactMimeType(name) ?? "text/plain; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
        // The name passed ARTIFACT_NAME_RE — no characters to escape.
        "Content-Disposition": `inline; filename="${name}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not read the archived file.", kind: "not_found" }, { status: 404 });
  } finally {
    await handle?.close().catch(() => {});
  }
}
