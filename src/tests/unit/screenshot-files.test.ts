/**
 * Where a saved screenshot may land (TASK-1475): the name the browser proposes,
 * the names the server accepts, and the folder store that never writes, lists
 * or removes anything outside <Files root>/Screenshots.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOTS_DIR,
  formatByteSize,
  isValidScreenshotName,
  screenshotFileName,
  screenshotFormatOf,
  screenshotRelPath,
  screenshotUrl,
  sniffImageFormat,
  uniqueScreenshotName,
} from "@/lib/screenshot/files";
import {
  ScreenshotError,
  deleteScreenshot,
  listScreenshots,
  resolveScreenshotPath,
  saveScreenshot,
  screenshotsDir,
} from "@/lib/screenshot/store";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

describe("screenshot file names", () => {
  it("stamps the name with the local date and time, sortable", () => {
    expect(screenshotFileName(new Date(2026, 9, 10, 14, 5, 7), "png")).toBe("Screenshot_2026-10-10_14-05-07.png");
    expect(screenshotFileName(new Date(2027, 0, 2, 3, 4, 5), "jpg")).toBe("Screenshot_2027-01-02_03-04-05.jpg");
  });

  it("produces names the server accepts", () => {
    expect(isValidScreenshotName(screenshotFileName(new Date(), "png"))).toBe(true);
    expect(isValidScreenshotName(screenshotFileName(new Date(), "jpg"))).toBe(true);
  });

  it("accepts plain image names", () => {
    for (const name of ["a.png", "Screenshot_2026-10-10_14-05-07.png", "My shot (2).JPG", "x-1.jpeg", "A1_b.c.png"]) {
      expect(isValidScreenshotName(name), name).toBe(true);
    }
  });

  it("refuses anything that could leave the folder or hide in it", () => {
    const bad = [
      "",
      ".png",
      ".hidden.png",
      "../evil.png",
      "..png",
      "a/b.png",
      "a\\b.png",
      "/etc/passwd.png",
      "a..png",
      "a..b.png",
      "evil\u0000.png",
      "a\n.png",
      "name .png",
      "name..png",
      "-rf.png",
      " lead.png",
      "shot.gif",
      "shot.png.exe",
      "shot",
      "shot.svg",
      "сн.png",
      `${"x".repeat(101)}.png`,
      "C:shot.png",
      "shot.png/",
      "~root.png",
    ];
    for (const name of bad) expect(isValidScreenshotName(name), JSON.stringify(name)).toBe(false);
  });

  it("refuses values that are not strings at all", () => {
    for (const value of [null, undefined, 5, {}, ["a.png"]]) expect(isValidScreenshotName(value)).toBe(false);
  });

  it("reads the format from the extension", () => {
    expect(screenshotFormatOf("a.PNG")).toBe("png");
    expect(screenshotFormatOf("a.jpeg")).toBe("jpg");
    expect(screenshotFormatOf("a.jpg")).toBe("jpg");
    expect(screenshotFormatOf("a.gif")).toBeNull();
    expect(screenshotFormatOf("noext")).toBeNull();
  });

  it("recognizes the bytes themselves", () => {
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(JPG)).toBe("jpg");
    expect(sniffImageFormat(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageFormat(new Uint8Array())).toBeNull();
  });

  it("numbers a name that is taken, ignoring case", () => {
    expect(uniqueScreenshotName("a.png", [])).toBe("a.png");
    expect(uniqueScreenshotName("a.png", ["a.png"])).toBe("a-2.png");
    expect(uniqueScreenshotName("a.png", ["A.PNG", "a-2.png"])).toBe("a-3.png");
    expect(isValidScreenshotName(uniqueScreenshotName("Screenshot_2026-10-10_14-05-07.png", ["Screenshot_2026-10-10_14-05-07.png"]))).toBe(true);
  });

  it("names the file for the Files app and its route", () => {
    expect(screenshotRelPath("a b.png")).toBe(`${SCREENSHOTS_DIR}/a b.png`);
    expect(screenshotUrl("a b.png")).toBe("/setup-api/files/Screenshots/a%20b.png");
    expect(screenshotUrl("a.png", 42)).toBe("/setup-api/files/Screenshots/a.png?v=42");
  });

  it("stays under the 10 MiB at which Next would silently cut the upload short", () => {
    expect(MAX_SCREENSHOT_BYTES).toBeLessThan(10 * 1024 * 1024);
  });

  it("formats sizes for people", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.0 KB");
    expect(formatByteSize(300 * 1024)).toBe("300 KB");
    expect(formatByteSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatByteSize(Number.NaN)).toBe("0 B");
  });
});

describe("the screenshots folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-screenshots-"));
  const dir = path.join(root, SCREENSHOTS_DIR);
  const previousRoot = process.env.FILES_ROOT;

  beforeEach(() => {
    process.env.FILES_ROOT = root;
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  });

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.FILES_ROOT;
    else process.env.FILES_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function refusal(run: () => unknown): ScreenshotError {
    try {
      run();
    } catch (err) {
      if (err instanceof ScreenshotError) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  it("lives directly under the Files app's root", () => {
    expect(screenshotsDir()).toBe(dir);
  });

  it("resolves a valid name to a path directly inside the folder", () => {
    expect(resolveScreenshotPath("a.png")).toBe(path.join(dir, "a.png"));
  });

  it("resolves nothing for a name that would walk out", () => {
    for (const name of ["../a.png", "a/../../b.png", "/etc/x.png", "..", "sub/a.png", "a.png/..", null, 7]) {
      expect(resolveScreenshotPath(name), String(name)).toBeNull();
    }
  });

  it("saves into the folder, creating it on first use", () => {
    expect(fs.existsSync(dir)).toBe(false);
    const saved = saveScreenshot("shot.png", PNG);
    expect(saved).toMatchObject({ name: "shot.png", size: PNG.byteLength });
    expect(fs.readFileSync(path.join(dir, "shot.png"))).toEqual(Buffer.from(PNG));
    expect(fs.readdirSync(root)).toEqual([SCREENSHOTS_DIR]);
  });

  it("never overwrites: a taken name gets a numbered sibling", () => {
    saveScreenshot("shot.png", PNG);
    const second = saveScreenshot("shot.png", new Uint8Array([...PNG, 9]));
    expect(second.name).toBe("shot-2.png");
    expect(fs.readFileSync(path.join(dir, "shot.png"))).toEqual(Buffer.from(PNG));
    expect(fs.readdirSync(dir).sort()).toEqual(["shot-2.png", "shot.png"]);
  });

  it("refuses a name outside the folder and writes nothing", () => {
    for (const name of ["../escape.png", "sub/escape.png", "/tmp/escape.png", ".hidden.png", "a.txt"]) {
      expect(refusal(() => saveScreenshot(name, PNG)).code, name).toBe("invalid_name");
    }
    expect(fs.existsSync(path.join(root, "escape.png"))).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses what is not really the image its name claims", () => {
    expect(refusal(() => saveScreenshot("a.png", new TextEncoder().encode("<script>"))).code).toBe("not_an_image");
    expect(refusal(() => saveScreenshot("a.png", JPG)).code).toBe("type_mismatch");
    expect(refusal(() => saveScreenshot("a.jpg", PNG)).code).toBe("type_mismatch");
    expect(refusal(() => saveScreenshot("a.png", new Uint8Array())).code).toBe("empty");
    expect(saveScreenshot("a.jpeg", JPG).name).toBe("a.jpeg");
  });

  it("holds the size cap", () => {
    const big = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    big.set(PNG);
    const err = refusal(() => saveScreenshot("big.png", big));
    expect(err.code).toBe("too_large");
    expect(err.status).toBe(413);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses to write when the disk is down to the box's reserve", () => {
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 1, bsize: 1 } as unknown as fs.StatsFs);
    const err = refusal(() => saveScreenshot("a.png", PNG));
    expect(err.code).toBe("disk_full");
    expect(err.status).toBe(507);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a Screenshots folder that is a link to somewhere else", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-screenshots-elsewhere-"));
    try {
      fs.symlinkSync(elsewhere, dir);
      expect(refusal(() => saveScreenshot("a.png", PNG)).code).toBe("unsafe_folder");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(listScreenshots()).toEqual([]);
      fs.writeFileSync(path.join(elsewhere, "there.png"), PNG);
      expect(refusal(() => deleteScreenshot("there.png")).code).toBe("not_found");
      expect(fs.existsSync(path.join(elsewhere, "there.png"))).toBe(true);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not write through a link planted at the file name", () => {
    fs.mkdirSync(dir);
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "keep me");
    fs.symlinkSync(victim, path.join(dir, "shot.png"));
    const saved = saveScreenshot("shot.png", PNG);
    expect(saved.name).toBe("shot-2.png");
    expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("lists only real screenshots, newest first", () => {
    expect(listScreenshots()).toEqual([]);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "old.png"), PNG);
    fs.writeFileSync(path.join(dir, "new.jpg"), JPG);
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, ".hidden.png"), PNG);
    fs.mkdirSync(path.join(dir, "folder.png"));
    fs.symlinkSync(path.join(dir, "old.png"), path.join(dir, "link.png"));
    fs.utimesSync(path.join(dir, "old.png"), new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(path.join(dir, "new.jpg"), new Date(2_000_000), new Date(2_000_000));
    const listed = listScreenshots();
    expect(listed.map((entry) => entry.name)).toEqual(["new.jpg", "old.png"]);
    expect(listed[0]).toMatchObject({ size: JPG.byteLength, modified: 2_000_000 });
    expect(listScreenshots(1).map((entry) => entry.name)).toEqual(["new.jpg"]);
  });

  it("deletes one screenshot and nothing else", () => {
    saveScreenshot("a.png", PNG);
    saveScreenshot("b.png", PNG);
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, PNG);

    deleteScreenshot("a.png");
    expect(fs.readdirSync(dir)).toEqual(["b.png"]);

    expect(refusal(() => deleteScreenshot("../outside.png")).code).toBe("invalid_name");
    expect(refusal(() => deleteScreenshot("a.png")).code).toBe("not_found");
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("does not delete a folder or follow a link", () => {
    fs.mkdirSync(path.join(dir, "folder.png"), { recursive: true });
    expect(refusal(() => deleteScreenshot("folder.png")).code).toBe("not_found");
    expect(fs.existsSync(path.join(dir, "folder.png"))).toBe(true);

    const victim = path.join(root, "victim.png");
    fs.writeFileSync(victim, PNG);
    fs.symlinkSync(victim, path.join(dir, "link.png"));
    expect(refusal(() => deleteScreenshot("link.png")).code).toBe("not_found");
    expect(fs.existsSync(victim)).toBe(true);
  });
});
