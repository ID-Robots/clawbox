export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  initProject,
  listProjects,
  getProject,
  deleteProject,
  listFiles,
  readFile,
  writeFile,
  editFile,
  deleteFile,
  searchFiles,
  buildProject,
  validateProjectId,
  NotFoundError,
  ValidationError,
} from "@/lib/code-projects";

function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function ok(data: Record<string, unknown>) {
  return NextResponse.json(data);
}

/**
 * POST /setup-api/code — action-based dispatch for code project operations.
 *
 * Actions:
 *   init, list-projects, get-project, delete-project,
 *   file-list, file-read, file-write, file-edit, file-delete,
 *   search, build
 */
export async function POST(request: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON payload", 400);
  }
  try {
    const { action } = body;

    switch (action) {
      // ── Project CRUD ──

      case "init": {
        const { projectId, name, color, description, template } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        if (!name) return err("Project name required");
        const meta = await initProject(projectId, name, { color, description, template });
        return ok({ success: true, project: meta });
      }

      case "list-projects": {
        const projects = await listProjects();
        return ok({ projects });
      }

      case "get-project": {
        const { projectId } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        const meta = await getProject(projectId);
        return ok({ project: meta });
      }

      case "delete-project": {
        const { projectId } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        await deleteProject(projectId);
        return ok({ success: true });
      }

      // ── File Operations ──

      case "file-list": {
        const { projectId, directory } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        const files = await listFiles(projectId, directory);
        return ok({ files });
      }

      case "file-read": {
        const { projectId, filePath } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        if (!filePath) return err("filePath required");
        const content = await readFile(projectId, filePath);
        return ok({ content, filePath });
      }

      case "file-write": {
        const { projectId, filePath, content } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        if (!filePath) return err("filePath required");
        if (typeof content !== "string") return err("content must be a string");
        await writeFile(projectId, filePath, content);
        return ok({ success: true, filePath });
      }

      case "file-edit": {
        const { projectId, filePath, oldString, newString, replaceAll: ra } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        if (!filePath) return err("filePath required");
        if (typeof oldString !== "string" || typeof newString !== "string")
          return err("oldString and newString must be strings");
        if (oldString === newString) return err("oldString and newString must differ");
        const result = await editFile(projectId, filePath, oldString, newString, !!ra);
        return ok({ success: true, filePath, replacements: result.applied });
      }

      case "file-delete": {
        const { projectId, filePath } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        if (!filePath) return err("filePath required");
        await deleteFile(projectId, filePath);
        return ok({ success: true, filePath });
      }

      // ── Search ──

      case "search": {
        const { projectId, pattern, regex, caseSensitive, maxResults } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        if (!pattern) return err("Search pattern required");
        const matches = await searchFiles(projectId, pattern, {
          regex,
          caseSensitive,
          maxResults,
        });
        return ok({ matches, total: matches.length });
      }

      // ── Build & Deploy ──

      case "build": {
        const { projectId, name, color } = body;
        if (!projectId || !validateProjectId(projectId)) return err("Invalid project ID");
        const result = await buildProject(projectId, { name, color });
        return ok({
          success: true,
          url: result.url,
          filesInlined: result.filesInlined,
        });
      }

      default:
        return err(`Unknown action: ${action}`, 400);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Internal error";
    const status =
      e instanceof NotFoundError || (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") ? 404 :
      e instanceof ValidationError ? 400 :
      500;
    return NextResponse.json({ error: message }, { status });
  }
}
