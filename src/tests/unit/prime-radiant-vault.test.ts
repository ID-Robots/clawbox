/**
 * The vault on disk with a REAL git, in a tmp dir: first-run init, one commit
 * per operation, the mutex, the lint gate and the rollback.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Memory Shard reindex a commit hands its pages to. Stubbed here: what it
// does is pinned in prime-radiant-shard-index.test.ts; this suite pins that a
// commit asks for it.
const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn() }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);
import {
  ensureVault,
  readPage,
  readVaultSnapshot,
  vaultInitialised,
  vaultOperation,
  VaultLintBlockedError,
  VaultPathError,
} from "@/lib/prime-radiant/vault";
import { changedPaths, commitCount, currentBranch, git, headCommit, logForPath, showFileAt } from "@/lib/prime-radiant/git";
import { safePagePath, stateDbPath, vaultDir } from "@/lib/prime-radiant/paths";
import { readRetiredLedger, syncActiveClaims, withStateDb } from "@/lib/prime-radiant/state-db";
import { claim, frontmatter, pageText } from "../helpers/prime-radiant-fixtures";

// Real git processes, in series: give them room on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-vault-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
const prevHome = process.env.HOME;
let root = "";
let n = 0;

function gitOut(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as unknown as NodeJS.ProcessEnv,
  }).trim();
}

beforeEach(() => {
  shard.scheduleReindexAfterCommit.mockClear();
  root = path.join(base, `case-${++n}`);
  process.env.PRIME_RADIANT_DIR = root;
});

afterEach(() => {
  process.env.HOME = prevHome;
});

afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const INDEXED = (p: string) => `# Index\n\n- [[${p.replace(/\.md$/, "")}]]\n`;

describe("prime radiant vault", () => {
  it("lives under PRIME_RADIANT_DIR with the state db beside it", () => {
    expect(vaultDir()).toBe(path.join(root, "vault"));
    expect(stateDbPath()).toBe(path.join(root, "prime-radiant.sqlite"));
  });

  it("is created on first use as a git repo on main, once", async () => {
    expect(await ensureVault()).toEqual({ created: true });
    const vault = vaultDir();
    expect(await currentBranch(vault)).toBe("main");
    const head = await headCommit(vault);
    expect(head).toMatchObject({ subject: "init: vault", author: "Prime Radiant" });
    expect(gitOut(vault, "log", "-1", "--format=%ae|%cn|%ce")).toBe("prime-radiant@localhost|Prime Radiant|prime-radiant@localhost");
    expect(fs.existsSync(path.join(vault, "index.md"))).toBe(true);
    expect(fs.readFileSync(path.join(vault, ".gitignore"), "utf8")).toContain(".openclaw-wiki/");
    expect(await ensureVault()).toEqual({ created: false });
    expect(await commitCount(vault)).toBe(1);
  });

  it("ignores the owner's global git config (signing, identity, hooks)", async () => {
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n  name = Someone Else\n[commit]\n  gpgsign = true\n[core]\n  hooksPath = /nonexistent\n");
    process.env.HOME = home;
    const { commit } = await vaultOperation("ingest: widget pricing", async (tx) => {
      await tx.write("concepts/pricing.md", pageText());
      await tx.write("index.md", INDEXED("concepts/pricing.md"));
    });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(gitOut(vaultDir(), "log", "-1", "--format=%an")).toBe("Prime Radiant");
  });

  it("records exactly one commit per operation, with only the touched paths", async () => {
    await ensureVault();
    const vault = vaultDir();
    fs.writeFileSync(path.join(vault, "stray.txt"), "not part of the operation");
    const result = await vaultOperation("ingest: widget pricing", async (tx) => {
      await tx.writePage("concepts/pricing", frontmatter(), "Acme Widgets Ltd sells widgets.\n");
      await tx.write("index.md", INDEXED("concepts/pricing.md"));
      return "done";
    });
    expect(result.result).toBe("done");
    expect(result.changed).toEqual(["concepts/pricing.md", "index.md"]);
    expect(await commitCount(vault)).toBe(2);
    expect(gitOut(vault, "show", "--name-only", "--format=%s", "HEAD").split("\n").filter(Boolean)).toEqual([
      "ingest: widget pricing",
      "concepts/pricing.md",
      "index.md",
    ]);
    expect(gitOut(vault, "status", "--porcelain")).toBe("?? stray.txt");
    expect(result.findings.map((f) => f.rule)).toEqual([]);
  });

  it("makes no commit when nothing changed", async () => {
    await vaultOperation("ingest: a", (tx) => tx.write("concepts/pricing.md", pageText()));
    const before = await commitCount(vaultDir());
    const again = await vaultOperation("ingest: a again", (tx) => tx.write("concepts/pricing.md", pageText()));
    expect(again.commit).toBeNull();
    expect(await commitCount(vaultDir())).toBe(before);
    const none = await vaultOperation("noop", async () => 1);
    expect(none.commit).toBeNull();
  });

  it("serialises concurrent operations (read-modify-write of index.md loses nothing)", async () => {
    await ensureVault();
    const vault = vaultDir();
    const indexPath = path.join(vault, "index.md");
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        vaultOperation(`ingest: page ${i}`, async (tx) => {
          const current = fs.readFileSync(indexPath, "utf8");
          await new Promise((r) => setTimeout(r, 5));
          await tx.write(`concepts/page-${i}.md`, pageText({ title: `Page ${i}` }));
          await tx.write("index.md", `${current}- [[concepts/page-${i}]]\n`);
        }),
      ),
    );
    const index = fs.readFileSync(indexPath, "utf8");
    for (let i = 0; i < 6; i++) expect(index).toContain(`[[concepts/page-${i}]]`);
    expect(await commitCount(vault)).toBe(7);
  });

  it("refuses a commit the lint blocks and puts every touched file back", async () => {
    await vaultOperation("ingest: base", async (tx) => {
      await tx.write("concepts/pricing.md", pageText());
      await tx.write("index.md", INDEXED("concepts/pricing.md"));
    });
    const vault = vaultDir();
    const original = fs.readFileSync(path.join(vault, "concepts/pricing.md"), "utf8");
    const commits = await commitCount(vault);
    await expect(
      vaultOperation("ingest: leak", async (tx) => {
        await tx.write("concepts/pricing.md", pageText({}, "Pricing.\n\npassword=Hunter22!\n"));
        await tx.write("concepts/new.md", pageText({ title: "New" }));
      }),
    ).rejects.toBeInstanceOf(VaultLintBlockedError);
    expect(fs.readFileSync(path.join(vault, "concepts/pricing.md"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(vault, "concepts/new.md"))).toBe(false);
    expect(await commitCount(vault)).toBe(commits);
    expect(gitOut(vault, "status", "--porcelain")).toBe("");
  });

  it("rolls back when the operation throws", async () => {
    await vaultOperation("ingest: base", (tx) => tx.write("concepts/pricing.md", pageText()));
    const vault = vaultDir();
    const original = fs.readFileSync(path.join(vault, "concepts/pricing.md"), "utf8");
    await expect(
      vaultOperation("ingest: broken", async (tx) => {
        await tx.write("concepts/pricing.md", pageText({ title: "Changed" }));
        await tx.remove("index.md");
        throw new Error("model call failed");
      }),
    ).rejects.toThrow("model call failed");
    expect(fs.readFileSync(path.join(vault, "concepts/pricing.md"), "utf8")).toBe(original);
    expect(fs.existsSync(path.join(vault, "index.md"))).toBe(true);
  });

  it("lets a non-blocking finding through and reports it", async () => {
    const { commit, findings } = await vaultOperation("ingest: orphan", (tx) => tx.write("concepts/lonely.md", pageText({ title: "Lonely" })));
    expect(commit).not.toBeNull();
    expect(findings.map((f) => f.rule)).toEqual(["orphan"]);
  });

  it("refuses unsafe paths and writes through a symlinked folder", async () => {
    await ensureVault();
    for (const bad of ["../escape.md", "/etc/x.md", ".git/config", "reports/x.md", "AGENTS.md", "a/../../b.md", "a\\b.md"]) {
      await expect(vaultOperation("x", (tx) => tx.write(bad, "x")), bad).rejects.toBeInstanceOf(VaultPathError);
    }
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(vaultDir(), "linked"));
    await expect(vaultOperation("x", (tx) => tx.write("linked/page.md", pageText()))).rejects.toThrow(/leaves the vault/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(safePagePath("entities/acme-widgets")).toBe("entities/acme-widgets.md");
  });

  it("records retirements in the ledger, which then blocks reuse", async () => {
    await vaultOperation("verify: acme-sales/widgets/sizes", async (tx) => {
      await tx.write(
        "concepts/pricing.md",
        pageText({ claims: [claim("acme-sales/widgets/sizes")], retiredClaimIds: ["acme-sales/widgets/old-sizes"] }),
      );
      await tx.write("index.md", INDEXED("concepts/pricing.md"));
    });
    expect(readRetiredLedger(vaultDir())).toEqual(["acme-sales/widgets/old-sizes"]);
    // Even after the page that recorded it is gone, the id stays retired.
    await vaultOperation("remove: pricing", (tx) => tx.remove("concepts/pricing.md"));
    await expect(
      vaultOperation("ingest: reuse", (tx) => tx.write("concepts/other.md", pageText({ claims: [claim("acme-sales/widgets/old-sizes")] }))),
    ).rejects.toBeInstanceOf(VaultLintBlockedError);
    // Recording it as active again does not bring it back.
    syncActiveClaims(vaultDir(), [{ id: "acme-sales/widgets/old-sizes", page: "concepts/x.md", updatedAt: "2026-02-01T00:00:00Z" }]);
    expect(readRetiredLedger(vaultDir())).toEqual(["acme-sales/widgets/old-sizes"]);
    const tables = withStateDb(vaultDir(), (db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name),
    );
    expect(tables).toEqual(expect.arrayContaining(["claim_registry", "costs", "ingest_jobs", "review_items", "runs"]));
  });

  it("reads pages, skipping bookkeeping, dot-folders and symlinks", async () => {
    await vaultOperation("ingest: two", async (tx) => {
      await tx.write("concepts/pricing.md", pageText());
      await tx.write("entities/acme-widgets.md", pageText({ type: "entity", title: "Acme Widgets Ltd" }));
    });
    const vault = vaultDir();
    fs.mkdirSync(path.join(vault, "reports"), { recursive: true });
    fs.writeFileSync(path.join(vault, "reports", "claim-health.md"), "# report");
    fs.mkdirSync(path.join(vault, ".openclaw-wiki"), { recursive: true });
    fs.writeFileSync(path.join(vault, ".openclaw-wiki", "x.md"), "x");
    fs.symlinkSync(path.join(vault, "concepts", "pricing.md"), path.join(vault, "concepts", "alias.md"));
    const snap = await readVaultSnapshot(vault);
    expect(snap.pages.map((p) => p.path)).toEqual(["concepts/pricing.md", "entities/acme-widgets.md"]);
    expect(snap.indexBody).toContain("# Index");
    expect((await readPage("concepts/pricing"))?.parsed.ok).toBe(true);
    expect(await readPage("concepts/alias.md")).toBeNull();
    expect(await readPage("../x")).toBeNull();
  });

  it("recognises its own repository when the vault is reached through a symlink", async () => {
    const real = path.join(base, `real-${n}`);
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, root);
    expect(await ensureVault()).toEqual({ created: true });
    expect(await vaultInitialised()).toBe(true);
    expect(await ensureVault()).toEqual({ created: false });
    expect(await commitCount(vaultDir())).toBe(1);
  });

  it("commits nothing, and does not throw, for a path that never existed", async () => {
    await ensureVault();
    const vault = vaultDir();
    const commits = await commitCount(vault);
    const gone = await vaultOperation("remove: missing", (tx) => tx.remove("concepts/missing.md"));
    expect(gone.commit).toBeNull();
    const transient = await vaultOperation("ingest: transient", async (tx) => {
      await tx.write("concepts/transient.md", pageText({ title: "Transient" }));
      await tx.remove("concepts/transient.md");
    });
    expect(transient.commit).toBeNull();
    expect(await commitCount(vault)).toBe(commits);
    // Beside a real change, the missing path is dropped and the change still commits.
    const mixed = await vaultOperation("ingest: mixed", async (tx) => {
      await tx.remove("concepts/missing.md");
      await tx.write("concepts/pricing.md", pageText());
    });
    expect(mixed.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(gitOut(vault, "show", "--name-only", "--format=", "HEAD")).toBe("concepts/pricing.md");
    expect(gitOut(vault, "status", "--porcelain")).toBe("");
  });

  it("lints every touched path: a secret in index.md is refused, a page past the walk's depth is refused", async () => {
    await ensureVault();
    const vault = vaultDir();
    const index = fs.readFileSync(path.join(vault, "index.md"), "utf8");
    const commits = await commitCount(vault);
    await expect(vaultOperation("index: leak", (tx) => tx.write("index.md", `${index}\npassword=Hunter22!\n`))).rejects.toBeInstanceOf(
      VaultLintBlockedError,
    );
    expect(fs.readFileSync(path.join(vault, "index.md"), "utf8")).toBe(index);
    expect(await commitCount(vault)).toBe(commits);

    const deepest = "a/b/c/d/e/f/g/h/page.md"; // nine segments: the walk still reaches it
    await vaultOperation("ingest: deep", async (tx) => {
      await tx.write(deepest, pageText({ title: "Deep" }));
      await tx.write("index.md", INDEXED(deepest));
    });
    expect((await readVaultSnapshot(vault)).pages.map((p) => p.path)).toContain(deepest);
    await expect(vaultOperation("x", (tx) => tx.write("a/b/c/d/e/f/g/h/i/page.md", pageText()))).rejects.toBeInstanceOf(VaultPathError);
  });

  it("answers history, file-at-ref and branch diffs", async () => {
    await vaultOperation("ingest: v1", (tx) => tx.write("concepts/pricing.md", pageText()));
    await vaultOperation("refactor: v2", (tx) => tx.write("concepts/pricing.md", pageText({ title: "Widget prices" })));
    const vault = vaultDir();
    expect((await logForPath(vault, "concepts/pricing.md")).map((c) => c.subject)).toEqual(["refactor: v2", "ingest: v1"]);
    expect(await showFileAt(vault, "HEAD~1", "concepts/pricing.md")).toContain("title: Widget pricing");
    expect(await showFileAt(vault, "HEAD", "nope.md")).toBeNull();
    await git(vault, ["checkout", "--quiet", "-b", "dream/2026-06-01"]);
    await vaultOperation("ingest: dream", (tx) => tx.write("concepts/dream.md", pageText({ title: "Dream" })));
    expect(await changedPaths(vault, "main", "dream/2026-06-01")).toEqual(["concepts/dream.md"]);
  });

  it("hands a commit's pages to the Memory Shard reindex, without waiting — and only when it committed", async () => {
    await vaultOperation("ingest: a", async (tx) => {
      await tx.write("concepts/pricing.md", pageText());
      await tx.write("index.md", INDEXED("concepts/pricing.md"));
    });
    await vi.waitFor(() => expect(shard.scheduleReindexAfterCommit).toHaveBeenCalledTimes(1));
    expect(shard.scheduleReindexAfterCommit).toHaveBeenCalledWith(vaultDir(), ["concepts/pricing.md", "index.md"]);

    // Nothing changed: no commit, nothing to reindex.
    await vaultOperation("ingest: same", async (tx) => {
      await tx.write("concepts/pricing.md", pageText());
    });
    // A caller that reindexes itself switches it off.
    await vaultOperation("ingest: b", async (tx) => {
      await tx.write("concepts/other.md", pageText({ title: "Other" }));
    }, { reindex: false, lint: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(shard.scheduleReindexAfterCommit).toHaveBeenCalledTimes(1);
  });
});
