/**
 * The core block follows a REAL nightly pass: with the `context` setting on,
 * the night's merge into `main` (here: the summaries pass writing the pages'
 * first summaries, offline, from their facts) rebuilds the block by itself —
 * nothing calls a refresh — so the next prompt build reads the new block.
 * With the setting off a night leaves no block behind.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHashEmbedder } from "@/lib/prime-radiant/contradictions";
import { readCoreContextFile } from "@/lib/prime-radiant/core-context-file";
import { runNightly, type NightlySummary } from "@/lib/prime-radiant/nightly";
import { coreContextPath, vaultDir } from "@/lib/prime-radiant/paths";
import { setVaultReindexHook } from "@/lib/prime-radiant/reindex-hook";
import { defaultSettings, readSettingsPatch, writeSettings } from "@/lib/prime-radiant/settings";
import { ensureVault, readVaultSnapshot, vaultOperation } from "@/lib/prime-radiant/vault";
import { claim, pageText } from "../helpers/prime-radiant-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-core-nightly-"));
const prev = process.env.PRIME_RADIANT_DIR;
let n = 0;

const settings = () => {
  const s = defaultSettings();
  return { ...s, ingest: { ...s.ingest, folders: [] } };
};
const deps = () => ({ embedder: createHashEmbedder(), online: async () => false, now: () => new Date(2026, 4, 20, 3, 0), settings: settings() });

/** Three stable, linked pages with facts and no summary yet: tonight's summaries pass writes theirs. */
async function seed() {
  await ensureVault();
  await vaultOperation("seed", async (tx) => {
    const page = (title: string, id: string, fact: string, links: string[]) =>
      pageText({ type: "entity", title, status: "stable", claims: [claim(`acme-sales/${id}/fact`, fact)] }, `${title}.\n\n${links.map((l) => `See [[entities/${l}]].`).join("\n")}\n`);
    await tx.write("entities/acme-widgets.md", page("Acme Widgets", "acme-widgets", "Acme Widgets Ltd makes blue widgets in Plovdiv.", ["globex", "initech"]));
    await tx.write("entities/globex.md", page("Globex", "globex", "Globex buys blue widgets from Acme Widgets Ltd every month.", ["acme-widgets"]));
    await tx.write("entities/initech.md", page("Initech", "initech", "Initech resells Acme Widgets Ltd products in Sofia.", ["acme-widgets"]));
  });
}

async function summaries(): Promise<Map<string, string>> {
  const snap = await readVaultSnapshot(vaultDir());
  const out = new Map<string, string>();
  for (const p of snap.pages) {
    if (p.parsed.ok && typeof p.parsed.frontmatter.summary === "string") out.set(p.parsed.frontmatter.title, p.parsed.frontmatter.summary);
  }
  return out;
}

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  setVaultReindexHook(async () => undefined);
});

afterAll(() => {
  setVaultReindexHook(null);
  if (prev === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prev;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the core block after a nightly merge", () => {
  it("is rebuilt from the merged main by the night itself", async () => {
    await seed();
    writeSettings(readSettingsPatch({ context: { enabled: true } }));
    // Before the night: no page has a summary, so each line is its title alone.
    const { scheduleCoreContextRefresh } = await import("@/lib/prime-radiant/core-context-file");
    await scheduleCoreContextRefresh();
    const before = readCoreContextFile()!;
    expect(before.text).toContain("\n- Acme Widgets\n");
    expect(await summaries()).toEqual(new Map());

    const run = await runNightly("manual", deps());
    expect(run?.status).toBe("merged");
    const night = run!.summary as unknown as NightlySummary;
    // The night's structure pass adds a domain hub and a root page, which it summarises too; neither is ever in the block.
    expect((night.summaries as { written?: number }).written).toBeGreaterThanOrEqual(3);
    const all = await summaries();
    const written = new Map([...all].filter(([title]) => ["Acme Widgets", "Globex", "Initech"].includes(title)));
    expect(written.size).toBe(3);

    // Nothing here asks for a refresh: the merge's notifyVaultChanged does.
    await vi.waitFor(() => expect(readCoreContextFile()?.revision).toBe(night.mergeCommit), { timeout: 20_000 });
    const after = readCoreContextFile()!;
    expect(after.pages).toBe(3);
    for (const [title, summary] of written) {
      expect(after.text).toContain(`\n- ${title} — ${summary.replace(/\s+/g, " ").trim().slice(0, 60)}`);
    }
    expect(after.text).not.toContain("\n- Acme Widgets\n");
  });

  it("leaves no block behind with the setting off", async () => {
    await seed();
    const run = await runNightly("manual", deps());
    expect(run?.status).toBe("merged");
    // Give a refresh that should not happen the time it would need.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.existsSync(coreContextPath())).toBe(false);
  });
});
