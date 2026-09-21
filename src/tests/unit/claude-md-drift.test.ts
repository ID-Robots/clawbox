import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md is the map every agent reads before it touches this repository, so
 * a promise it makes that the code does not keep costs an hour of somebody's
 * search. Two such promises survived a removal each:
 *
 *  - a VS Code app (`VSCodeApp.tsx`, a `code-server/` route) that no longer
 *    exists — `/app/vscode` answers "App not found" and the launcher has no
 *    entry — and a `DoneStep.tsx` the setup wizard replaced with an inline
 *    completion overlay;
 *  - "ClawKeep keeps a one-line pointer card" to Memory Shard, which
 *    `ClawKeepApp.tsx` has never had: it names memory nowhere.
 *
 * These cases hold the document to the tree rather than to its own memory.
 */

const REPO = process.cwd();
const DOC = fs.readFileSync(path.join(REPO, "CLAUDE.md"), "utf-8");

/** Every source file under the trees CLAUDE.md describes, by name and by repo-relative path. */
function indexSources(): { byName: Map<string, string[]>; paths: Set<string> } {
  const byName = new Map<string, string[]>();
  const paths = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(REPO, full);
      paths.add(rel);
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), rel]);
    }
  };
  for (const top of ["src", "mcp", "scripts", "config"]) walk(path.join(REPO, top));
  return { byName, paths };
}

const SOURCES = indexSources();

describe("the files CLAUDE.md points at", () => {
  it("all exist", () => {
    // The bolded backtick references — `**`Something.tsx`**` — are the
    // document's own index of components and modules.
    const named = [...DOC.matchAll(/\*\*`([A-Za-z0-9._/-]+\.tsx?)`\*\*/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(20);
    const missing = named.filter((ref) =>
      ref.includes("/") ? !SOURCES.paths.has(ref) : !SOURCES.byName.has(ref),
    );
    expect(missing).toEqual([]);
  });

  it("does not promise a VS Code app this build does not have", () => {
    const hasApp = fs.existsSync(path.join(REPO, "src/components/VSCodeApp.tsx"));
    const hasRoute = fs.existsSync(path.join(REPO, "src/app/setup-api/code-server"));
    expect(hasApp).toBe(false);
    expect(hasRoute).toBe(false);
    // The route families list is where `code-server/` was still offered.
    expect(DOC).not.toMatch(/^- \*\*Other\*\*:.*`code-server\/`/m);
    // And the document has to say so, so the promise is not simply re-added.
    expect(DOC).toContain("There is NO VS Code app on this build");
  });
});

describe("the ClawKeep → Memory Shard pointer", () => {
  it("is described the way ClawKeepApp.tsx actually behaves", () => {
    const app = fs.readFileSync(path.join(REPO, "src/components/ClawKeepApp.tsx"), "utf-8");
    const links = /memory-shard|memoryShard|clawkeep\.memory\./.test(app);
    const claimed = /ClawKeep keeps a one-line pointer card/.test(DOC);
    // Whichever way round it is fixed, the two must agree: a card in the app
    // and a sentence in the document, or neither.
    expect(claimed).toBe(links);
  });
});
