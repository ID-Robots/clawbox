import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "path";

// Track written files/dirs for assertions
const writtenFiles = new Map<string, string>();
const createdDirs = new Set<string>();
const existingFiles = new Map<string, string>();
const existingDirs = new Set<string>();
const removedPaths = new Set<string>();

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(async (p: string) => { createdDirs.add(p); }),
    writeFile: vi.fn(async (p: string, content: string) => { writtenFiles.set(p, content); }),
    readFile: vi.fn(async (p: string) => {
      if (existingFiles.has(p)) return existingFiles.get(p)!;
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
      err.code = "ENOENT";
      throw err;
    }),
    readdir: vi.fn(async (p: string) => {
      if (p.includes("code-projects") && !p.includes("/")) {
        return [];
      }
      return [];
    }),
    stat: vi.fn(async (p: string) => {
      if (existingFiles.has(p) || existingDirs.has(p)) {
        return { isDirectory: () => existingDirs.has(p), size: existingFiles.get(p)?.length ?? 0 };
      }
      throw new Error("ENOENT");
    }),
    rm: vi.fn(async (p: string) => { removedPaths.add(p); }),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/test-data",
}));

import {
  validateProjectId,
  initProject,
  listProjects,
  getProject,
  deleteProject,
  writeFile,
  readFile,
  editFile,
  deleteFile,
  searchFiles,
  buildProject,
  APP_ID_RE,
  WEBAPPS_DIR,
  ValidationError,
  NotFoundError,
} from "@/lib/code-projects";

import fs from "fs/promises";
const mockReadFile = vi.mocked(fs.readFile);
const mockReaddir = vi.mocked(fs.readdir);
const mockStat = vi.mocked(fs.stat);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockRm = vi.mocked(fs.rm);

describe("code-projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writtenFiles.clear();
    createdDirs.clear();
    existingFiles.clear();
    existingDirs.clear();
    removedPaths.clear();
  });

  describe("validateProjectId", () => {
    it("accepts valid IDs", () => {
      expect(validateProjectId("my-app")).toBe(true);
      expect(validateProjectId("app_123")).toBe(true);
      expect(validateProjectId("Test-App")).toBe(true);
    });

    it("rejects invalid IDs", () => {
      expect(validateProjectId("")).toBe(false);
      expect(validateProjectId("../hack")).toBe(false);
      expect(validateProjectId("a".repeat(65))).toBe(false);
      expect(validateProjectId("has spaces")).toBe(false);
    });
  });

  describe("APP_ID_RE", () => {
    it("matches valid IDs", () => {
      expect(APP_ID_RE.test("hello")).toBe(true);
      expect(APP_ID_RE.test("a-b_c")).toBe(true);
    });

    it("rejects invalid IDs", () => {
      expect(APP_ID_RE.test("")).toBe(false);
      expect(APP_ID_RE.test("a/b")).toBe(false);
    });
  });

  describe("WEBAPPS_DIR", () => {
    it("is defined", () => {
      expect(WEBAPPS_DIR).toBeDefined();
      expect(WEBAPPS_DIR).toContain("webapps");
    });
  });

  describe("initProject", () => {
    it("creates project with app template", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));
      const meta = await initProject("test-app", "Test App");
      expect(meta.projectId).toBe("test-app");
      expect(meta.name).toBe("Test App");
      expect(meta.color).toBe("#f97316");
      expect(mockMkdir).toHaveBeenCalled();
      // Should write index.html, style.css, app.js, project.json
      expect(mockWriteFile).toHaveBeenCalledTimes(4);
    });

    it("creates project with blank template", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));
      const meta = await initProject("blank-app", "Blank", { template: "blank" });
      expect(meta.projectId).toBe("blank-app");
      // Should write index.html and project.json only
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });

    it("rejects invalid project ID", async () => {
      await expect(initProject("../hack", "Bad")).rejects.toThrow(ValidationError);
    });

    it("rejects duplicate project", async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true, size: 0 } as never);
      await expect(initProject("exists", "Exists")).rejects.toThrow(ValidationError);
    });

    it("uses custom color and description", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));
      const meta = await initProject("custom", "Custom", {
        color: "#ff0000",
        description: "My app",
      });
      expect(meta.color).toBe("#ff0000");
      expect(meta.description).toBe("My app");
    });
  });

  describe("listProjects", () => {
    it("returns empty list when no projects", async () => {
      mockReaddir.mockResolvedValue([] as never);
      const projects = await listProjects();
      expect(projects).toEqual([]);
    });

    it("returns sorted projects", async () => {
      mockReaddir.mockResolvedValue([
        { name: "proj-a", isDirectory: () => true },
        { name: "proj-b", isDirectory: () => true },
        { name: "not-a-dir", isDirectory: () => false },
      ] as never);
      const metaA = JSON.stringify({ projectId: "proj-a", name: "A", updated: "2026-01-01" });
      const metaB = JSON.stringify({ projectId: "proj-b", name: "B", updated: "2026-01-02" });
      mockReadFile.mockImplementation(async (p) => {
        const s = String(p);
        if (s.includes("proj-a")) return metaA;
        if (s.includes("proj-b")) return metaB;
        throw new Error("Not found");
      });
      const projects = await listProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0].projectId).toBe("proj-b"); // newer first
    });
  });

  describe("getProject", () => {
    it("reads project metadata", async () => {
      const meta = { projectId: "test", name: "Test" };
      mockReadFile.mockResolvedValue(JSON.stringify(meta));
      const result = await getProject("test");
      expect(result.projectId).toBe("test");
    });
  });

  describe("deleteProject", () => {
    it("removes project directory", async () => {
      await deleteProject("test-app");
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining("test-app"),
        expect.objectContaining({ recursive: true })
      );
    });

    it("rejects invalid ID", async () => {
      await expect(deleteProject("../hack")).rejects.toThrow(ValidationError);
    });
  });

  describe("writeFile", () => {
    it("writes a file", async () => {
      mockStat.mockRejectedValueOnce(new Error("ENOENT")); // file doesn't exist
      mockReaddir.mockResolvedValue([] as never); // countFiles
      await writeFile("myapp", "hello.txt", "hello world");
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("hello.txt"),
        "hello world",
        "utf-8"
      );
    });

    it("rejects project.json writes", async () => {
      await expect(writeFile("myapp", "project.json", "{}")).rejects.toThrow(ValidationError);
    });

    it("rejects oversized files", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));
      mockReaddir.mockResolvedValue([] as never);
      const bigContent = "x".repeat(512 * 1024 + 1);
      await expect(writeFile("myapp", "big.txt", bigContent)).rejects.toThrow(ValidationError);
    });

    it("rejects path traversal", async () => {
      await expect(writeFile("myapp", "../../etc/passwd", "hack")).rejects.toThrow(ValidationError);
    });
  });

  describe("readFile", () => {
    it("reads a file", async () => {
      mockReadFile.mockResolvedValue("file content");
      const content = await readFile("myapp", "index.html");
      expect(content).toBe("file content");
    });
  });

  describe("editFile", () => {
    it("replaces a string", async () => {
      mockReadFile.mockResolvedValue("hello world");
      // Mock for touchProject → getProject
      mockReadFile.mockResolvedValueOnce("hello world");
      const result = await editFile("myapp", "test.txt", "hello", "goodbye");
      expect(result.applied).toBe(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("test.txt"),
        "goodbye world",
        "utf-8"
      );
    });

    it("replaces all occurrences", async () => {
      mockReadFile.mockResolvedValue("aaa");
      const result = await editFile("myapp", "test.txt", "a", "b", true);
      expect(result.applied).toBe(3);
    });

    it("rejects when string not found", async () => {
      mockReadFile.mockResolvedValue("hello");
      await expect(editFile("myapp", "test.txt", "xyz", "abc")).rejects.toThrow(ValidationError);
    });

    it("rejects ambiguous single replacement", async () => {
      mockReadFile.mockResolvedValue("aXa");
      await expect(editFile("myapp", "test.txt", "a", "b")).rejects.toThrow(ValidationError);
    });

    it("rejects project.json edits", async () => {
      await expect(editFile("myapp", "project.json", "a", "b")).rejects.toThrow(ValidationError);
    });
  });

  describe("deleteFile", () => {
    it("removes a file", async () => {
      // Mock touchProject
      mockReadFile.mockRejectedValue(new Error("no meta"));
      await deleteFile("myapp", "old.txt");
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining("old.txt"),
        expect.objectContaining({ recursive: true })
      );
    });

    it("rejects project.json deletion", async () => {
      await expect(deleteFile("myapp", "project.json")).rejects.toThrow(ValidationError);
    });
  });

  describe("searchFiles", () => {
    it("finds matches in text files", async () => {
      mockReaddir.mockResolvedValue([
        { name: "app.js", isDirectory: () => false },
      ] as never);
      mockReadFile.mockResolvedValue("line 1\nhello world\nline 3");
      const results = await searchFiles("myapp", "hello");
      expect(results).toHaveLength(1);
      expect(results[0].line).toBe(2);
      expect(results[0].content).toContain("hello");
    });

    it("supports case-insensitive search", async () => {
      mockReaddir.mockResolvedValue([
        { name: "test.js", isDirectory: () => false },
      ] as never);
      mockReadFile.mockResolvedValue("Hello World");
      const results = await searchFiles("myapp", "hello", { caseSensitive: false });
      expect(results).toHaveLength(1);
    });

    it("supports regex search", async () => {
      mockReaddir.mockResolvedValue([
        { name: "test.js", isDirectory: () => false },
      ] as never);
      mockReadFile.mockResolvedValue("foo123bar");
      const results = await searchFiles("myapp", "\\d+", { regex: true });
      expect(results).toHaveLength(1);
    });

    it("rejects invalid regex", async () => {
      mockReaddir.mockResolvedValue([] as never);
      await expect(searchFiles("myapp", "[invalid", { regex: true })).rejects.toThrow(ValidationError);
    });
  });

  describe("buildProject", () => {
    it("builds and deploys a project", async () => {
      const meta = JSON.stringify({ projectId: "myapp", name: "My App", color: "#f97316" });
      const indexHtml = `<html><head><link rel="stylesheet" href="style.css"></head><body><script src="app.js"></script></body></html>`;

      mockReadFile
        .mockResolvedValueOnce(meta)       // getProject
        .mockResolvedValueOnce(indexHtml)   // read index.html
        .mockResolvedValueOnce("body{}")    // inline style.css
        .mockResolvedValueOnce("alert(1)"); // inline app.js

      const result = await buildProject("myapp");
      expect(result.url).toContain("myapp");
      expect(result.filesInlined).toBe(2);
      expect(result.html).toContain("<style>");
      expect(result.html).toContain("alert(1)");
    });

    it("throws when index.html is missing", async () => {
      const meta = JSON.stringify({ projectId: "myapp", name: "My App", color: "#f97316" });
      mockReadFile
        .mockResolvedValueOnce(meta)
        .mockRejectedValueOnce(new Error("ENOENT")); // no index.html
      await expect(buildProject("myapp")).rejects.toThrow(NotFoundError);
    });

    it("preserves external URLs", async () => {
      const meta = JSON.stringify({ projectId: "myapp", name: "My App", color: "#f97316" });
      const indexHtml = `<html><head><link rel="stylesheet" href="https://cdn.example.com/style.css"></head><body></body></html>`;
      mockReadFile
        .mockResolvedValueOnce(meta)
        .mockResolvedValueOnce(indexHtml);
      const result = await buildProject("myapp");
      expect(result.html).toContain("https://cdn.example.com/style.css");
      expect(result.filesInlined).toBe(0);
    });

    it("uses custom name and color", async () => {
      const meta = JSON.stringify({ projectId: "myapp", name: "Old Name", color: "#000" });
      const indexHtml = `<html><body></body></html>`;
      mockReadFile
        .mockResolvedValueOnce(meta)
        .mockResolvedValueOnce(indexHtml);
      const result = await buildProject("myapp", { name: "New Name", color: "#fff" });
      expect(result.url).toContain("myapp");
    });
  });

  describe("error types", () => {
    it("NotFoundError has correct name", () => {
      const err = new NotFoundError("test");
      expect(err.name).toBe("NotFoundError");
      expect(err.message).toBe("test");
    });

    it("ValidationError has correct name", () => {
      const err = new ValidationError("test");
      expect(err.name).toBe("ValidationError");
      expect(err.message).toBe("test");
    });
  });
});
