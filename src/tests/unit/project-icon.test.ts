/**
 * The picture a coding-agent project gets: the desktop icon the app's project
 * row shows, and the two favicons the pages a run writes link to.
 *
 * Two properties matter more than the rest, because both are races this runs
 * inside: it fires while a run is WORKING in the same folder, so a favicon the
 * run wrote itself must win; and it costs a picture out of the owner's daily
 * allowance, so a project that already has an icon must never buy a second one
 * to get its favicons.
 *
 * The ICO header is checked byte by byte because nothing on this box renders
 * one — a wrong offset would ship silently and only fail in someone's browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

const ensureIconFile = vi.hoisted(() => vi.fn());
const shrinkIcon = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webapp-icon", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/webapp-icon")>();
  return { ...real, ensureIconFile, shrinkIcon };
});

import { webappIconPath } from "@/lib/webapp-icon";
import { ensureProjectIcon, FAVICON_ICO, FAVICON_PNG, icoFromPng } from "@/lib/project-icon";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(120, 5)]);
const SMALL = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(30, 9)]);

let base: string;
let directory: string;
let restore: () => void;

beforeEach(() => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "project-icon-"));
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = path.join(base, "clawbox");
  directory = path.join(base, "Projects", "site");
  fs.mkdirSync(directory, { recursive: true });
  ensureIconFile.mockReset();
  shrinkIcon.mockReset().mockResolvedValue(SMALL);
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Play the pipeline's part: hand the full-size bytes over, then say "generated". */
function generates(bytes: Buffer = PNG) {
  ensureIconFile.mockImplementation(async (_id: string, _hints: unknown, hooks: { onBytes?: (b: Buffer) => Promise<void> }) => {
    await hooks.onBytes?.(bytes);
    return "generated";
  });
}

describe("ensureProjectIcon", () => {
  it("writes both favicons from the picture it just drew", async () => {
    generates();
    const outcome = await ensureProjectIcon({ id: "site", directory, name: "Site" });
    expect(outcome).toEqual({ icon: "generated", favicon: true });
    expect(fs.readFileSync(path.join(directory, FAVICON_PNG)).equals(SMALL)).toBe(true);
    const ico = fs.readFileSync(path.join(directory, FAVICON_ICO));
    expect(ico.subarray(22).equals(SMALL)).toBe(true);
  });

  it("never replaces a favicon the run or the owner wrote themselves", async () => {
    // This runs WHILE the run works in the same folder, so losing that race
    // has to mean "theirs stays".
    fs.writeFileSync(path.join(directory, FAVICON_PNG), "the run's own");
    generates();
    const outcome = await ensureProjectIcon({ id: "site", directory, name: "Site" });
    expect(fs.readFileSync(path.join(directory, FAVICON_PNG), "utf-8")).toBe("the run's own");
    // The .ico was still free, so something WAS written.
    expect(outcome.favicon).toBe(true);
    fs.writeFileSync(path.join(directory, FAVICON_ICO), "and this");
    fs.rmSync(path.join(directory, FAVICON_PNG));
    fs.writeFileSync(path.join(directory, FAVICON_PNG), "still theirs");
    const again = await ensureProjectIcon({ id: "site", directory, name: "Site" });
    expect(again.favicon).toBe(false);
  });

  it("derives the favicons from the icon on disk rather than buying a second picture", async () => {
    // 'kept' is the pipeline saying "there was already one" — a box that had
    // an icon before this existed, or a project whose favicon was deleted.
    // Where the icon route reads from, asked of the module rather than
    // rebuilt here: DATA_DIR is resolved when config-store is imported.
    const icon = webappIconPath("site");
    fs.mkdirSync(path.dirname(icon), { recursive: true });
    fs.writeFileSync(icon, PNG);
    ensureIconFile.mockResolvedValue("kept");
    const outcome = await ensureProjectIcon({ id: "site", directory, name: "Site" });
    expect(outcome).toEqual({ icon: "kept", favicon: true });
    expect(fs.existsSync(path.join(directory, FAVICON_PNG))).toBe(true);
  });

  it("skips an id the icon route could never serve, before it asks for anything", async () => {
    const outcome = await ensureProjectIcon({ id: "../etc", directory, name: "x" });
    expect(outcome).toEqual({ icon: "skipped", favicon: false });
    expect(ensureIconFile).not.toHaveBeenCalled();
  });

  it("answers rather than throws when the folder went away mid-generation", async () => {
    ensureIconFile.mockImplementation(async (_id: string, _hints: unknown, hooks: { onBytes?: (b: Buffer) => Promise<void> }) => {
      fs.rmSync(directory, { recursive: true, force: true });
      await hooks.onBytes?.(PNG);
      return "generated";
    });
    // The write fails; the caller — a `void` at the start of a run — must get
    // an outcome, never a rejection.
    await expect(ensureProjectIcon({ id: "site", directory, name: "Site" })).resolves.toEqual({
      icon: "skipped",
      favicon: false,
    });
  });

  it("asks the pipeline whether the folder is still there", async () => {
    generates();
    await ensureProjectIcon({ id: "site", directory, name: "Site" });
    const hooks = ensureIconFile.mock.calls[0][2] as { stillWanted: () => Promise<boolean> };
    expect(await hooks.stillWanted()).toBe(true);
    fs.rmSync(directory, { recursive: true, force: true });
    expect(await hooks.stillWanted()).toBe(false);
  });
});

describe("icoFromPng", () => {
  it("wraps the PNG in the 22-byte header a browser expects", () => {
    const ico = icoFromPng(SMALL, 64);
    expect(ico.readUInt16LE(0)).toBe(0);   // reserved
    expect(ico.readUInt16LE(2)).toBe(1);   // an icon, not a cursor
    expect(ico.readUInt16LE(4)).toBe(1);   // one image
    expect(ico.readUInt8(6)).toBe(64);     // width
    expect(ico.readUInt8(7)).toBe(64);     // height
    expect(ico.readUInt8(8)).toBe(0);      // no palette
    expect(ico.readUInt16LE(10)).toBe(1);  // one plane
    expect(ico.readUInt16LE(12)).toBe(32); // 32 bits per pixel
    expect(ico.readUInt32LE(14)).toBe(SMALL.length);
    expect(ico.readUInt32LE(18)).toBe(22); // the only place the payload can start
    expect(ico.subarray(22).equals(SMALL)).toBe(true);
  });

  it("spells 256 as the zero the format reserves for it", () => {
    expect(icoFromPng(SMALL, 256).readUInt8(6)).toBe(0);
  });
});
