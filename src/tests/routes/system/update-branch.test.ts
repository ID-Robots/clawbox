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
const { mockResolveEffective, mockDowngrade, mockInvalidate } = vi.hoisted(() => ({ mockResolveEffective: vi.fn(), mockDowngrade: vi.fn(), mockInvalidate: vi.fn() }));
vi.mock("@/lib/updater", () => ({
  resolveEffectiveUpdateBranch: mockResolveEffective,
  // A good update verdict is cached for 30 min; the route drops it when the
  // branch it was for changes (the assertions below).
  invalidateVersionCache: mockInvalidate,
  // Read off origin with git in the updater (updater-harness-downgrade.test.ts);
  // here, what the route does with the answer.
  checkBranchHarnessDowngrade: mockDowngrade,
}));

/** What `main` would bring a box that ran OpenClaw 2026.10.6: the older 2026.10.3. */
const DOWNGRADE = {
  branch: "main",
  downgrades: [{
    harness: "openclaw",
    installed: "2026.10.6",
    target: "2026.10.3",
    schema: { database: "agent", label: "/home/clawbox/.openclaw/agents/main/agent/openclaw-agent.sqlite", onDisk: 25, supported: 24 },
  }],
};

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
    mockDowngrade.mockResolvedValue(null);

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
      // The next version poll must look at feature/test, not at the verdict
      // cached for the previous branch.
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
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
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
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

    it("keeps the cached verdict when nothing was recorded", async () => {
      const res = await updateBranchPost(jsonRequest({ branch: "not a branch" }));

      expect(res.status).toBe(400);
      expect(mockInvalidate).not.toHaveBeenCalled();
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

  describe("POST: a branch that would install an older harness", () => {
    it("is refused with 409 and the detail, and the branch on record is left alone", async () => {
      mockDowngrade.mockResolvedValue(DOWNGRADE);

      const res = await updateBranchPost(jsonRequest({ branch: "main" }));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.code).toBe("harness_downgrade");
      expect(body.downgrade).toEqual(DOWNGRADE);
      expect(body.error).toMatch(/^Branch "main" would install an older assistant\. /);
      expect(body.error).toContain("is on agent schema 25");
      expect(body.error).toContain("the update branch was not changed");
      expect(mockDowngrade).toHaveBeenCalledWith("main");
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it("is recorded on the owner's explicit override, without asking", async () => {
      mockDowngrade.mockResolvedValue(DOWNGRADE);

      const res = await updateBranchPost(jsonRequest({ branch: "main", allowHarnessDowngrade: true }));

      expect(res.status).toBe(200);
      expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining(".update-branch"), "main\n", "utf-8");
      expect(mockDowngrade).not.toHaveBeenCalled();
    });

    it("counts only a literal true as the override", async () => {
      mockDowngrade.mockResolvedValue(DOWNGRADE);

      const res = await updateBranchPost(jsonRequest({ branch: "main", allowHarnessDowngrade: "yes" }));

      expect(res.status).toBe(409);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("puts the pin back when clearing it would fall back to an older branch", async () => {
      mockReadFile.mockResolvedValue("beta\n");
      mockDowngrade.mockResolvedValue(DOWNGRADE);

      const res = await updateBranchPost(jsonRequest({ branch: null }));

      expect(res.status).toBe(409);
      // Asked of where clearing lands (the effective branch with no pin) …
      expect(mockDowngrade).toHaveBeenCalledWith("main");
      // … and the pin that was there is written back as it was.
      expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining(".update-branch"), "beta\n", "utf-8");
      // The pin is back where it was, so the cached verdict still holds.
      expect(mockInvalidate).not.toHaveBeenCalled();
    });

    it("lets the same or a newer branch through, and a check that cannot run", async () => {
      mockDowngrade.mockResolvedValue(null);
      expect((await updateBranchPost(jsonRequest({ branch: "beta" }))).status).toBe(200);
      mockDowngrade.mockRejectedValue(new Error("git exploded"));
      expect((await updateBranchPost(jsonRequest({ branch: "beta" }))).status).toBe(200);
    });
  });
});
