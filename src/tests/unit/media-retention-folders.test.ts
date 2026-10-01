/**
 * The staging directory's sweep, now that a dropped FOLDER is staged as a
 * folder (TASK-1276): with `folders: true` each top-level folder is one item —
 * as old as its newest file, as big as its whole tree, removed whole — and
 * without it (every other tree) folders are left alone exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "openclaw" }));

let dir: string;
const DAY = 24 * 60 * 60 * 1000;

function write(rel: string, bytes: number, ageMs: number) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(full, t, t);
}
function age(rel: string, ageMs: number) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(dir, rel), t, t);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-retention-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function prune(retention: { maxAgeMs: number; maxBytes: number; folders?: boolean }) {
  const { pruneMediaDir } = await import("@/lib/harness/media-root");
  await pruneMediaDir(dir, retention);
}

describe("pruneMediaDir with folders", () => {
  it("removes a folder whose NEWEST file is past the age, whole", async () => {
    write("batch-old/site/a.js", 10, 9 * DAY);
    write("batch-old/site/src/b.js", 10, 8 * DAY);
    age("batch-old/site/src", 8 * DAY);
    age("batch-old/site", 8 * DAY);
    age("batch-old", 8 * DAY);
    await prune({ maxAgeMs: 7 * DAY, maxBytes: 1e9, folders: true });
    expect(fs.existsSync(path.join(dir, "batch-old"))).toBe(false);
  });

  it("keeps a folder that is still being filled, however old its first files are", async () => {
    write("batch-live/site/a.js", 10, 9 * DAY);
    write("batch-live/site/b.js", 10, 1000); // landed a second ago
    await prune({ maxAgeMs: 7 * DAY, maxBytes: 1, folders: true });
    expect(fs.existsSync(path.join(dir, "batch-live", "site", "a.js"))).toBe(true);
  });

  it("trims oldest-first by whole folders and files until the directory fits", async () => {
    write("old.png", 400, 3 * DAY);
    write("batch-mid/site/a.js", 300, 2 * DAY);
    write("batch-mid/site/b.js", 300, 2 * DAY);
    age("batch-mid/site", 2 * DAY);
    age("batch-mid", 2 * DAY);
    write("new.png", 400, 1 * DAY);
    await prune({ maxAgeMs: 7 * DAY, maxBytes: 500, folders: true });
    expect(fs.existsSync(path.join(dir, "old.png"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "batch-mid"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "new.png"))).toBe(true);
  });

  it("leaves folders alone without the option, as it always did", async () => {
    write("somebody-elses/a.bin", 10, 30 * DAY);
    age("somebody-elses", 30 * DAY);
    write("stale.png", 10, 30 * DAY);
    await prune({ maxAgeMs: 7 * DAY, maxBytes: 1e9 });
    expect(fs.existsSync(path.join(dir, "somebody-elses", "a.bin"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "stale.png"))).toBe(false);
  });
});
