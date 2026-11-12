/**
 * The icon font ("Material Symbols Rounded", src/app/globals.css). It ships
 * as a WOFF2 that globals.css reaches by a RELATIVE url(), so the bundler
 * emits it under /_next/static/media with a content hash: Next serves that
 * tree `immutable`, outside the middleware, and sends font/woff2 as stored
 * (its compression middleware does not count font/woff2 as compressible).
 * As a TTF under public/ it was revalidated on every load and gzipped again
 * on every uncached request, 1.78 MB in, about 636 KB out.
 *
 * The WOFF2 must be the SAME font as the TTF it was made from, which stays in
 * the tree because the glyph-name tests read it. Checked: every table of the
 * TTF against its own directory checksum (a truncated or damaged source
 * fails), the WOFF2 header's length field against the file's size, and every
 * table the encoder stores as-is, byte for byte, against the TTF's.
 *
 * A stated limit: glyf and loca are stored transformed, so a change to glyph
 * outlines alone (one point of one glyph moved, made into a new WOFF2) passes.
 * Catching it would take decoding the glyf transform, which this test does not
 * do; head is left out because an encoder rewrites it.
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { brotliDecompressSync } from "zlib";

// Starts a real process (git ls-files): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = process.cwd();
const FONT_DIR = path.join(ROOT, "src", "assets", "fonts");
const TTF = path.join(FONT_DIR, "material-symbols-rounded.ttf");
const WOFF2 = path.join(FONT_DIR, "material-symbols-rounded.woff2");

// Built from pieces, so this file's own text does not match what it hunts for.
const ICON_FONT_PATH = ["fonts", "material-symbols"].join("/");
// The font's path anywhere but after `assets/` (src/assets/…, ../assets/…): a
// server-root URL in any form (`"/…"`, `http://<host>/…`, `"$URL/…"`) or a
// public/ path, either of which asks for or ships the old file.
const NOT_UNDER_ASSETS = new RegExp(`(?<!assets/)${ICON_FONT_PATH}`);

/** Every tracked file of the checkout, relative to it. */
function trackedFiles(): string[] {
  const files = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter(Boolean);
  // The whole tree, not one directory of it.
  expect(files).toEqual(expect.arrayContaining(["src/app/globals.css", "install.sh"]));
  return files;
}

function iconFontFace(): string {
  const css = fs.readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");
  const faces = (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).filter((face) =>
    /font-family:\s*"Material Symbols Rounded"\s*;/.test(face),
  );
  expect(faces).toHaveLength(1);
  return faces[0];
}

function descriptor(face: string, name: string): string | undefined {
  return new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;}]+);`).exec(face)?.[1].trim();
}

// The W3C WOFF2 known-table list: a directory entry's low six flag bits index
// it, and 63 means the tag follows as four bytes.
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca",
  "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
  "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill",
];

/** A WOFF2 UIntBase128 at `at`: the value and the offset after it. */
function readBase128(buf: Buffer, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf[at + i];
    if (i === 0 && byte === 0x80) throw new Error(`UIntBase128 with a leading zero at ${at}`);
    value = value * 128 + (byte & 0x7f);
    if (value > 0xffffffff) throw new Error(`UIntBase128 overflow at ${at}`);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error(`UIntBase128 longer than five bytes at ${at}`);
}

interface Woff2Table {
  data: Buffer;
  transformed: boolean;
}

/** The tables of a single-font WOFF2, decompressed, by tag. */
function woff2Tables(file: Buffer): { flavor: number; tables: Map<string, Woff2Table> } {
  expect(file.toString("latin1", 0, 4)).toBe("wOF2");
  // Bytes appended after the compressed stream change nothing the parse below
  // reads; only the header's own length field gives them away.
  expect(file.readUInt32BE(8), "the WOFF2 header's length is the file's size").toBe(file.length);
  const flavor = file.readUInt32BE(4);
  const numTables = file.readUInt16BE(12);
  const totalCompressedSize = file.readUInt32BE(20);
  const entries: { tag: string; length: number; transformed: boolean }[] = [];
  let at = 48;
  for (let i = 0; i < numTables; i += 1) {
    const flags = file[at];
    at += 1;
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = file.toString("latin1", at, at + 4);
      at += 4;
    }
    const version = flags >> 6;
    let origLength: number;
    [origLength, at] = readBase128(file, at);
    // glyf and loca are transformed at version 0 and stored as-is at 3;
    // every other table the other way round.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    let length = origLength;
    if (transformed) [length, at] = readBase128(file, at);
    entries.push({ tag, length, transformed });
  }
  const stream = brotliDecompressSync(file.subarray(at, at + totalCompressedSize));
  const tables = new Map<string, Woff2Table>();
  let offset = 0;
  for (const { tag, length, transformed } of entries) {
    tables.set(tag, { data: stream.subarray(offset, offset + length), transformed });
    offset += length;
  }
  expect(offset, "the tables fill the decompressed stream exactly").toBe(stream.length);
  return { flavor, tables };
}

/** The tables of a TrueType file, by tag, each verified against its directory checksum. */
function sfntTables(file: Buffer): { sfntVersion: number; tables: Map<string, Buffer> } {
  const numTables = file.readUInt16BE(4);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    const tag = file.toString("latin1", record, record + 4);
    const offset = file.readUInt32BE(record + 8);
    const length = file.readUInt32BE(record + 12);
    const data = file.subarray(offset, offset + length);
    // The checksum is the sum of the table's big-endian uint32 words, zero-padded
    // to four bytes, taken over the length the directory states: subarray() stops
    // at the end of a cut-short file without a word, so this is what notices.
    // head is summed with its checkSumAdjustment (bytes 8-11) as zero.
    const words = Buffer.alloc(Math.ceil(length / 4) * 4);
    data.copy(words);
    if (tag === "head") words.fill(0, 8, 12);
    let sum = 0;
    for (let at = 0; at < words.length; at += 4) sum = (sum + words.readUInt32BE(at)) >>> 0;
    expect(sum, `the TTF's ${tag} table matches its checksum`).toBe(file.readUInt32BE(record + 4));
    tables.set(tag, data);
  }
  return { sfntVersion: file.readUInt32BE(0), tables };
}

// Every table but head (an encoder rewrites its checkSumAdjustment and flags)
// and glyf/loca (stored transformed).
const IDENTICAL_TABLES = ["GSUB", "cmap", "post", "maxp", "name", "OS/2", "hhea", "hmtx", "STAT", "gasp", "prep"];

describe("the icon font", () => {
  it("is declared as the bundled WOFF2, by a relative URL the bundler resolves", () => {
    const face = iconFontFace();
    expect(descriptor(face, "src")).toBe('url("../assets/fonts/material-symbols-rounded.woff2") format("woff2")');
    // The glyphs are ligatures: any other value paints their names ("settings",
    // "apps") in the fallback face until the font arrives.
    expect(descriptor(face, "font-display")).toBe("block");
    expect(descriptor(face, "font-weight")).toBe("400");
    expect(descriptor(face, "font-style")).toBe("normal");
  });

  it("is no longer served from public/", () => {
    const shipped = fs.readdirSync(path.join(ROOT, "public", "fonts")).filter((name) => name.startsWith("material-symbols"));
    expect(shipped).toEqual([]);
  });

  it("is named in no tracked text file but by its assets/ path", () => {
    const offenders = trackedFiles().filter((file) => {
      const bytes = fs.readFileSync(path.join(ROOT, file));
      // Text files only: no NUL in the first 8,000 bytes, git's own test.
      return !bytes.subarray(0, 8000).includes(0) && NOT_UNDER_ASSETS.test(bytes.toString("utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("is the same font as the TTF it was made from", () => {
    const ttf = sfntTables(fs.readFileSync(TTF));
    const woff2 = woff2Tables(fs.readFileSync(WOFF2));
    expect(woff2.flavor).toBe(ttf.sfntVersion);
    expect([...woff2.tables.keys()].sort()).toEqual([...ttf.tables.keys()].sort());
    expect([...IDENTICAL_TABLES, "head", "glyf", "loca"].sort()).toEqual([...ttf.tables.keys()].sort());
    for (const tag of IDENTICAL_TABLES) {
      const table = woff2.tables.get(tag)!;
      expect(table.transformed, tag).toBe(false);
      expect(table.data.equals(ttf.tables.get(tag)!), `${tag} is byte-identical`).toBe(true);
    }
    expect(woff2.tables.get("maxp")!.data.readUInt16BE(4), "numGlyphs").toBe(6483);
  });

  it("is at most 470,000 bytes", () => {
    expect(fs.statSync(WOFF2).size).toBeLessThanOrEqual(470_000);
  });
});
