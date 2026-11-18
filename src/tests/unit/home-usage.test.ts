import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  homeUsage,
  insideHome,
  measureHomeUsage,
  noteHomeChange,
  openQuotaWrite,
  resetHomeUsageForTests,
  withHomeLock,
} from "@/lib/home-usage";

/**
 * TASK-2446 — what a user's home holds, for their quota: regular files only,
 * links never followed, a bounded walk that reports a floor, a cache that the
 * writes this process makes keep current, and a ceiling per write that sees
 * the bytes every other open write into the same home has already passed.
 */

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `clawbox-home-usage-${process.pid}-${Date.now()}`);
const HOME = path.join(ROOT, "home", "ivan");

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, "Documents", "deep"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "a.txt"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(HOME, "Documents", "b.txt"), Buffer.alloc(2000));
  fs.writeFileSync(path.join(HOME, "Documents", "deep", "c.txt"), Buffer.alloc(3000));
  fs.mkdirSync(path.join(ROOT, "elsewhere"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "elsewhere", "huge.bin"), Buffer.alloc(50_000));
  resetHomeUsageForTests();
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("measuring a home", () => {
  it("adds up the regular files under it, at any depth", async () => {
    const usage = await measureHomeUsage(HOME);
    expect(usage?.bytes).toBe(6000);
    expect(usage?.truncated).toBe(false);
  });

  it("never follows a link out of the home (to a file or a folder)", async () => {
    fs.symlinkSync(path.join(ROOT, "elsewhere"), path.join(HOME, "out"));
    fs.symlinkSync(path.join(ROOT, "elsewhere", "huge.bin"), path.join(HOME, "huge-link.bin"));
    expect((await measureHomeUsage(HOME))?.bytes).toBe(6000);
  });

  it("reports a floor when the walk is cut short", async () => {
    const usage = await measureHomeUsage(HOME, { maxEntries: 2 });
    expect(usage?.truncated).toBe(true);
    expect(usage!.bytes).toBeLessThan(6000);
  });

  it("skips a folder swapped for a link between its listing and its descent", async () => {
    const sub = path.join(HOME, "Documents", "deep");
    const real = fs.promises.lstat.bind(fs.promises);
    // The moment the walk checks the queued folder again, it has become a
    // link to a folder outside the home.
    const spy = vi.spyOn(fs.promises, "lstat").mockImplementation(async (p, ...rest) => {
      if (String(p) === sub && fs.lstatSync(sub).isDirectory()) {
        fs.rmSync(sub, { recursive: true });
        fs.symlinkSync(path.join(ROOT, "elsewhere"), sub);
      }
      return real(p as string, ...(rest as []));
    });
    try {
      // a.txt and Documents/b.txt; neither deep/c.txt (gone) nor huge.bin (outside).
      expect((await measureHomeUsage(HOME))?.bytes).toBe(3000);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers null for a home it cannot read", async () => {
    expect(await measureHomeUsage(path.join(ROOT, "nobody"))).toBeNull();
  });
});

describe("the cached usage", () => {
  it("is moved by the writes this process reports, and walked again on request", async () => {
    expect((await homeUsage(HOME))?.bytes).toBe(6000);
    fs.writeFileSync(path.join(HOME, "new.txt"), Buffer.alloc(500));
    // Not walked again yet: the cache answers until told.
    expect((await homeUsage(HOME))?.bytes).toBe(6000);
    noteHomeChange(HOME, 500);
    expect((await homeUsage(HOME))?.bytes).toBe(6500);
    fs.unlinkSync(path.join(HOME, "a.txt"));
    noteHomeChange(HOME);
    expect((await homeUsage(HOME))?.bytes).toBe(5500);
    expect((await homeUsage(HOME, { maxAgeMs: 0 }))?.bytes).toBe(5500);
  });
});

describe("a write under the quota", () => {
  it("may pass the quota less what the home holds, plus what it replaces", async () => {
    const w = await openQuotaWrite(HOME, 10_000);
    expect(w?.usedBytes).toBe(6000);
    expect(w!.ceiling(0)).toBe(4000);
    w!.finish(0);
    const replacing = await openQuotaWrite(HOME, 10_000, 3000);
    expect(replacing!.ceiling(0)).toBe(7000);
    replacing!.finish(0);
  });

  it("sees what the other open writes into the same home have passed", async () => {
    const one = (await openQuotaWrite(HOME, 10_000))!;
    const two = (await openQuotaWrite(HOME, 10_000))!;
    expect(one.ceiling(1500)).toBe(4000);
    // Two cannot be granted the room one is already using.
    expect(two.ceiling(0)).toBe(2500);
    one.finish(1500);
    // One landed: the home now holds it, and it no longer counts as open.
    expect(two.ceiling(0)).toBe(2500);
    two.finish(0);
    expect((await homeUsage(HOME))?.bytes).toBe(7500);
  });

  it("is never negative, and is null for a home that cannot be measured", async () => {
    const full = (await openQuotaWrite(HOME, 1000))!;
    expect(full.ceiling(0)).toBe(0);
    full.finish(0);
    expect(await openQuotaWrite(path.join(ROOT, "nobody"), 1000)).toBeNull();
  });
});

describe("one figure per home while writes are open", () => {
  it("is not walked again while a write is open, so its bytes are never counted twice", async () => {
    const w = (await openQuotaWrite(HOME, 100_000))!;
    // The write lands part of its bytes on disk, and the cached figure ages out.
    fs.writeFileSync(path.join(HOME, "upload.bin"), Buffer.alloc(1500));
    w.ceiling(1500);
    expect((await homeUsage(HOME, { maxAgeMs: 0 }))?.bytes).toBe(6000);
    w.finish(1500);
    expect((await homeUsage(HOME))?.bytes).toBe(7500);
  });

  it("keeps the figure a write opened on when a walk that started before it ends while it is open", async () => {
    expect((await homeUsage(HOME))?.bytes).toBe(6000);
    // A forced walk starts; a write opens on the cached figure before it ends
    // and lands bytes the walk may count.
    const walking = homeUsage(HOME, { maxAgeMs: 0 });
    const w = (await openQuotaWrite(HOME, 100_000))!;
    fs.writeFileSync(path.join(HOME, "upload.bin"), Buffer.alloc(1500));
    await walking;
    w.ceiling(1500);
    w.finish(1500);
    expect((await homeUsage(HOME))?.bytes).toBe(7500);
  });

  it("keeps counting the writes that land after a delete asked for a fresh walk, then walks once they are done", async () => {
    const a = (await openQuotaWrite(HOME, 10_000))!;
    const b = (await openQuotaWrite(HOME, 10_000))!;
    fs.unlinkSync(path.join(HOME, "a.txt"));
    noteHomeChange(HOME);
    // A lands 3000 bytes: they are still counted, not lost with the figure.
    fs.writeFileSync(path.join(HOME, "a-landed.bin"), Buffer.alloc(3000));
    a.ceiling(3000);
    a.finish(3000);
    expect(b.ceiling(0)).toBe(10_000 - 9000);
    b.finish(0);
    // The last write is done: the next read walks the home as it is now.
    expect((await homeUsage(HOME))?.bytes).toBe(5000 + 3000);
  });

});

describe("the last check before a write lands (TASK-2663)", () => {
  it("is against what the home holds now and the size the landing really replaces, not the credit the write began with", async () => {
    // A write began replacing a 3000-byte file, so it was metered with 3000 back.
    const w = (await openQuotaWrite(HOME, 10_000, 3000))!;
    expect(w.ceiling(6000)).toBe(7000);
    // Meanwhile another write of the same name landed 500 bytes over it.
    const other = (await openQuotaWrite(HOME, 10_000, 3000))!;
    other.finish(500 - 3000);
    expect(w.usedBytes).toBe(3500);
    // Landing 6000 in place of the 500 now there would hold 9000, and 7000
    // exactly the quota: both fit; a byte more does not. (Against the 3000 it
    // began with, 9500 would have looked as if it fitted.)
    expect(w.admits(6000, 500)).toBe(true);
    expect(w.admits(7000, 500)).toBe(true);
    expect(w.admits(7001, 500)).toBe(false);
    expect(w.ceiling(6000)).toBe(9500);
    // What other open writes have passed is held back too.
    const third = (await openQuotaWrite(HOME, 10_000))!;
    third.ceiling(1000);
    expect(w.admits(6000, 500)).toBe(true);
    expect(w.admits(6001, 500)).toBe(false);
    third.finish(0);
    w.finish(0);
  });

  it("walks a figure a delete left stale again first, leaving out the open writes' temporary files", async () => {
    expect((await homeUsage(HOME))?.bytes).toBe(6000);
    const w = (await openQuotaWrite(HOME, 10_000, 1000))!;
    // Its bytes so far, in its temporary file: counted when it lands, not now.
    const temp = path.join(HOME, ".clawbox-upload-0123456789abcdef.part");
    fs.writeFileSync(temp, Buffer.alloc(4000));
    w.staging(temp);
    // The file it overwrites is deleted meanwhile: the figure is only marked.
    fs.unlinkSync(path.join(HOME, "a.txt"));
    noteHomeChange(HOME);
    expect(w.usedBytes).toBe(6000);
    expect(w.admits(4000, 0)).toBe(true);
    expect(w.admits(5000, 0)).toBe(false);
    await w.settle();
    expect(w.usedBytes).toBe(5000);
    expect(w.admits(5000, 0)).toBe(true);
    w.finish(0);
  });

  it("grants nothing in a home that could only be measured as a floor", async () => {
    // The walk's clock runs out before it reaches the first sub-folder.
    const t0 = Date.now();
    let calls = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? t0 : t0 + 60_000));
    let w: Awaited<ReturnType<typeof openQuotaWrite>>;
    try {
      w = await openQuotaWrite(HOME, 10_000);
    } finally {
      spy.mockRestore();
    }
    expect(w?.truncated).toBe(true);
    expect(w!.admits(1, 0)).toBe(false);
    // A landing that adds nothing is no write past the quota.
    expect(w!.admits(0, 5000)).toBe(true);
    w!.finish(0);
  });
});

describe("one commit at a time per home (TASK-2663)", () => {
  it("runs the tasks for one home one after another, in the order they asked, whatever each awaits", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const first = withHomeLock(HOME, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
      return 1;
    });
    const second = withHomeLock(`${HOME}/`, () => {
      order.push("second");
      return 2;
    });
    // Another home is not held up.
    const elsewhere = await withHomeLock(path.join(ROOT, "home", "maria"), () => "maria");
    expect(elsewhere).toBe("maria");
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("lets the next task run when one throws", async () => {
    const failed = withHomeLock(HOME, async () => {
      throw new Error("the rename failed");
    });
    const next = withHomeLock(HOME, () => "ran");
    await expect(failed).rejects.toThrow("the rename failed");
    expect(await next).toBe("ran");
  });
});

describe("a home that cannot be measured whole", () => {
  it("is a floor that grants no room", async () => {
    const usage = await measureHomeUsage(HOME, { maxEntries: 2 });
    expect(usage?.truncated).toBe(true);
  });

  it("reads a large flat folder a batch at a time, stopping at the bound", async () => {
    const flat = path.join(HOME, "flat");
    fs.mkdirSync(flat);
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(flat, `f${i}`), "x");
    const usage = await measureHomeUsage(flat, { maxEntries: 100 });
    expect(usage?.truncated).toBe(true);
    expect(usage!.bytes).toBeLessThanOrEqual(100);
    expect((await measureHomeUsage(flat))?.bytes).toBe(300);
  });
});

describe("inside a home", () => {
  it("is the home itself or below it, never a sibling that shares its prefix", () => {
    expect(insideHome(HOME, HOME)).toBe(true);
    expect(insideHome(HOME, path.join(HOME, "Documents", "x"))).toBe(true);
    expect(insideHome(HOME, `${HOME}-other/x`)).toBe(false);
    expect(insideHome(HOME, path.join(HOME, "..", "maria"))).toBe(false);
  });
});
