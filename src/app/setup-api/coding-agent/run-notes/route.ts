import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError, resolveWorkingDirectory } from "@/lib/coding-agent";
import { clearRunNotes, MAX_RUN_NOTES_CHARS, readRunNotes, RUN_NOTES_DIR, RUN_NOTES_FILE, RunNotesError, writeRunNotes } from "@/lib/coding-run-notes";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/** A PUT body is the notes and a project name: far below this, whatever the notes' bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A project's RUN NOTES (src/lib/coding-run-notes.ts) — what earlier runs in
 * it learned, injected into every run and team role brief.
 *
 * GET    ?projectId=<id> | ?directory=<abs>   → { notes, maxChars, file }
 * PUT    { projectId | directory, notes }      → the owner's edit, saved whole
 * DELETE ?projectId=<id> | ?directory=<abs>   → the owner's Clear
 *
 * The project is resolved through `resolveWorkingDirectory`, the rule a run is
 * pointed at a folder by, so this reaches no folder a run could not. Reading is
 * session-gated like the project's files beside it. Writing is the OWNER's
 * alone (a browser session, never the MCP bearer): the notes travel into every
 * future run's system prompt, so a prompt-injected agent must not be able to
 * write orders there — runs add lessons only through the vetted settle channel.
 */
async function resolveProject(projectId: unknown, directory: unknown): Promise<{ directory: string } | { response: NextResponse }> {
  const id = typeof projectId === "string" && projectId ? projectId : null;
  const dir = typeof directory === "string" && directory ? directory : null;
  if (!id && !dir) {
    return { response: NextResponse.json({ error: "Name the project: projectId or directory", kind: "invalid" }, { status: 400 }) };
  }
  try {
    return { directory: (await resolveWorkingDirectory({ projectId: id, directory: dir })).directory };
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return { response: NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) }) };
    }
    return { response: NextResponse.json({ error: err instanceof Error ? err.message : "Could not resolve the project" }, { status: 500 }) };
  }
}

/** The JSON body, read chunk by chunk under the cap — never buffered whole first (the tree route's rule). */
async function readCappedJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function answer(notes: string) {
  return NextResponse.json({ notes, maxChars: MAX_RUN_NOTES_CHARS, file: `${RUN_NOTES_DIR}/${RUN_NOTES_FILE}` });
}

function ownerOnly() {
  return NextResponse.json({ error: "Changing a project's run notes needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
}

function refusal(err: unknown) {
  if (err instanceof RunNotesError) {
    const status = err.code === "write_failed" ? 500 : 400;
    return NextResponse.json({ error: err.message, kind: err.code }, { status });
  }
  return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save the run notes" }, { status: 500 });
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const project = await resolveProject(url.searchParams.get("projectId"), url.searchParams.get("directory"));
  if ("response" in project) return project.response;
  return answer(readRunNotes(project.directory));
}

export async function PUT(request: Request) {
  if (!(await hasPersonSession(request))) return ownerOnly();
  const read = await readCappedJson(request);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: "The notes are too long to save.", kind: "too_long" }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  const fields = body as { projectId?: unknown; directory?: unknown; notes?: unknown };
  if (typeof fields.notes !== "string") {
    return NextResponse.json({ error: "Send the notes as text: { notes: string }.", kind: "invalid" }, { status: 400 });
  }
  const project = await resolveProject(fields.projectId, fields.directory);
  if ("response" in project) return project.response;
  try {
    return answer(await writeRunNotes(project.directory, fields.notes));
  } catch (err) {
    return refusal(err);
  }
}

export async function DELETE(request: Request) {
  if (!(await hasPersonSession(request))) return ownerOnly();
  const url = new URL(request.url);
  const project = await resolveProject(url.searchParams.get("projectId"), url.searchParams.get("directory"));
  if ("response" in project) return project.response;
  try {
    clearRunNotes(project.directory);
    return answer("");
  } catch (err) {
    return refusal(err);
  }
}
