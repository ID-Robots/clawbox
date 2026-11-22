import { NextResponse } from "next/server";
import { getDefaultDirectory } from "@/lib/coding-agent";
import { verifyMcpBearer } from "@/lib/mcp-token";
import { personSession } from "@/lib/owner-session";
import {
  addProjectFolder,
  createFolderProject,
  isFolderName,
  listProjectFolders,
  ProjectFoldersError,
  readProjectFolders,
  removeProjectFolder,
  type ProjectFolder,
} from "@/lib/project-folders";
import { isSameOriginRequest } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * A project's FOLDERS (TASK-2757, src/lib/project-folders.ts): the git
 * repositories in the owner's project folder that a run on the project gets a
 * copy of each of, side by side.
 *
 * GET  ?project=<name> → `{ project, folders }` — `folders` empty for a
 *        single-folder project. Without `project`: `{ projects: [{ project, folders }] }`.
 * POST { project, action: "create", folders: [name | { folder, base? }] } → a
 *        new multi-folder project (its folder in the project folder is made
 *        when there is none);
 *      { project, action: "add", folder, base? } → one more folder (a project
 *        with no list starts one with its own folder first, when that is a
 *        repository);
 *      { project, action: "remove", folder } → one folder fewer.
 *      Each answers `{ project, folders }` as stored now.
 *
 * WHO: the owner's browser session or the MCP bearer — the Coding Agent app's
 * Folders card and the assistant's coding_project_* tools are the two callers.
 * A signed-in non-owner gets 403 `owner_only`; a browser must be OUR page.
 */
async function admit(request: Request): Promise<NextResponse | null> {
  const who = await personSession(request);
  if (who && !who.isOwner) {
    return NextResponse.json({ error: "Only the box owner can change a project's folders.", kind: "owner_only" }, { status: 403 });
  }
  if (!who && !verifyMcpBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "A project's folders need the owner's browser session or the box's own agent.", kind: "owner_only" }, { status: 403 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "A project's folders only change from this ClawBox's own pages.", kind: "cross_origin" }, { status: 403 });
  }
  return null;
}

const STATUS: Record<ProjectFoldersError["code"], number> = {
  invalid_project: 400,
  invalid_folder: 400,
  not_a_repository: 400,
  too_many: 400,
  exists: 409,
  not_found: 404,
  store_unreadable: 500,
};

function answer(project: string, folders: ProjectFolder[] | null) {
  return NextResponse.json({ project, folders: folders ?? [] });
}

export async function GET(request: Request) {
  const refused = await admit(request);
  if (refused) return refused;
  const project = new URL(request.url).searchParams.get("project");
  if (project === null) {
    const all = await listProjectFolders();
    return NextResponse.json({ projects: Object.entries(all).map(([name, folders]) => ({ project: name, folders })) });
  }
  if (!isFolderName(project)) return NextResponse.json({ error: "Name a project by its folder's name.", kind: "invalid_project" }, { status: 400 });
  return answer(project, await readProjectFolders(project));
}

export async function POST(request: Request) {
  const refused = await admit(request);
  if (refused) return refused;
  let body: { project?: unknown; action?: unknown; folder?: unknown; folders?: unknown; base?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", kind: "invalid" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body", kind: "invalid" }, { status: 400 });
  }
  const { project, action } = body;
  try {
    if (action === "create") {
      return answer(String(project), await createFolderProject(await getDefaultDirectory(), project, body.folders));
    }
    if (action === "add") return answer(String(project), await addProjectFolder(await getDefaultDirectory(), project, body.folder, body.base));
    if (action === "remove") return answer(String(project), await removeProjectFolder(project, body.folder));
    return NextResponse.json({ error: 'action must be "create", "add" or "remove".', kind: "invalid" }, { status: 400 });
  } catch (err) {
    if (err instanceof ProjectFoldersError) return NextResponse.json({ error: err.message, kind: err.code }, { status: STATUS[err.code] });
    console.error("[coding-agent/project-folders] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not change the project's folders" }, { status: 500 });
  }
}
