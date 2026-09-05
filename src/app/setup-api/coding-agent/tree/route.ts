import { NextResponse } from "next/server";
import { CodingAgentError, httpStatusForCodingError, resolveWorkingDirectory } from "@/lib/coding-agent";
import { listProjectDir, readProjectFile } from "@/lib/coding-project-tree";
import { requireSession } from "@/lib/route-auth";

export const dynamic = "force-dynamic";

/**
 * The project page's file explorer.
 *
 * GET ?projectId=<id> | ?directory=<abs>            → the project's root listing
 *     &path=<relative folder>                        → that folder's listing
 *     &file=<relative file>                          → { file: { content, ... } }
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
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const directory = url.searchParams.get("directory");
  if (!projectId && !directory) {
    return NextResponse.json({ error: "Name the project: projectId or directory" }, { status: 400 });
  }
  let projectDir: string;
  try {
    projectDir = (await resolveWorkingDirectory({ projectId, directory })).directory;
  } catch (err) {
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not resolve the project" }, { status: 500 });
  }
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
