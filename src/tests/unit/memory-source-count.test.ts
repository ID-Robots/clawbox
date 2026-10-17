/**
 * What adding a Memory Shard folder would read (`countSourceFiles`), and the
 * picker's hidden-folder rule for a folder named by path
 * (`isHiddenInsideBrowseRoot`). Synthetic trees under a temp Files root.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countSourceFiles } from "@/lib/memory-extract";
import { isHiddenInsideBrowseRoot } from "@/lib/browse-folder";

let root = "";
const savedRoot = process.env.FILES_ROOT;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-source-count-")));
  process.env.FILES_ROOT = root;
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.FILES_ROOT;
  else process.env.FILES_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("countSourceFiles", () => {
  it("counts the documents past the per-folder conversion cap as left out", async () => {
    const dir = path.join(root, "Globex archive");
    fs.mkdirSync(dir);
    for (let i = 0; i < 503; i += 1) fs.writeFileSync(path.join(dir, `memo-${i}.pdf`), "");
    fs.writeFileSync(path.join(dir, "index.md"), "# synthetic\n");
    expect(await countSourceFiles(dir)).toEqual({ files: 501, markdown: 1, documents: 503, documentsOverCap: 3, complete: true });
  });

  it("says a folder it could not open is a floor, not an empty folder", async () => {
    const counted = await countSourceFiles(path.join(root, "no-such-folder"));
    expect(counted).toMatchObject({ files: 0, complete: false });
  });
});

describe("isHiddenInsideBrowseRoot", () => {
  it("lets the Files root and its ordinary folders through", async () => {
    expect(await isHiddenInsideBrowseRoot(root)).toBe(false);
    expect(await isHiddenInsideBrowseRoot(path.join(root, "Acme notes", "2026"))).toBe(false);
  });

  it("refuses a dot-named folder at any depth, but not a dot inside a name", async () => {
    expect(await isHiddenInsideBrowseRoot(path.join(root, ".local"))).toBe(true);
    expect(await isHiddenInsideBrowseRoot(path.join(root, "Acme notes", ".trash", "old"))).toBe(true);
    expect(await isHiddenInsideBrowseRoot(path.join(root, "v1.2 notes"))).toBe(false);
  });
});
