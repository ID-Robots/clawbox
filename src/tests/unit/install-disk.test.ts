import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The disk check every install makes before it fetches anything.
 *
 * The case worth a test on its own: the directory being measured usually does
 * NOT exist yet — a Whisper size's cache entry, a model directory on a fresh
 * box — and `statfs` on a path that is not there fails. Read as "the disk would
 * not say", that turns the check into a pass on exactly the boxes it is for.
 */

const measured: string[] = [];
vi.mock("@/lib/project-import", () => ({
  freeBytes: async (dir: string) => {
    measured.push(dir);
    return 4 * 1024 * 1024 * 1024;
  },
}));

let root: string;
beforeEach(() => {
  measured.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-disk-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("checkInstallDisk", () => {
  it("measures the filesystem a path that does not exist yet would land on", async () => {
    const { checkInstallDisk } = await import("@/lib/install-disk");
    const verdict = await checkInstallDisk(path.join(root, "not/here/at/all"), 1024);

    expect(measured).toEqual([root]);
    expect(verdict.freeBytes).toBe(4 * 1024 * 1024 * 1024);
    expect(verdict.ok).toBe(true);
  });

  it("measures the directory itself when it is there", async () => {
    const { checkInstallDisk } = await import("@/lib/install-disk");
    await checkInstallDisk(root, 1024);
    expect(measured).toEqual([root]);
  });

  it("refuses a download the free space cannot take", async () => {
    const { checkInstallDisk, diskRefusal } = await import("@/lib/install-disk");
    const verdict = await checkInstallDisk(path.join(root, "models"), 8 * 1024 * 1024 * 1024);
    expect(verdict.ok).toBe(false);

    const res = diskRefusal(verdict);
    expect(res.status).toBe(507);
    const body = await res.json();
    expect(body.code).toBe("disk_full");
    expect(body.requiredBytes).toBe(8 * 1024 * 1024 * 1024);
    expect(body.shortfallBytes).toBeGreaterThan(0);
  });
});

describe("dirBytes", () => {
  it("counts a symlink as the link it is, not as the file it points at", async () => {
    // The Hub writes snapshots as links into `blobs/`; following them reports
    // a cache at twice its size, which is the number a "remove frees N" shows.
    const blob = path.join(root, "blob");
    fs.writeFileSync(blob, "x".repeat(1000));
    fs.mkdirSync(path.join(root, "snapshot"));
    fs.symlinkSync(blob, path.join(root, "snapshot", "model.bin"));

    const { dirBytes } = await import("@/lib/install-disk");
    const total = await dirBytes(root);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(total).toBeLessThan(2000);
  });

  it("has nothing to report for a directory that is not there", async () => {
    const { dirBytes } = await import("@/lib/install-disk");
    expect(await dirBytes(path.join(root, "gone"))).toBeNull();
  });
});
