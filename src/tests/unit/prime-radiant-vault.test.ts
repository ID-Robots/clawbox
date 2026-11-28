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
import fsp from "fs/promises";
import {
  ensureVault,
  heldPageBytes,
  readPage,
  readVaultSnapshot,
  releaseHeldPages,
  vaultInitialised,
  vaultOperation,
  VaultLintBlockedError,
  VaultPathError,
} from "@/lib/prime-radiant/vault";
import { changedPaths, commitCount, currentBranch, git, headCommit, logForPath, showFileAt } from "@/lib/prime-radiant/git";
import { safePagePath, stateDbPath, vaultDir } from "@/lib/prime-radiant/paths";
import { readRetiredLedger, syncActiveClaims, withStateDb } from "@/lib/prime-radiant/state-db";
import { readSettings, writeSettings } from "@/lib/prime-radiant/settings";
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
    // index.md lists it, but no other page links it: still an orphan.
    expect(result.findings.map((f) => f.rule)).toEqual(["orphan"]);
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

describe("pages kept in memory (settings inMemory)", () => {
  const A = "concepts/widget-pricing.md";
  const B = "concepts/widget-colours.md";
  const off = { pages: false, pageBodies: false, searchVectors: false };

  async function seedPages(): Promise<string> {
    await vaultOperation(
      "ingest: test",
      async (tx) => {
        await tx.write(A, pageText({ title: "Widget pricing" }));
        await tx.write(B, pageText({ title: "Widget colours", claims: [claim("acme-sales/widgets/colour")] }));
      },
      { lint: false, reindex: false },
    );
    return vaultDir();
  }
  const pageOf = async (rel: string) => (await readVaultSnapshot()).pages.find((p) => p.path === rel) ?? null;
  const fmOf = async (rel: string) => {
    const page = await pageOf(rel);
    return page?.parsed.ok ? page.parsed.frontmatter : null;
  };
  /** Opens of `rel`'s file: a page answered from memory is never opened. */
  const opensOf = (spy: { mock: { calls: unknown[][] } }, rel: string) => spy.mock.calls.filter((c) => String(c[0]).endsWith(rel)).length;
  /** The clock past the racy window, so a page written just now counts as settled. */
  const settle = () => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10_000 });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    releaseHeldPages(off);
  });

  it("is off by default: nothing is kept, every read parses again, and the answer is the same with it on", async () => {
    await seedPages();
    expect(readSettings().inMemory).toEqual(off);
    const first = await readVaultSnapshot();
    const again = await readVaultSnapshot();
    const fm = first.pages.find((p) => p.path === A)!.parsed;
    expect(fm.ok && Object.isFrozen(fm.frontmatter)).toBe(false);
    expect(again.pages.find((p) => p.path === A)!.parsed).not.toBe(fm);
    expect(heldPageBytes()).toEqual({ pages: 0, pageBodies: 0 });
    writeSettings({ inMemory: { pages: true, pageBodies: true } });
    settle();
    await readVaultSnapshot();
    // Same pages, same fields, same key order — from memory as from disk.
    expect(JSON.stringify((await readVaultSnapshot()).pages)).toBe(JSON.stringify(first.pages));
    expect(JSON.stringify(await readPage(B))).toBe(JSON.stringify(first.pages.find((p) => p.path === B)));
  });

  it("pages: an unchanged page is answered from memory, frozen all the way down", async () => {
    await seedPages();
    writeSettings({ inMemory: { pages: true } });
    const fm = (await fmOf(B))!;
    expect(await fmOf(B)).toBe(fm);
    expect(((await readPage(B))!.parsed as { frontmatter: unknown }).frontmatter).toBe(fm);
    expect(heldPageBytes().pages).toBeGreaterThan(0);
    expect(heldPageBytes().pageBodies).toBe(0);
    // A caller cannot change what the next read answers.
    expect(Object.isFrozen(fm) && Object.isFrozen(fm.claims) && Object.isFrozen(fm.claims[0]) && Object.isFrozen(fm.generated)).toBe(true);
    expect(() => {
      (fm as { title: string }).title = "Changed";
    }).toThrow(TypeError);
    expect(() => fm.claims.push(claim("acme-sales/widgets/size"))).toThrow(TypeError);
    expect(() => {
      (fm.claims[0] as { text: string }).text = "Changed";
    }).toThrow(TypeError);
    expect((await fmOf(B))!.title).toBe("Widget colours");
    expect((await fmOf(B))!.claims).toHaveLength(1);
  });

  for (const bodies of [false, true]) {
    it(`${bodies ? "pages + pageBodies" : "pages"}: a change is seen on the next read — Prime Radiant, the disk, git, a page added or deleted`, async () => {
      const vault = await seedPages();
      writeSettings({ inMemory: { pages: true, pageBodies: bodies } });
      if (bodies) settle();
      expect((await fmOf(A))!.title).toBe("Widget pricing");
      // Through Prime Radiant's own write.
      await vaultOperation("edit: a", (tx) => tx.write(A, pageText({ title: "Widget prices" })), { lint: false, reindex: false });
      expect((await fmOf(A))!.title).toBe("Widget prices");
      // On disk, by an editor, the same size and the same times as before.
      const abs = path.join(vault, ...A.split("/"));
      const st = fs.statSync(abs);
      fs.writeFileSync(abs, pageText({ title: "Widget PRICES" }));
      fs.utimesSync(abs, st.atime, st.mtime);
      expect(fs.statSync(abs).size).toBe(st.size);
      expect((await fmOf(A))!.title).toBe("Widget PRICES");
      // By git: the committed text back.
      gitOut(vault, "checkout", "--quiet", "HEAD", "--", A);
      expect((await fmOf(A))!.title).toBe("Widget prices");
      // The body too, the frontmatter unchanged.
      fs.writeFileSync(abs, pageText({ title: "Widget prices" }, "A new body, written on disk.\n"));
      expect((await pageOf(A))!.parsed.body).toContain("A new body, written on disk.");
      // Added and deleted.
      fs.writeFileSync(path.join(vault, "concepts", "widget-sizes.md"), pageText({ title: "Widget sizes" }));
      expect((await fmOf("concepts/widget-sizes.md"))!.title).toBe("Widget sizes");
      const held = heldPageBytes().pages;
      fs.rmSync(abs);
      expect(await pageOf(A)).toBeNull();
      expect(await readPage(A)).toBeNull();
      expect(heldPageBytes().pages).toBeLessThan(held);
    });
  }

  it("pageBodies: a settled file is not read again until its size, times or inode move", async () => {
    const vault = await seedPages();
    writeSettings({ inMemory: { pageBodies: true } });
    settle();
    const open = vi.spyOn(fsp, "open");
    const text = (await pageOf(A))!.text;
    expect(opensOf(open, A)).toBe(1);
    expect((await pageOf(A))!.text).toBe(text);
    expect((await readPage(A))!.text).toBe(text);
    expect(opensOf(open, A)).toBe(1);
    expect(heldPageBytes().pageBodies).toBeGreaterThan(0);
    expect(heldPageBytes().pages).toBe(0);
    // Replaced whole, same size and same times: another inode.
    const abs = path.join(vault, ...A.split("/"));
    const st = fs.statSync(abs);
    const replaced = pageText({ title: "Widget PRICING" });
    fs.writeFileSync(`${abs}.new`, replaced);
    fs.utimesSync(`${abs}.new`, st.atime, st.mtime);
    fs.renameSync(`${abs}.new`, abs);
    expect((await pageOf(A))!.text).toBe(replaced);
    expect(opensOf(open, A)).toBe(2);
    // A symlink in its place is no page, as before.
    fs.rmSync(abs);
    fs.symlinkSync(path.join(vault, ...B.split("/")), abs);
    expect(await readPage(A)).toBeNull();
  });

  it("pageBodies: a file changed in the last two seconds is read again every time", async () => {
    await seedPages();
    writeSettings({ inMemory: { pageBodies: true } });
    const open = vi.spyOn(fsp, "open");
    await pageOf(A);
    await pageOf(A);
    expect(opensOf(open, A)).toBe(2);
    expect(heldPageBytes().pageBodies).toBe(0);
  });

  it("frees what a switch held once it is off: at once from the settings route, and on the next read", async () => {
    await seedPages();
    writeSettings({ inMemory: { pages: true, pageBodies: true } });
    settle();
    await readVaultSnapshot();
    expect(heldPageBytes().pages).toBeGreaterThan(0);
    expect(heldPageBytes().pageBodies).toBeGreaterThan(0);
    releaseHeldPages(writeSettings({ inMemory: { pageBodies: false } }).inMemory);
    expect(heldPageBytes().pageBodies).toBe(0);
    expect(heldPageBytes().pages).toBeGreaterThan(0);
    // Switched off by hand in settings.json: the next read frees it.
    writeSettings({ inMemory: null });
    await readPage(A);
    expect(heldPageBytes()).toEqual({ pages: 0, pageBodies: 0 });
    const fm = await fmOf(A);
    expect(fm && Object.isFrozen(fm)).toBe(false);
  });

  it("keeps only the box's own vault: a vault read from elsewhere (a nightly worktree) is parsed every time", async () => {
    await seedPages();
    writeSettings({ inMemory: { pages: true } });
    const other = path.join(root, "worktree");
    fs.cpSync(vaultDir(), other, { recursive: true });
    const fm = (await readVaultSnapshot(other)).pages.find((p) => p.path === A)!.parsed;
    expect((await readVaultSnapshot(other)).pages.find((p) => p.path === A)!.parsed).not.toBe(fm);
    expect(fm.ok && Object.isFrozen(fm.frontmatter)).toBe(false);
    expect(heldPageBytes().pages).toBe(0);
  });
});
