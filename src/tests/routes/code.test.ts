import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/code-projects", () => ({
  initProject: vi.fn(),
  listProjects: vi.fn().mockResolvedValue([]),
  getProject: vi.fn(),
  deleteProject: vi.fn().mockResolvedValue(undefined),
  listFiles: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue("content"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  editFile: vi.fn().mockResolvedValue({ applied: 1 }),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  searchFiles: vi.fn().mockResolvedValue([]),
  buildProject: vi.fn().mockResolvedValue({ url: "/test", filesInlined: 0 }),
  validateProjectId: vi.fn((id: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(id)),
  NotFoundError: class extends Error { constructor(m: string) { super(m); this.name = "NotFoundError"; } },
  ValidationError: class extends Error { constructor(m: string) { super(m); this.name = "ValidationError"; } },
}));

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
} from "@/lib/code-projects";

const mockInitProject = vi.mocked(initProject);
const mockGetProject = vi.mocked(getProject);
const mockSearchFiles = vi.mocked(searchFiles);

describe("/setup-api/code", () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(readFile).mockResolvedValue("content");
    vi.mocked(editFile).mockResolvedValue({ applied: 1 });
    vi.mocked(searchFiles).mockResolvedValue([]);
    vi.mocked(buildProject).mockResolvedValue({ url: "/test", filesInlined: 0, html: "" });
    vi.mocked(listFiles).mockResolvedValue([]);
    const mod = await import("@/app/setup-api/code/route");
    POST = mod.POST;
  });

  function req(body: object) {
    return new NextRequest(new URL("http://localhost/setup-api/code"), {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("init: creates a project", async () => {
    mockInitProject.mockResolvedValue({ projectId: "test", name: "Test", color: "#f97316", description: "", created: "", updated: "" });
    const res = await POST(req({ action: "init", projectId: "test", name: "Test" }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.project.projectId).toBe("test");
  });

  it("init: rejects invalid ID", async () => {
    const res = await POST(req({ action: "init", projectId: "../hack", name: "Bad" }));
    expect(res.status).toBe(400);
  });

  it("init: rejects missing name", async () => {
    const res = await POST(req({ action: "init", projectId: "test" }));
    expect(res.status).toBe(400);
  });

  it("list-projects: returns list", async () => {
    const res = await POST(req({ action: "list-projects" }));
    const body = await res.json();
    expect(body.projects).toEqual([]);
  });

  it("get-project: returns project", async () => {
    mockGetProject.mockResolvedValue({ projectId: "test", name: "Test", color: "", description: "", created: "", updated: "" });
    const res = await POST(req({ action: "get-project", projectId: "test" }));
    const body = await res.json();
    expect(body.project.projectId).toBe("test");
  });

  it("delete-project: deletes", async () => {
    const res = await POST(req({ action: "delete-project", projectId: "test" }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("file-list: returns files", async () => {
    const res = await POST(req({ action: "file-list", projectId: "test" }));
    const body = await res.json();
    expect(body.files).toEqual([]);
  });

  it("file-read: returns content", async () => {
    const res = await POST(req({ action: "file-read", projectId: "test", filePath: "index.html" }));
    const body = await res.json();
    expect(body.content).toBe("content");
  });

  it("file-write: writes file", async () => {
    const res = await POST(req({ action: "file-write", projectId: "test", filePath: "test.js", content: "code" }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("file-edit: edits file", async () => {
    const res = await POST(req({ action: "file-edit", projectId: "test", filePath: "test.js", oldString: "old", newString: "new" }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.replacements).toBe(1);
  });

  it("file-edit: rejects same strings", async () => {
    const res = await POST(req({ action: "file-edit", projectId: "test", filePath: "test.js", oldString: "same", newString: "same" }));
    expect(res.status).toBe(400);
  });

  it("file-delete: deletes file", async () => {
    const res = await POST(req({ action: "file-delete", projectId: "test", filePath: "old.js" }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("search: returns matches", async () => {
    mockSearchFiles.mockResolvedValue([{ file: "test.js", line: 1, content: "match" }]);
    const res = await POST(req({ action: "search", projectId: "test", pattern: "match" }));
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("build: builds project", async () => {
    const res = await POST(req({ action: "build", projectId: "test" }));
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("unknown action: returns 400", async () => {
    const res = await POST(req({ action: "unknown" }));
    expect(res.status).toBe(400);
  });
});
