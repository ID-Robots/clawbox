import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

// The effective branch is worked out with git; the route's own contract is
// what it does with the answer, so the resolver is stubbed here and covered
// against real repositories in updater-branch-resolution.test.ts.
const { mockResolveEffective } = vi.hoisted(() => ({ mockResolveEffective: vi.fn() }));
vi.mock("@/lib/updater", () => ({ resolveEffectiveUpdateBranch: mockResolveEffective }));

const mockReadFile = vi.mocked(fsp.readFile);
const mockWriteFile = vi.mocked(fsp.writeFile);
const mockUnlink = vi.mocked(fsp.unlink);

describe("/setup-api/system/update-branch", () => {
  let updateBranchGet: () => Promise<Response>;
  let updateBranchPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockReadFile.mockResolvedValue("main\n");
    mockWriteFile.mockResolvedValue();
    mockUnlink.mockResolvedValue();
    mockResolveEffective.mockResolvedValue({ branch: "main", source: "default" });

    const mod = await import("@/app/setup-api/system/update-branch/route");
    updateBranchGet = mod.GET;
    updateBranchPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET", () => {
    it("returns current branch", async () => {
      mockReadFile.mockResolvedValue("feature/my-branch\n");

      const res = await updateBranchGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.branch).toBe("feature/my-branch");
    });

    it("returns null when file is empty", async () => {
      mockReadFile.mockResolvedValue("");

      const res = await updateBranchGet();
      const body = await res.json();

      expect(body.branch).toBe(null);
    });

    it("returns null when file doesn't exist", async () => {
      const enoent = new Error("ENOENT") as Error & { code: string };
      enoent.code = "ENOENT";
      mockReadFile.mockRejectedValue(enoent);

      const res = await updateBranchGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.branch).toBe(null);
    });

    it("names the branch updates follow when nothing is recorded (TASK-1213)", async () => {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      mockReadFile.mockRejectedValue(enoent);

      const res = await updateBranchGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ branch: null, effective: { branch: "main", source: "default" } });
    });

    it("names the recorded branch as the effective one when there is a pin", async () => {
      mockReadFile.mockResolvedValue("beta\n");
      mockResolveEffective.mockResolvedValue({ branch: "beta", source: "pin-file" });

      const body = await (await updateBranchGet()).json();

      expect(body).toEqual({ branch: "beta", effective: { branch: "beta", source: "pin-file" } });
    });

    it("still answers the recorded branch when the effective one cannot be worked out", async () => {
      mockReadFile.mockResolvedValue("beta\n");
      mockResolveEffective.mockRejectedValue(new Error("git exploded"));

      const res = await updateBranchGet();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ branch: "beta", effective: null });
    });

    it("returns 500 on other errors", async () => {
      mockReadFile.mockRejectedValue(new Error("Permission denied"));

      const res = await updateBranchGet();
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe("Permission denied");
    });
  });

  describe("POST", () => {
    it("sets branch successfully", async () => {
      const res = await updateBranchPost(jsonRequest({ branch: "feature/test" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.branch).toBe("feature/test");
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(".update-branch"),
        "feature/test\n",
        "utf-8"
      );
    });

    it("clears branch when set to null", async () => {
      const res = await updateBranchPost(jsonRequest({ branch: null }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.branch).toBe(null);
      expect(mockUnlink).toHaveBeenCalled();
      // The owner sees at once what clearing the pin fell back to.
      expect(body.effective).toEqual({ branch: "main", source: "default" });
    });

    it("answers the new effective branch after a save", async () => {
      mockResolveEffective.mockResolvedValue({ branch: "beta", source: "pin-file" });

      const body = await (await updateBranchPost(jsonRequest({ branch: "beta" }))).json();

      expect(body).toEqual({ success: true, branch: "beta", effective: { branch: "beta", source: "pin-file" } });
    });

    it("clears branch when set to empty string", async () => {
      const res = await updateBranchPost(jsonRequest({ branch: "" }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.branch).toBe(null);
    });

    it("returns 400 for invalid branch name", async () => {
      const invalidBranches = [
        "branch with spaces",
        "branch!special",
        "branch\nnewline",
      ];

      for (const branch of invalidBranches) {
        const res = await updateBranchPost(jsonRequest({ branch }));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toBe("Invalid branch name");
      }
    });

    it("accepts valid branch name formats", async () => {
      const validBranches = [
        "main",
        "feature/my-feature",
        "release/v1.0.0",
        "fix_something",
        "feature/branch.name",
      ];

      for (const branch of validBranches) {
        const res = await updateBranchPost(jsonRequest({ branch }));
        expect(res.status).toBe(200);
      }
    });

    it("handles ENOENT when clearing non-existent file", async () => {
      const enoent = new Error("ENOENT") as Error & { code: string };
      enoent.code = "ENOENT";
      mockUnlink.mockRejectedValue(enoent);

      const res = await updateBranchPost(jsonRequest({ branch: null }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it("returns 500 on write error", async () => {
      mockWriteFile.mockRejectedValue(new Error("Disk full"));

      const res = await updateBranchPost(jsonRequest({ branch: "feature/test" }));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe("Disk full");
    });
  });
});
