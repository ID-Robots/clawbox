/**
 * The quick road a metadata edit takes (edit.ts `editPage`, vault.ts
 * `lint: "pages"`): the page is read alone and linted alone, and nothing is
 * re-embedded — with every answer the slow road gave. Its findings are the
 * ones a lint of the whole vault gives (an orphan included), a verified page
 * is still refused, a blocking rule still refuses the commit, each edit is
 * one commit naming its author. And an operation that reads the vault before
 * it writes is linted against that read, not a second one.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const shard = vi.hoisted(() => ({ scheduleReindexAfterCommit: vi.fn() }));
vi.mock("@/lib/prime-radiant/shard-index", () => shard);

import { editPage, PageEditError } from "@/lib/prime-radiant/edit";
import { ASSISTANT_AUTHOR } from "@/lib/prime-radiant/git";
import { lintVault } from "@/lib/prime-radiant/lint";
import { ensureVault, readListedPage, readPage, readVaultSnapshot, VaultLintBlockedError, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-fast-path-"));
let n = 0;
let vault = "";

const ASSISTANT = { by: "assistant", author: ASSISTANT_AUTHOR, person: false };
const OWNER = { by: "owner", person: true };
const OTHERS = 30;
const TAKEN = claim("acme-sales/pricing/blue-widget", "The blue widget costs 10 EUR.");

const log = (limit = 1) =>
  execFileSync("git", ["-C", vault, "log", `-${limit}`, "--format=%an|%s"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" })
    .trim()
    .split("\n");
const read = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");

/**
 * `indexed.md` is listed in index.md, `linked.md` only linked from it,
 * `orphan.md` neither; `verified.md` a person verified; thirty more pages
 * make the vault worth not reading.
 */
async function seed() {
  await vaultOperation(
    "seed: pages",
    async (tx) => {
      await tx.write("concepts/indexed.md", pageText({ title: "Indexed", claims: [TAKEN] }, "Indexed page.\n\nSee [[concepts/linked]].\n"));
      await tx.write("concepts/linked.md", pageText({ title: "Linked" }, "Linked from the indexed page.\n"));
      await tx.write("concepts/orphan.md", pageText({ title: "Orphan", stale_after: "2026-01-01" }, "Nobody links here.\n"));
      await tx.write("concepts/verified.md", pageText({ title: "Verified", verified: { at: "2026-02-01T00:00:00.000Z", by: "owner" } }, "Verified page.\n"));
      for (let i = 0; i < OTHERS; i++) await tx.write(`entities/other-${i}.md`, pageText({ title: `Other ${i}` }, `Other page ${i}.\n`));
      await tx.write("index.md", `# Index\n\n- [[concepts/indexed]]\n- [[concepts/verified]]\n${Array.from({ length: OTHERS }, (_, i) => `- [[entities/other-${i}]]`).join("\n")}\n`);
    },
    { vault },
  );
}

/** The findings a lint of the whole vault gives `rel`, in the routes' shape. */
async function wholeVaultFindings(rel: string) {
  const report = lintVault(await readVaultSnapshot(vault), { scope: [rel], now: new Date("2026-10-01T00:00:00Z") });
  return report.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path, message: f.message }));
}

/** How many page files `fn` opened. */
async function opensDuring<T>(fn: () => Promise<T>): Promise<{ opens: number; value: T }> {
  const open = vi.spyOn(fsp, "open");
  try {
    const value = await fn();
    return { opens: open.mock.calls.filter(([p]) => String(p).endsWith(".md")).length, value };
  } finally {
    open.mockRestore();
  }
}

beforeEach(async () => {
  vault = path.join(base, `case-${++n}`, "vault");
  await ensureVault(vault);
  await seed();
  // The seed's own reindex is scheduled in the background: let it arrive first.
  await vi.waitFor(() => expect(shard.scheduleReindexAfterCommit).toHaveBeenCalled());
  shard.scheduleReindexAfterCommit.mockReset();
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("a metadata edit", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  it("reads its page alone and answers the findings a whole-vault lint gives", async () => {
    const { opens, value } = await opensDuring(() => editPage("concepts/indexed.md", { domain: "billing", owner: "finance-team" }, ASSISTANT, { vault, now }));
    expect(value.changed.sort()).toEqual(["domain", "owner"]);
    expect(value.commit).toMatch(/^[0-9a-f]{40}$/);
    // The old road read all 34 pages twice.
    expect(opens).toBeLessThanOrEqual(3);
    expect(value.findings).toEqual(await wholeVaultFindings("concepts/indexed.md"));
    expect(read("concepts/indexed.md")).toContain("domain: billing\nowner: finance-team\n");
    expect(read("concepts/indexed.md")).toContain(TAKEN.id);
  });

  it("asks the whole vault whether a page index.md does not list is an orphan, and says what it says", async () => {
    const linked = await editPage("concepts/linked.md", { privacy: "confidential" }, ASSISTANT, { vault, now });
    expect(linked.findings).toEqual(await wholeVaultFindings("concepts/linked.md"));
    expect(linked.findings.map((f) => f.rule)).not.toContain("orphan");

    const orphan = await editPage("concepts/orphan.md", { status: "stable", sources: ["sources/price-list.md"] }, ASSISTANT, { vault, now });
    expect(orphan.findings).toEqual(await wholeVaultFindings("concepts/orphan.md"));
    expect(orphan.findings.map((f) => f.rule).sort()).toEqual(["orphan", "stale-after-passed"]);
  });

  it("is one commit naming its author, re-embeds nothing, and commits nothing when nothing differs", async () => {
    await editPage("concepts/indexed.md", { domain: "billing" }, ASSISTANT, { vault, now });
    await editPage("concepts/linked.md", { owner: "finance-team" }, OWNER, { vault, now });
    expect(log(2)).toEqual(["Prime Radiant|edit: concepts/linked.md", "ClawBox assistant|edit: concepts/indexed.md"]);
    const head = log()[0];
    const same = await editPage("concepts/linked.md", { owner: "finance-team" }, OWNER, { vault, now });
    expect(same).toMatchObject({ commit: null, changed: [] });
    expect(log()[0]).toBe(head);
    await new Promise((r) => setTimeout(r, 50));
    expect(shard.scheduleReindexAfterCommit).not.toHaveBeenCalled();
  });

  it("still refuses a verified page to the assistant, and a missing one", async () => {
    const before = read("concepts/verified.md");
    await expect(editPage("concepts/verified.md", { domain: "billing" }, ASSISTANT, { vault, now })).rejects.toMatchObject({ code: "verified", status: 409 });
    expect(read("concepts/verified.md")).toBe(before);
    await expect(editPage("concepts/nope.md", { domain: "billing" }, ASSISTANT, { vault, now })).rejects.toBeInstanceOf(PageEditError);
    const owner = await editPage("concepts/verified.md", { domain: "billing" }, OWNER, { vault, now });
    expect(owner.changed).toEqual(["domain"]);
  });

  it("is still refused by a blocking rule, and puts the page back", async () => {
    const before = read("concepts/indexed.md");
    const head = log()[0];
    const secret = "ghp" + "_" + "Ab3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5";
    const err = await editPage("concepts/indexed.md", { owner: secret }, ASSISTANT, { vault, now }).catch((e) => e);
    expect(err).toBeInstanceOf(VaultLintBlockedError);
    expect((err as VaultLintBlockedError).findings.map((f) => f.rule)).toEqual(["secret-pattern"]);
    expect(read("concepts/indexed.md")).toBe(before);
    expect(log()[0]).toBe(head);
  });
});

describe("an edit of what Memory Shard embeds", () => {
  it("still lints against the whole vault and is re-embedded", async () => {
    const res = await editPage("concepts/linked.md", { title: "Linked page", privacy: "confidential" }, ASSISTANT, { vault, now: new Date("2026-10-01T00:00:00Z") });
    expect(res.changed.sort()).toEqual(["privacy", "title"]);
    expect(res.findings).toEqual(await wholeVaultFindings("concepts/linked.md"));
    await vi.waitFor(() => expect(shard.scheduleReindexAfterCommit).toHaveBeenCalledWith(vault, ["concepts/linked.md"]));
  });
});

describe("an operation that read the vault before it wrote", () => {
  it("is linted against that read and what it wrote: a claim id another page holds is refused", async () => {
    const head = log()[0];
    const { opens, value } = await opensDuring(() =>
      vaultOperation(
        "test: duplicate claim",
        async (tx) => {
          const snapshot = await tx.snapshot();
          expect(await tx.snapshot()).toBe(snapshot);
          await tx.write("concepts/copy.md", pageText({ title: "Copy", claims: [TAKEN] }, "A copy.\n\nSee [[concepts/indexed]].\n"));
        },
        { vault },
      ).catch((e) => e),
    );
    expect(value).toBeInstanceOf(VaultLintBlockedError);
    expect((value as VaultLintBlockedError).findings.map((f) => [f.rule, f.path])).toEqual([["claim-id-collision", "concepts/copy.md"]]);
    expect(fs.existsSync(path.join(vault, "concepts/copy.md"))).toBe(false);
    expect(log()[0]).toBe(head);
    // One read of the vault (34 pages) and the page it wrote, not two reads.
    expect(opens).toBeLessThanOrEqual(34 + 1);
  });
});

describe("a page read alone", () => {
  it("is one the snapshot walk lists: a page reached through a symlinked folder is no page to edit", async () => {
    fs.symlinkSync(path.join(vault, "concepts"), path.join(vault, "shortcut"), "dir");
    expect(await readPage("shortcut/indexed.md", vault)).not.toBeNull();
    expect(await readListedPage("shortcut/indexed.md", vault)).toBeNull();
    expect((await readVaultSnapshot(vault)).pages.some((p) => p.path.startsWith("shortcut/"))).toBe(false);
    const head = log()[0];
    await expect(editPage("shortcut/indexed.md", { domain: "billing" }, ASSISTANT, { vault })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(log()[0]).toBe(head);
    expect(await readListedPage("concepts/indexed.md", vault)).not.toBeNull();
  });
});
