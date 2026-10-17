/**
 * An undo whose commit fails (a git lock, a full disk) answers what git said,
 * as `commit_failed`, and leaves the vault as it was — never a generic "could
 * not be read", never a half-applied revert. Over a REAL git vault; the names
 * in the fixtures are invented.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** How many of the next vault commits fail. */
const commitFault = vi.hoisted(() => ({ failures: 0 }));
vi.mock("@/lib/prime-radiant/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prime-radiant/git")>();
  return {
    ...actual,
    commitPaths: async (...args: Parameters<typeof actual.commitPaths>) => {
      if (commitFault.failures > 0) {
        commitFault.failures -= 1;
        throw new Error("git commit failed: fatal: Unable to create 'index.lock': File exists.");
      }
      return actual.commitPaths(...args);
    },
  };
});

import { git, headCommit, showFileAt } from "@/lib/prime-radiant/git";
import { HistoryError, revertCommit } from "@/lib/prime-radiant/history";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { ensureVault, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-revert-failure-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

beforeEach(async () => {
  commitFault.failures = 0;
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  await ensureVault();
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("an undo whose commit fails", () => {
  it("answers commit_failed with git's own words, and leaves the vault as it was", async () => {
    const ingest = await vaultOperation("ingest: 1 document", async (tx) => {
      await tx.write("entities/globex.md", pageText({ title: "Globex", claims: [claim("globex/profile/founded", "Globex was founded in 1990.")] }));
      await tx.write("index.md", "# Index\n\n- [[entities/globex]]\n");
    });
    const head = (await headCommit(vaultDir()))!.sha;

    commitFault.failures = 1;
    const err = await revertCommit({ sha: ingest.commit! }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HistoryError);
    expect(err).toMatchObject({ code: "commit_failed", status: 500 });
    expect((err as HistoryError).message).toContain("index.lock");

    // Nothing half-done: the same head, the page still there, nothing staged or deleted on disk.
    expect((await headCommit(vaultDir()))!.sha).toBe(head);
    expect(await showFileAt(vaultDir(), "HEAD", "entities/globex.md")).not.toBeNull();
    expect(fs.existsSync(path.join(vaultDir(), "entities", "globex.md"))).toBe(true);
    expect((await git(vaultDir(), ["status", "--porcelain"])).stdout.trim()).toBe("");

    // Once git can commit again, the same undo goes through.
    const undone = await revertCommit({ sha: ingest.commit! });
    expect(undone.commit).toBeTruthy();
    expect(await showFileAt(vaultDir(), "HEAD", "entities/globex.md")).toBeNull();
  });
});
