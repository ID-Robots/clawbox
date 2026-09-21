import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * src/lib/memory-extract.ts — the owner's documents turned into Markdown the
 * memory index can read.
 *
 * Two regressions this file guards, both found on a real folder:
 *
 *   - `a/b.txt` and `a__b.txt` flattened to the SAME derived name, so the
 *     second document was skipped as "already current" and silently missing
 *     from the index. The derived name now carries a digest of the untouched
 *     relative path.
 *   - the walk read every entry of a node_modules before MAX_FILES could say
 *     stop, because that count bounds documents, not the looking. The walk now
 *     has its own entry budget and says so in the notes when it ran out.
 *
 * DATA_DIR is read at import time, so config-store is mocked to a temp root
 * before the module loads; the extractors are mocked at the wrapper (runChild)
 * so no pdftotext or libreoffice is ever spawned — .txt is the one extractable
 * kind that needs neither, which is what every test here uses.
 */

const { dataDir, runChild, opendirOverride } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");
  return {
    dataDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "memory-extract-data-")),
    runChild: vi.fn(),
    /** When set, what the walk's opendir answers instead of the real listing. */
    opendirOverride: { fn: null as null | ((dir: string) => unknown) },
  };
});

vi.mock("@/lib/config-store", () => ({ DATA_DIR: dataDir }));
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return { ...actual, runChild };
});
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  // An override answering undefined for a directory leaves it to the real
  // opendir, so one test can lock a single folder and keep the rest real.
  const opendir = ((dir: string, options?: unknown) => {
    const answer = opendirOverride.fn?.(dir);
    return answer === undefined ? actual.opendir(dir, options as never) : answer;
  }) as typeof actual.opendir;
  return { ...actual, opendir, default: { ...actual, opendir } };
});

import { EXTRACT_ROOT, derivedFolderFor, extractDocuments } from "@/lib/memory-extract";

let source: string;

beforeEach(() => {
  runChild.mockReset();
  opendirOverride.fn = null;
  source = fs.mkdtempSync(path.join(os.tmpdir(), "memory-extract-src-"));
});

afterEach(() => {
  opendirOverride.fn = null;
  fs.rmSync(source, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("derived file names", () => {
  it("keeps a/b.txt and a__b.txt apart instead of letting the second hide behind the first", async () => {
    fs.mkdirSync(path.join(source, "a"));
    fs.writeFileSync(path.join(source, "a", "b.txt"), "nested\n");
    fs.writeFileSync(path.join(source, "a__b.txt"), "flat\n");

    const result = await extractDocuments(source);

    expect(result.derived).toBe(derivedFolderFor(source));
    expect(result.extracted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.notes).toEqual([]);

    const derived = fs.readdirSync(result.derived!).sort();
    expect(derived).toHaveLength(2);
    // Both flatten to `a__b.txt`; only the digest of the real relative path
    // tells them apart, and it is the suffix of every derived name.
    for (const name of derived) expect(name).toMatch(/^a__b\.txt-[0-9a-f]{12}\.md$/);
    const contents = derived.map((name) => fs.readFileSync(path.join(result.derived!, name), "utf8")).sort();
    expect(contents).toEqual(["flat\n", "nested\n"]);

    // Nothing here needed an extractor: .txt is copied as-is.
    expect(runChild).not.toHaveBeenCalled();
    expect(result.derived!.startsWith(EXTRACT_ROOT)).toBe(true);
  });

  it("re-running leaves a current extraction alone", async () => {
    fs.writeFileSync(path.join(source, "note.txt"), "once\n");
    const first = await extractDocuments(source);
    expect(first.extracted).toBe(1);
    const second = await extractDocuments(source);
    // Same derived folder, and the copy already there is newer than the source.
    expect(second.derived).toBe(first.derived);
    expect(second.extracted).toBe(0);
    expect(second.skipped).toBe(0);
  });
});

describe("the walk's entry budget", () => {
  it("stops after 20000 directory entries and says so first in the notes", async () => {
    // One over the budget, and none of them extractable: MAX_FILES never
    // fires, so only the entry budget can end this walk. Empty files are all
    // that is needed because an unsupported file costs a unit just for being
    // found — the point of the budget.
    const many = path.join(source, "node_modules");
    fs.mkdirSync(many);
    for (let i = 0; i < 20_001; i += 1) fs.writeFileSync(path.join(many, `${i}.bin`), "");

    const result = await extractDocuments(source);

    expect(result.notes[0]).toBe("This folder holds more than 20000 entries; only the first 20000 were scanned.");
    expect(result.derived).toBeNull();
    expect(result.extracted).toBe(0);
    expect(runChild).not.toHaveBeenCalled();
  }, 30_000);

  it("charges the budget across nested folders, not per folder", async () => {
    // 20000 entries spread over folders — the folder entries themselves count,
    // so the total the walk meets is over budget even though no single
    // directory is.
    for (let d = 0; d < 4; d += 1) {
      const dir = path.join(source, `part-${d}`);
      fs.mkdirSync(dir);
      for (let i = 0; i < 5_000; i += 1) fs.writeFileSync(path.join(dir, `${i}.bin`), "");
    }

    const result = await extractDocuments(source);

    expect(result.notes[0]).toBe("This folder holds more than 20000 entries; only the first 20000 were scanned.");
    expect(result.derived).toBeNull();
  }, 30_000);

  it("bounds the listing itself, not only what is done with it", async () => {
    // A directory whose listing never ends. readdir() handed the WHOLE listing
    // back as one array before the first entry could be charged, so the
    // budget bounded the looking but not the reading — and this walk would
    // never have returned. Read a page at a time, it stops one entry past the
    // budget and closes the handle it left early.
    let pulled = 0;
    let closed = false;
    const endless = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            pulled += 1;
            return { done: false, value: { name: `${pulled}.bin`, isDirectory: () => false, isFile: () => true } };
          },
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    opendirOverride.fn = () => Promise.resolve(endless);

    const result = await extractDocuments(source);

    // The budget is charged per entry read: the 20001st is the one that
    // finds it spent.
    expect(pulled).toBe(20_001);
    expect(closed).toBe(true);
    expect(result.notes[0]).toBe("This folder holds more than 20000 entries; only the first 20000 were scanned.");
    expect(result.derived).toBeNull();
  });

  it("says nothing about the budget when the folder fits inside it", async () => {
    fs.writeFileSync(path.join(source, "a.txt"), "a\n");
    for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(source, `${i}.bin`), "");
    const result = await extractDocuments(source);
    expect(result.notes).toEqual([]);
    expect(result.extracted).toBe(1);
  });
});

describe("folders that cannot be read", () => {
  const denied = (dir: string) => Promise.reject(Object.assign(new Error(`EACCES: permission denied, opendir '${dir}'`), { code: "EACCES" }));

  it("says so for the source itself instead of calling it empty", async () => {
    // Before, an unreadable source came back as `derived: null` with no
    // note — indistinguishable from a folder with nothing in it.
    fs.writeFileSync(path.join(source, "note.txt"), "unreachable\n");
    opendirOverride.fn = denied;

    const result = await extractDocuments(source);

    expect(result.notes).toEqual(["This folder could not be read."]);
    expect(result.derived).toBeNull();
    expect(result.extracted).toBe(0);
  });

  it("skips a locked folder inside, keeps the rest, and counts it for the owner", async () => {
    fs.writeFileSync(path.join(source, "open.txt"), "open\n");
    fs.mkdirSync(path.join(source, "locked"));
    fs.writeFileSync(path.join(source, "locked", "hidden.txt"), "hidden\n");
    opendirOverride.fn = (dir) => (path.basename(dir) === "locked" ? denied(dir) : undefined);

    const result = await extractDocuments(source);

    expect(result.notes).toEqual(["One folder inside could not be read and was skipped."]);
    expect(result.extracted).toBe(1);
    const contents = fs.readdirSync(result.derived!).map((name) => fs.readFileSync(path.join(result.derived!, name), "utf8"));
    expect(contents).toEqual(["open\n"]);
  });

  it("counts a folder that stops being readable mid-walk, and keeps what it read", async () => {
    // A listing that yields one real-looking file and then fails: the file
    // stands (it is copied from the real source below), the failure is a
    // skipped folder, not a truncation.
    fs.writeFileSync(path.join(source, "first.txt"), "first\n");
    let calls = 0;
    const failing = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            calls += 1;
            if (calls === 1) return { done: false, value: { name: "first.txt", isDirectory: () => false, isFile: () => true } };
            throw Object.assign(new Error("EIO: i/o error, dir.read"), { code: "EIO" });
          },
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    opendirOverride.fn = () => Promise.resolve(failing);

    const result = await extractDocuments(source);

    expect(result.notes).toEqual(["This folder could not be read."]);
    expect(result.extracted).toBe(1);
  });

  it("puts the truncation note before the unreadable one", async () => {
    // Both at once: the budget note stays first — that the scan stopped short
    // is the larger fact — and the cut to three keeps both. The listing is
    // scripted, not real, because a real directory's order is the
    // filesystem's: read first, node_modules spent the budget before the walk
    // ever reached the locked folder.
    let pulled = 0;
    const lockedThenEndless = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            pulled += 1;
            if (pulled === 1) return { done: false, value: { name: "locked", isDirectory: () => true, isFile: () => false } };
            return { done: false, value: { name: `${pulled}.bin`, isDirectory: () => false, isFile: () => true } };
          },
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    opendirOverride.fn = (dir) => (path.basename(dir) === "locked" ? denied(dir) : Promise.resolve(lockedThenEndless));

    const result = await extractDocuments(source);

    expect(result.notes).toEqual([
      "This folder holds more than 20000 entries; only the first 20000 were scanned.",
      "One folder inside could not be read and was skipped.",
    ]);
  });

});
