import { NextRequest, NextResponse } from "next/server";
import {
  addProjectFolder,
  listProjectFolders,
  MAX_PROJECT_FOLDERS,
  ProjectFolderError,
  removeProjectFolder,
  suggestedProjectFolders,
} from "@/lib/project-folders";

export const dynamic = "force-dynamic";

// The owner's pinned project folders — the Files app's "Projects" (see
// src/lib/project-folders.ts). A route of its own rather than a segment under
// /setup-api/files/, where `[...path]` names the owner's files: a static
// `files/projects` would have shadowed a real `~/projects` folder for its
// download, rename and delete.
//
// GET                    → { folders, suggestions, max }
// POST   { path }        → { ok, folder, folders, added }   pin
// DELETE ?path=…         → { ok, removed, folders }         unpin

function refusal(err: unknown, fallback: string): NextResponse {
  if (err instanceof ProjectFolderError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error(`[project-folders] ${fallback}:`, err instanceof Error ? err.message : err);
  return NextResponse.json({ error: fallback, code: "failed" }, { status: 500 });
}

export async function GET() {
  try {
    const folders = await listProjectFolders();
    const suggestions = await suggestedProjectFolders(folders);
    return NextResponse.json({ folders, suggestions, max: MAX_PROJECT_FOLDERS });
  } catch (err) {
    return refusal(err, "Could not read the project folders");
  }
}

export async function POST(req: NextRequest) {
  const parsed: unknown = await req.json().catch(() => null);
  const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  try {
    const { folder, folders, added } = await addProjectFolder(body.path);
    return NextResponse.json({ ok: true, folder, folders, added });
  } catch (err) {
    return refusal(err, "Could not add the folder");
  }
}

export async function DELETE(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("path");
  try {
    const { removed, folders } = await removeProjectFolder(target ?? undefined);
    return NextResponse.json({ ok: true, removed, folders });
  } catch (err) {
    return refusal(err, "Could not remove the folder");
  }
}
