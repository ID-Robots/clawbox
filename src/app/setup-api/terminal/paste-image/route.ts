import { NextResponse } from "next/server";
import { boundedBody } from "@/lib/bounded-body";
import { requireSession } from "@/lib/route-auth";
import { isSameOriginRequest } from "@/lib/same-origin";
import { TERMINAL_PASTE_MAX_BYTES } from "@/lib/terminal-paste";
import { TerminalPasteError, savePastedImage } from "@/lib/terminal-paste-store";

export const dynamic = "force-dynamic";

// POST /setup-api/terminal/paste-image
//
// A picture pasted into the Terminal: the body is the image itself, the answer
// is the absolute path it was saved at, which the Terminal then pastes into
// the shell (src/lib/terminal-paste.ts says why a path). No name, no folder
// and no extension comes from the caller: the store picks all three, the
// extension from the bytes.
//
// Owner-only, and deliberately so. A non-owner's Terminal is a shell under a
// different Linux account, which cannot read a file in the owner's home — the
// middleware already answers such a session 403 `owner_only` for any write
// here, and the Terminal words that. Same-origin, because it writes a file.

const NO_STORE = { "cache-control": "no-store" };

function refuse(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

async function readImage(request: Request): Promise<Uint8Array | NextResponse> {
  if (!request.body) return refuse("The picture is empty.", "empty", 400);
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > TERMINAL_PASTE_MAX_BYTES) {
    return refuse("The picture is too large to paste.", "too_large", 413);
  }
  const bounded = boundedBody(request.body, { limit: TERMINAL_PASTE_MAX_BYTES });
  const chunks: Uint8Array[] = [];
  try {
    const reader = bounded.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    if (bounded.overflowed()) return refuse("The picture is too large to paste.", "too_large", 413);
    return refuse("The picture did not arrive whole.", "incomplete", 400);
  }
  const total = bounded.bytes();
  // A body cut short on its way here must not be saved as if it were the picture.
  if (Number.isFinite(declared) && declared !== total) {
    return refuse("The picture did not arrive whole.", "incomplete", 400);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function POST(request: Request) {
  const denied = await requireSession(request);
  if (denied) return denied;
  if (!isSameOriginRequest(request)) return refuse("Cross-origin request refused.", "cross_origin", 403);

  const bytes = await readImage(request);
  if (bytes instanceof NextResponse) return bytes;
  try {
    const saved = savePastedImage(bytes);
    return NextResponse.json({ ok: true, ...saved }, { status: 201, headers: NO_STORE });
  } catch (err) {
    if (err instanceof TerminalPasteError) return refuse(err.message, err.code, err.status);
    console.error("[terminal/paste-image] failed:", err instanceof Error ? err.message : err);
    return refuse("The picture could not be saved.", "write_failed", 500);
  }
}
