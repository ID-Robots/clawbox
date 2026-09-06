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

// buildProject now registers the built app on the desktop (durability backstop).
// Stub it so the build tests stay focused on the build output, not config IO.
vi.mock("@/lib/webapp-registry", () => ({
  registerWebappInPreferences: vi.fn(),
}));

// deployWebapp also fires off icon generation for an app created without one
// (fire-and-forget, never awaited). Stub it so these tests never reach the
// ClawBox AI proxy; the real module is covered in webapp-icon.test.ts.
vi.mock("@/lib/webapp-icon", () => ({
  ensureWebappIcon: vi.fn(async () => "skipped"),
  htmlHint: vi.fn(() => ""),
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
  MAX_PROJECT_NAME_LENGTH,
  WEBAPPS_DIR,
  legacyRedirectPort,
  projectPath,
  serverAppDownHtml,
  ValidationError,
  NotFoundError,
} from "@/lib/code-projects";

import fs from "fs/promises";
import { registerWebappInPreferences } from "@/lib/webapp-registry";
const mockReadFile = vi.mocked(fs.readFile);
const mockReaddir = vi.mocked(fs.readdir);
const mockStat = vi.mocked(fs.stat);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockRm = vi.mocked(fs.rm);
const mockRegisterWebappInPreferences = vi.mocked(registerWebappInPreferences);

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

  // The agent edits project files from a process whose working directory is
  // NOT the web tier's, so a relative path resolves to a different tree — it
  // read nothing and wrote into /home/clawbox/data/... Absolute is the only
  // form both processes agree on.
  describe("projectPath", () => {
    it("is absolute and points into the code-projects directory", () => {
      const dir = projectPath("notes");
      expect(path.isAbsolute(dir)).toBe(true);
      expect(dir).toBe(path.join(path.dirname(WEBAPPS_DIR), "code-projects", "notes"));
    });

    it("resolves the same from any working directory", () => {
      const dir = projectPath("notes");
      for (const cwd of ["/", "/home/clawbox", "/home/clawbox/clawbox"]) {
        expect(path.resolve(cwd, dir)).toBe(dir);
      }
    });

    it("refuses an id that could escape the projects directory", () => {
      expect(() => projectPath("../hack")).toThrow(ValidationError);
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
      // index.html, style.css, app.js, project.json — and .github/workflows/
      // check.yml, which exists so the auto-PR flow has a real check to wait
      // on: it refuses to merge a pull request with NO checks, so a project
      // without one could open pull requests that can never satisfy their own
      // guardrail.
      expect(mockWriteFile).toHaveBeenCalledTimes(5);
      expect(mockWriteFile.mock.calls.some(([file]) => String(file).endsWith(".github/workflows/check.yml"))).toBe(true);
      // The built app runs in a sandboxed frame; the KV bridge is its only
      // way to persist anything, and the field guide assumes it is there.
      const index = [...writtenFiles.entries()].find(([p]) => p.endsWith("index.html"))?.[1];
      expect(index).toContain("window.clawboxKv");
    });

    it("creates project with blank template", async () => {
      mockStat.mockRejectedValue(new Error("ENOENT"));
      const meta = await initProject("blank-app", "Blank", { template: "blank" });
      expect(meta.projectId).toBe("blank-app");
      // Should write index.html and project.json only
      expect(mockWriteFile).toHaveBeenCalledTimes(3);
      const index = [...writtenFiles.entries()].find(([p]) => p.endsWith("index.html"))?.[1];
      expect(index).toContain("window.clawboxKv");
    });

    it("rejects invalid project ID", async () => {
      await expect(initProject("../hack", "Bad")).rejects.toThrow(ValidationError);
    });

    describe("the name it will accept", () => {
      // Checked before anything is created, so a refused name leaves no
      // directory behind for the next attempt to collide with.
      const badNames: Array<[string, unknown]> = [
        ["a name of the wrong type", 42],
        ["a missing name", undefined],
        ["an empty name", ""],
        ["a name that is only spaces", "   "],
        ["a name past the length limit", "x".repeat(MAX_PROJECT_NAME_LENGTH + 1)],
      ];

      for (const [label, name] of badNames) {
        it(`refuses ${label} without creating anything`, async () => {
          mockStat.mockRejectedValue(new Error("ENOENT"));
          await expect(
            initProject("test-app", name as string),
          ).rejects.toThrow(ValidationError);
          expect(mockMkdir).not.toHaveBeenCalled();
          expect(mockWriteFile).not.toHaveBeenCalled();
        });
      }

      it("stores a name with surrounding whitespace trimmed", async () => {
        mockStat.mockRejectedValue(new Error("ENOENT"));
        const meta = await initProject("test-app", "  Test App  ");
        expect(meta.name).toBe("Test App");
      });

      it("accepts a name exactly at the length limit", async () => {
        mockStat.mockRejectedValue(new Error("ENOENT"));
        const name = "x".repeat(MAX_PROJECT_NAME_LENGTH);
        await expect(initProject("test-app", name)).resolves.toMatchObject({ name });
      });
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

    // The regex branch is gone: "(a+)+$" over a 30-character line held the
    // box's one event loop for minutes, and no pattern-length cap or line
    // slice bounds a cost that is exponential in the LINE. The pattern is a
    // literal now, whatever it looks like.
    it("matches a regex-shaped pattern as literal text", async () => {
      mockReaddir.mockResolvedValue([
        { name: "test.js", isDirectory: () => false },
      ] as never);
      mockReadFile.mockResolvedValue("foo123bar\nliteral (a+)+$ here\n\\d+ too");
      expect(await searchFiles("myapp", "(a+)+$")).toEqual([
        { file: "test.js", line: 2, content: "literal (a+)+$ here" },
      ]);
      // A pattern that WAS a regex once finds only itself, not the digits.
      expect(await searchFiles("myapp", "\\d+")).toEqual([
        { file: "test.js", line: 3, content: "\\d+ too" },
      ]);
    });

    it("settles at once on the line that made the regex branch a denial of service", async () => {
      // 40 a's and a bang: as a regex "(a+)+$" would have backtracked over
      // this for hours, synchronously, in the web server's process.
      mockReaddir.mockResolvedValue([
        { name: "x.txt", isDirectory: () => false },
      ] as never);
      mockReadFile.mockResolvedValue("a".repeat(40) + "!");
      const started = performance.now();
      const results = await searchFiles("myapp", "(a+)+$");
      expect(performance.now() - started).toBeLessThan(1000);
      expect(results).toEqual([]);
    });

    it("never compiles the pattern — a bracket no regex would accept is just text", async () => {
      mockReaddir.mockResolvedValue([
        { name: "test.js", isDirectory: () => false },
      ] as never);
      mockReadFile.mockResolvedValue("see [invalid here");
      const results = await searchFiles("myapp", "[invalid");
      expect(results).toHaveLength(1);
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
      // First build must durably register the app on the desktop — a
      // regression that drops registration would otherwise pass silently.
      expect(mockRegisterWebappInPreferences).toHaveBeenCalledWith(
        "myapp",
        "My App",
        expect.objectContaining({
          color: "#f97316",
          webappUrl: "/setup-api/webapps?app=myapp",
        }),
      );
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

  // The stubs the box wrote before /apps/<id>/ existed: one line of script
  // sending the frame to `location.hostname:<port>`. With the server down the
  // window was a white rectangle, so the webapps route has to recognise one —
  // and must never mistake a real app for one, because a stub it "recognises"
  // is a stub it does not serve.
  describe("legacyRedirectPort", () => {
    it("reads the port out of the stub the box used to write", () => {
      expect(
        legacyRedirectPort(
          `<!doctype html><html><body><script>location.replace(location.protocol+'//'+location.hostname+':4230/');</script></body></html>`,
        ),
      ).toBe(4230);
      expect(legacyRedirectPort(`<script>window.location.href='http://'+location.hostname+':4199'</script>`)).toBe(4199);
      expect(legacyRedirectPort(`<script>location.assign("//"+location.hostname+":18080/app")</script>`)).toBe(18080);
    });

    it("says nothing about a document that is not one", () => {
      // No redirect at all.
      expect(legacyRedirectPort(`<p>${"x"}</p><script>document.title=location.hostname;</script>`)).toBeNull();
      // A redirect that names no host of its own — the proxy stub itself.
      expect(legacyRedirectPort(`<script>location.replace("/apps/game/");</script>`)).toBeNull();
      // A port no local server may hold, and one that is not a port at all.
      expect(legacyRedirectPort(`<script>location.replace(location.hostname+':80/')</script>`)).toBeNull();
      expect(legacyRedirectPort(`<script>location.replace(location.hostname+':70000/')</script>`)).toBeNull();
      // Too big to be a stub: a whole app that happens to read its hostname.
      const app = `<script>location.replace(location.hostname+':4230/')</script>${"<div></div>".repeat(600)}`;
      expect(app.length).toBeGreaterThan(4096);
      expect(legacyRedirectPort(app)).toBeNull();
    });
  });

  describe("serverAppDownHtml", () => {
    it("says which app and why, with the name and the reason escaped", () => {
      const html = serverAppDownHtml(`Cool <Game>`, `Nothing is listening on port 4199.`);
      expect(html).toContain("Cool &lt;Game&gt;");
      expect(html).toContain("Nothing is listening on port 4199.");
      expect(html).not.toContain("<Game>");
      // No script: it renders in a frame with an opaque origin.
      expect(html).not.toContain("<script");
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
