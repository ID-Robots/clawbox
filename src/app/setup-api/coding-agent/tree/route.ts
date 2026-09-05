import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError, resolveWorkingDirectory } from "@/lib/coding-agent";
import { listProjectDir, MAX_TREE_WRITE_BYTES, readProjectFile, writeProjectFile } from "@/lib/coding-project-tree";
import { hasOwnerSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/**
 * How many bytes a PUT body may be: the write cap with room for JSON's own
 * overhead — six bytes per content byte at worst (a control character is
 * `\u0001`), plus the envelope. Route handlers have no body limit of their
 * own, and `request.json()` would buffer the whole thing before the
 * content's cap could be applied.
 */
export const MAX_PUT_BODY_BYTES = MAX_TREE_WRITE_BYTES * 6 + 16 * 1024;

/** The JSON body, read chunk by chunk under the cap — never buffered whole first. */
async function readCappedJson(request: Request, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * The project page's file explorer.
 *
 * GET ?projectId=<id> | ?directory=<abs>            → the project's root listing
 *     &path=<relative folder>                        → that folder's listing
 *     &file=<relative file>                          → { file: { content, ... } }
 * PUT { projectId | directory, file, content }        → the owner's edit saved over that file
 *
 * The project is resolved through `resolveWorkingDirectory`, the rule a run
 * goes through, so this cannot open a folder a run could not be pointed at;
 * inside it, `src/lib/coding-project-tree.ts` keeps every path in the
 * project. Session-gated like the git block beside it: the files are the
 * owner's, and the agent already reads them with its own tools.
 *
 * A path outside the project, a protected file, `.git`, a link that leaves,
 * and a file that is not there all answer 404 alike — a refusal that said
 * "outside" would confirm what the caller was probing for.
 *
 * The write is the OWNER's (a session cookie, never the MCP bearer — the
 * agent edits with its own tools, and a run's prompt must not reach the
 * owner's editor), saves over a file that is already there and creates
 * none, and is capped at the read cap so a file opened whole is saved whole.
 */
/** The project's folder through the run's own rule, or the refusal to answer. */
async function resolveProject(projectId: string | null, directory: string | null): Promise<{ directory: string } | { response: NextResponse }> {
  if (!projectId && !directory) {
    return { response: NextResponse.json({ error: "Name the project: projectId or directory" }, { status: 400 }) };
  }
  try {
    return { directory: (await resolveWorkingDirectory({ projectId, directory })).directory };
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return { response: NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) }) };
    }
    return { response: NextResponse.json({ error: err instanceof Error ? err.message : "Could not resolve the project" }, { status: 500 }) };
  }
}

export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const project = await resolveProject(url.searchParams.get("projectId"), url.searchParams.get("directory"));
  if ("response" in project) return project.response;
  const projectDir = project.directory;
  const file = url.searchParams.get("file");
  if (file !== null) {
    const out = await readProjectFile(projectDir, file);
    if (!out.ok) return NextResponse.json({ error: "No such file in the project", kind: "not_found" }, { status: out.status });
    const { ok: _ok, ...rest } = out;
    return NextResponse.json({ file: rest });
  }
  const out = await listProjectDir(projectDir, url.searchParams.get("path") ?? "");
  if (!out.ok) return NextResponse.json({ error: "No such folder in the project", kind: "not_found" }, { status: out.status });
  const { ok: _ok, ...rest } = out;
  return NextResponse.json({ listing: rest });
}

export async function PUT(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json({ error: "Editing a project's files needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
  }
  const read = await readCappedJson(request, MAX_PUT_BODY_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: "The file is too large to save from here.", kind: "too_large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  const body = read.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  const fields = body as { projectId?: unknown; directory?: unknown; file?: unknown; content?: unknown };
  const optional = (v: unknown): v is string | null | undefined => v === undefined || v === null || typeof v === "string";
  if (!optional(fields.projectId) || !optional(fields.directory) || typeof fields.file !== "string" || !fields.file || typeof fields.content !== "string") {
    return NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  if (Buffer.byteLength(fields.content, "utf8") > MAX_TREE_WRITE_BYTES) {
    return NextResponse.json({ error: "The file is too large to save from here.", kind: "too_large" }, { status: 413 });
  }
  const project = await resolveProject(fields.projectId ?? null, fields.directory ?? null);
  if ("response" in project) return project.response;
  const out = await writeProjectFile(project.directory, fields.file, fields.content);
  if (!out.ok) {
    if (out.status === 413) return NextResponse.json({ error: "The file is too large to save from here.", kind: "too_large" }, { status: 413 });
    return NextResponse.json({ error: "No such file in the project", kind: "not_found" }, { status: out.status });
  }
  return NextResponse.json({ file: { path: out.path, size: out.size } });
}
