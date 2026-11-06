/**
 * A batch whose commit lint refuses because of ONE page: that page's file
 * fails alone, the rest of the batch is committed, and index.md is rebuilt
 * without the dropped page (no secret copied into it).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The writer scrubs secrets from what the model says, so the offending page is
// made after the fact: the "bad" document's page gets a key in its title.
const KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
vi.mock("@/lib/prime-radiant/writer", async (orig) => {
  const real = await orig<typeof import("@/lib/prime-radiant/writer")>();
  return {
    ...real,
    buildPage: (...args: Parameters<typeof real.buildPage>) => {
      const built = real.buildPage(...args);
      if (built.ok && args[1].includes("bad")) built.frontmatter = { ...built.frontmatter, title: `Acme bad ${KEY}` };
      return built;
    },
  };
});

import { type FlashClient } from "@/lib/prime-radiant/flash-client";
import { getIngestJob, ingestFinished, lintCulprits, startIngest } from "@/lib/prime-radiant/ingest";
import { readFiles } from "@/lib/prime-radiant/ingest-store";
import { readVaultSnapshot } from "@/lib/prime-radiant/vault";
import { readWriterItems, type WriterItem } from "@/lib/prime-radiant/writer";
import type { LintFinding } from "@/lib/prime-radiant/lint";

vi.setConfig({ testTimeout: 60_000 });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-isolate-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
afterAll(() => {
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function card(item: WriterItem) {
  const name = path.basename(item.path).replace(/\.\w+$/, "");
  return {
    i: item.i,
    useful: true,
    type: "concept",
    title: `Acme ${name}`,
    domain: "sales",
    summary: `Notes about Acme ${name}.`,
    details: "",
    facts: [{ fact: `Acme ${name} is a synthetic document.`, quote: "synthetic", confidence: 0.7 }],
    sensitivity: "internal",
    confidence: 0.7,
  };
}

const client: FlashClient = {
  model: "deepseek-v4-flash",
  async complete(request) {
    const items = readWriterItems(request.user) ?? [];
    return { text: JSON.stringify(items.map(card)), model: "deepseek-v4-flash", usage: { promptTokens: 10, completionTokens: 10, cacheHitTokens: 0 } };
  },
};

describe("a batch lint refuses for one page", () => {
  it("fails only that page's document, commits the rest, and keeps it out of index.md", async () => {
    const docs = path.join(root, "docs");
    fs.mkdirSync(docs, { recursive: true });
    for (const n of ["good1", "bad", "good2"]) fs.writeFileSync(path.join(docs, `${n}.md`), `Doc ${n}.`);
    process.env.PRIME_RADIANT_DIR = path.join(root, "prime-radiant");
    const vault = path.join(process.env.PRIME_RADIANT_DIR, "vault");

    const started = await startIngest({ kind: "folders", folders: [docs] }, { vault, client, retry: { sleep: async () => undefined } });
    await ingestFinished(started.id);
    const job = getIngestJob(started.id, vault)!;
    expect(job).toMatchObject({ done: 2, failed: 1, pages: 2, commits: 1 });

    const snap = await readVaultSnapshot(vault);
    expect(snap.pages.map((p) => p.path).sort()).toEqual(["concepts/acme-good1.md", "concepts/acme-good2.md"]);
    expect(snap.indexBody).not.toContain(KEY);
    expect(snap.indexBody).not.toContain("acme-bad");
    const failed = readFiles(vault, job.id).filter((f) => f.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/refused by lint: secret-pattern/);
  });
});

describe("lintCulprits", () => {
  const f = (rule: string, p: string) => ({ rule, path: p, severity: "error", blocksCommit: true, message: "" }) as unknown as LintFinding;
  const pageOf = new Map([
    ["concepts/a.md", 0],
    ["concepts/b.md", 1],
  ]);
  const titleOf = new Map([
    [0, "A"],
    [1, `B ${KEY}`],
  ]);

  it("blames the file whose page a finding names, and the file whose title put a secret in index.md", () => {
    const out = lintCulprits([f("claim-id-collision", "concepts/a.md"), f("secret-pattern", "index.md")], pageOf, titleOf);
    expect([...out.keys()].sort()).toEqual([0, 1]);
    expect(out.get(0)).toMatch(/claim-id-collision/);
    expect(out.get(1)).toMatch(/secret-pattern/);
  });

  it("blames nobody for a page this batch did not write", () => {
    expect(lintCulprits([f("claim-id-collision", "concepts/other.md")], pageOf, titleOf).size).toBe(0);
  });
});
