import { NextResponse } from "next/server";
import { hasPersonSession } from "@/lib/owner-session";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { isSameOriginRequest } from "@/lib/same-origin";
import { ensureProjectFolder, listProjects } from "@/lib/coding-agent";
import { importFolder, importGitHubRepo, type ImportOutcome, type ImportReason } from "@/lib/project-import";

export const dynamic = "force-dynamic";

const STATUS: Record<ImportReason, number> = {
  no_project_folder: 409,
  invalid: 400,
  exists: 409,
  not_found: 404,
  not_a_folder: 400,
  refused: 403,
  too_big: 413,
  no_space: 507,
  no_gh: 409,
  not_connected: 409,
  gh_unreachable: 503,
  failed: 500,
};

/**
 * POST { source: "github", repo: "owner/name" } — clone one of the connected
 * account's repositories into the project folder.
 * POST { source: "folder", path: "/abs/or/~/path" } — copy a folder on the
 * box into the project folder (node_modules left behind), with a repository
 * of its own when it had none.
 *
 * Answers { project } — the row the projects listing shows for it — so the
 * app can open it at once.
 *
 * A PERSON signed in to this box, OR THE AGENT'S OWN BEARER — and, for a
 * browser, OUR PAGE ONLY: this writes into the owner's folder with the
 * owner's GitHub credential, and a cross-site page must not be able to fill
 * their project folder. The bearer is admitted since 2026-10-30, when the
 * Import panel left the Coding Agent app and "import my old-site repo"
 * became a sentence to the assistant (`coding_project_import`): the import
 * lands in the same project folder every run the agent starts already works
 * in, it never merges or overwrites, and the library refuses the sources
 * that matter (a folder outside the owner's home, a credential store, the
 * checkout). `isSameOriginRequest` passes a caller that sends no Origin —
 * the MCP server — and keeps refusing another site's page.
 */
export async function POST(request: Request) {
  if (!(await hasPersonSession(request)) && !verifyMcpBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Importing a project needs a signed-in browser session or the box's own agent.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Importing a project only works from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  let out: ImportOutcome;
  const projectsRoot = await ensureProjectFolder();
  if (b.source === "github") {
    if (typeof b.repo !== "string") return NextResponse.json({ error: "Name the repository as owner/name.", kind: "invalid" }, { status: 400 });
    out = await importGitHubRepo({ fullName: b.repo, projectsRoot });
  } else if (b.source === "folder") {
    if (typeof b.path !== "string") return NextResponse.json({ error: "Give the folder to copy.", kind: "invalid" }, { status: 400 });
    out = await importFolder({ source: b.path, projectsRoot });
  } else {
    return NextResponse.json({ error: "source must be \"github\" or \"folder\".", kind: "invalid" }, { status: 400 });
  }
  if (!out.ok) return NextResponse.json({ error: out.detail, kind: out.reason }, { status: STATUS[out.reason] });

  // Nothing typed or derived from it reaches the log: a typed path can
  // carry a newline, and the folder's name was made from it.
  console.error(`[coding-agent] a project was imported from ${b.source === "github" ? "GitHub" : "a folder on the box"}`);
  const { projects } = await listProjects();
  const project = projects.find((p) => p.directory === out.directory) ?? null;
  return NextResponse.json({ project, directory: out.directory, folder: out.folder, initialized: out.initialized, skipped: out.skipped });
}
