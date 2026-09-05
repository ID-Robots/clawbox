import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { getDefaultDirectory, listProjects } from "@/lib/coding-agent";
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
 * OWNER-ONLY and OUR PAGE ONLY, like the git DELETE and the GitHub login:
 * this writes into the owner's folder with the owner's GitHub credential,
 * and a cross-site page must not be able to fill their project folder.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json({ error: "Importing a project needs a signed-in browser session.", kind: "owner_only" }, { status: 403 });
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
  const projectsRoot = await getDefaultDirectory();
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
