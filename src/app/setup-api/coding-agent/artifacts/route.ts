import fs from "fs";
import { NextResponse } from "next/server";
import { artifactFilePath, artifactMimeType } from "@/lib/coding-agent-artifacts";

export const dynamic = "force-dynamic";

/**
 * GET ?runId=run-xxxxxxxx&file=<name> → the bytes of one run artifact.
 *
 * Read-only; middleware's cookie-or-bearer gate is the whole gate, matching
 * the runs listing these names come from. The name/id validation and the
 * realpath containment check live in artifactFilePath().
 *
 * Every artifact was WRITTEN BY THE DELEGATED AGENT, so nothing here may
 * execute in the app's origin: images render inline (that is the point of a
 * screenshot), everything else — including HTML a run saved — is served as
 * plain text with nosniff. An <script> in a run's artifact must stay text on
 * the owner's screen, never a stored XSS with the session cookie. The
 * image-vs-text split is artifactMimeType()'s single table.
 */
const MAX_SERVED_BYTES = 20 * 1024 * 1024;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId") ?? "";
  const name = url.searchParams.get("file") ?? "";

  const filePath = artifactFilePath(runId, name);
  if (!filePath) {
    return NextResponse.json({ error: "There is no such artifact.", kind: "not_found" }, { status: 404 });
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_SERVED_BYTES) {
      return NextResponse.json({ error: "This artifact is too large to serve.", kind: "too_large" }, { status: 413 });
    }
    const body = await fs.promises.readFile(filePath);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": artifactMimeType(name) ?? "text/plain; charset=utf-8",
        "Content-Length": String(body.byteLength),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=60",
        // The name already passed ARTIFACT_NAME_RE — no characters to escape.
        "Content-Disposition": `inline; filename="${name}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not read the artifact.", kind: "not_found" }, { status: 404 });
  }
}
