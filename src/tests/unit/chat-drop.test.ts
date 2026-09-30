/**
 * Files AND folders dragged onto the chat composer (TASK-1276): how a drop is
 * read — folders as their trees, every batch of a directory reader drained,
 * hidden and dependency entries left out — and what of it is staged, under
 * the staging route's own limits.
 */
import { describe, expect, it } from "vitest";
import { dragHasFiles, isSkippedDropEntry, readDroppedItems } from "@/lib/dropped-files";
import { CHAT_ATTACHMENT_MAX_BYTES, newDropBatchId, planChatDrop, type DroppedItem } from "@/lib/chat-attachments";

const file = (name: string, size = 10, type = "text/plain") => new File([new Uint8Array(size)], name, { type });

// ── A fake entries API, the shape Chromium hands a drop ──
type FakeEntry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void) => void; createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void) => void } };
function fileEntry(name: string, size = 10, type = "text/plain"): FakeEntry {
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(file(name, size, type)) };
}
/** A directory whose reader answers `batch` entries at a time, then an empty batch — as Chromium does (100). */
function dirEntry(name: string, children: FakeEntry[], batch = 2): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok) => {
          const next = children.slice(at, at + batch);
          at += batch;
          queueMicrotask(() => ok(next));
        },
      };
    },
  };
}
function dataTransfer(entries: Array<{ entry: FakeEntry; file?: File }>): DataTransfer {
  const items = entries.map(({ entry, file: f }) => ({
    kind: "file",
    webkitGetAsEntry: () => entry,
    getAsFile: () => f ?? null,
  }));
  return { items: Object.assign(items, { length: items.length }), files: [], types: ["Files"] } as unknown as DataTransfer;
}

describe("readDroppedItems", () => {
  it("reads a folder as its tree, draining every batch the reader answers", async () => {
    const tree = dirEntry("site", [
      fileEntry("index.html"),
      dirEntry("src", [fileEntry("app.js"), fileEntry("util.js"), fileEntry("more.js")]),
      fileEntry("README.md"),
    ]);
    const loose = file("photo.png", 5, "image/png");
    const items = await readDroppedItems(dataTransfer([{ entry: tree }, { entry: fileEntry("photo.png"), file: loose }]), { maxFiles: 100, maxDepth: 8 });
    expect(items[0]).toEqual({ kind: "file", file: loose });
    const folder = items[1] as Extract<DroppedItem, { kind: "folder" }>;
    expect(folder.kind).toBe("folder");
    expect(folder.name).toBe("site");
    expect(folder.files.map((f) => f.relativePath)).toEqual([
      "site/README.md",
      "site/index.html",
      "site/src/app.js",
      "site/src/more.js",
      "site/src/util.js",
    ]);
    expect(folder.truncated).toBe(false);
  });

  it("leaves hidden entries, dependency folders and .git out, and counts them", async () => {
    const tree = dirEntry("repo", [
      fileEntry(".env"),
      dirEntry(".git", [fileEntry("HEAD")]),
      dirEntry("node_modules", [fileEntry("x.js")]),
      fileEntry("main.py"),
    ]);
    const [folder] = await readDroppedItems(dataTransfer([{ entry: tree }]), { maxFiles: 100, maxDepth: 8 }) as Extract<DroppedItem, { kind: "folder" }>[];
    expect(folder.files.map((f) => f.relativePath)).toEqual(["repo/main.py"]);
    expect(folder.skipped).toBe(3);
  });

  it("stops at the drop's file limit and says so, instead of reading the whole tree", async () => {
    const tree = dirEntry("big", Array.from({ length: 10 }, (_, i) => fileEntry(`f${i}.txt`)));
    const [folder] = await readDroppedItems(dataTransfer([{ entry: tree }]), { maxFiles: 4, maxDepth: 8 }) as Extract<DroppedItem, { kind: "folder" }>[];
    expect(folder.truncated).toBe(true);
    expect(folder.files).toHaveLength(4);
  });

  it("falls back to the flat file list where the entries API is missing", async () => {
    const a = file("a.txt");
    const dt = { items: undefined, files: [a], types: ["Files"] } as unknown as DataTransfer;
    expect(await readDroppedItems(dt, { maxFiles: 10, maxDepth: 4 })).toEqual([{ kind: "file", file: a }]);
    expect(await readDroppedItems(null, { maxFiles: 10, maxDepth: 4 })).toEqual([]);
  });

  it("dragHasFiles / isSkippedDropEntry", () => {
    expect(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
    expect(isSkippedDropEntry("__pycache__", true)).toBe(true);
    expect(isSkippedDropEntry("__pycache__", false)).toBe(false);
    expect(isSkippedDropEntry("Thumbs.db", false)).toBe(true);
    expect(isSkippedDropEntry("src", true)).toBe(false);
  });
});

describe("planChatDrop", () => {
  const both = { canAttachImages: true, canAttachDocuments: true };
  const imagesOnly = { canAttachImages: true, canAttachDocuments: false };
  const folder = (name: string, files: File[], extra: Partial<Extract<DroppedItem, { kind: "folder" }>> = {}): DroppedItem => ({
    kind: "folder", name, files: files.map((f) => ({ file: f, relativePath: `${name}/${f.name}` })), skipped: 0, truncated: false, ...extra,
  });

  it("stages loose files as files and a folder as a folder", () => {
    const a = file("a.txt");
    const plan = planChatDrop([{ kind: "file", file: a }, folder("site", [file("x.js"), file("y.js")])], both);
    expect(plan.files).toEqual([a]);
    expect(plan.folders).toHaveLength(1);
    expect(plan.folders[0]).toMatchObject({ name: "site", left: 0 });
    expect(plan.refusal).toBeNull();
  });

  it("refuses a file over the staging route's per-file limit, before sending a byte", () => {
    const plan = planChatDrop([{ kind: "file", file: file("huge.bin", CHAT_ATTACHMENT_MAX_BYTES + 1) }], both);
    expect(plan.files).toEqual([]);
    expect(plan.refusal).toMatchObject({ reason: "tooLarge", file: "huge.bin" });
  });

  it("leaves a folder's oversize files out and says how many", () => {
    const plan = planChatDrop([folder("site", [file("ok.js"), file("big.bin", CHAT_ATTACHMENT_MAX_BYTES + 1)])], both);
    expect(plan.folders[0].files.map((f) => f.file.name)).toEqual(["ok.js"]);
    expect(plan.folders[0].left).toBe(1);
  });

  it("refuses a folder over the drop's totals WHOLE", () => {
    const limits = { maxFiles: 3, maxBytes: 1000, maxFileBytes: 500 };
    expect(planChatDrop([folder("many", [file("1"), file("2"), file("3"), file("4")])], both, limits).refusal)
      .toMatchObject({ reason: "dropTooBig", file: "many", params: { count: 3 } });
    const heavy = planChatDrop([folder("heavy", [file("1", 400), file("2", 400), file("3", 400)])], both, limits);
    expect(heavy.folders).toEqual([]);
    expect(heavy.refusal).toMatchObject({ reason: "dropTooBig", file: "heavy" });
    expect(planChatDrop([folder("t", [file("1")], { truncated: true })], both, limits).refusal).toMatchObject({ reason: "dropTooBig" });
  });

  it("on a pictures-only box, a folder's pictures go in as pictures and the documents are named as left out", () => {
    const png = file("cat.png", 5, "image/png");
    const plan = planChatDrop([folder("mixed", [png, file("notes.txt")])], imagesOnly);
    expect(plan.folders).toEqual([]);
    expect(plan.files).toEqual([png]);
    expect(plan.refusal).toMatchObject({ reason: "folderPartial", file: "mixed", params: { count: 1, total: 2 } });
    expect(planChatDrop([folder("docs", [file("a.txt")])], imagesOnly).refusal).toMatchObject({ reason: "emptyFolder", file: "docs" });
    expect(planChatDrop([{ kind: "file", file: file("a.pdf", 5, "application/pdf") }], imagesOnly).refusal).toMatchObject({ reason: "imagesOnly" });
  });

  it("mints a batch id the staging route accepts", () => {
    const id = newDropBatchId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(newDropBatchId()).not.toBe(id);
  });
});
