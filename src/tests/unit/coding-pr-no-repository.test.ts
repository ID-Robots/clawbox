/**
 * @vitest-environment node
 *
 * A folder that is not a git repository yet is a fact startRunBranch can
 * name, not a failure it words with git's own fatal: the runner commits into
 * a fresh repository at settle (commitRunWork) and says so, and a pull
 * request waits for a remote the owner adds later. Real git, one call.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { startRunBranch } from "@/lib/coding-pr";

describe("startRunBranch on a folder that is not a repository", () => {
  it("answers a typed reason and its own sentence, never git's fatal", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-pr-norepo-"));
    try {
      const result = await startRunBranch({ directory: base, runId: "run-abcd1234", protectedRoot: path.join(base, "elsewhere") });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("no_repository");
      expect(result.detail).toBe("Not a git repository yet.");
      expect(result.detail).not.toMatch(/fatal/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
