import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  homeUsage,
  insideHome,
  measureHomeUsage,
  noteHomeChange,
  openQuotaWrite,
  resetHomeUsageForTests,
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

  it("holds a reservation against the quota until it finishes", async () => {
    const move = (await openQuotaWrite(HOME, 10_000))!;
    move.reserve(3000);
    const other = (await openQuotaWrite(HOME, 10_000))!;
    expect(other.ceiling(0)).toBe(1000);
    move.finish(0);
    expect(other.ceiling(0)).toBe(4000);
    other.finish(0);
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
