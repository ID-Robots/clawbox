import fsp from "fs/promises";
import zlib from "zlib";
import { Readable } from "stream";
import path from "@/lib/runtime-path";
import { isProtectedFilePath } from "@/lib/file-guard";

// ── A folder, downloaded as one ZIP ─────────────────────────────────────────
//
// The Files app could download a FILE and nothing else: a GET on a folder
// answered 400 "Is a directory", so taking a whole project off the box meant
// one click per file. This streams a folder as a ZIP instead — written as it is
// read, never staged on the disk and never held in memory whole, because a
// project folder on this box can be larger than the RAM it has and a copy on
// the disk is exactly what the upload reserve exists to prevent.
//
// ZIP rather than tar.gz because the owner's computer opens a ZIP with a double
// click everywhere, and a stream is still possible: each entry's CRC and sizes
// follow its data in a data descriptor (general-purpose bit 3), so nothing has
// to be known before the bytes are sent. ZIP64 records are written where a
// size or an offset outgrows 32 bits — only there, since some unzippers still
// stumble over ZIP64 fields in an archive that did not need them.
//
// WHAT GOES IN is the Files API's own rule, entry by entry: `isProtectedFilePath`
// on every path the walk meets — the rule `safePath` applies to every single
// download — so a folder that holds a `.netrc`, a symlink into `~/.ssh` or a
// public subtree beside the data directory's secrets yields exactly what the
// Files app would let the owner download one file at a time, and nothing more.
// A symlinked FILE is followed (the single-file download follows it too); a
// symlinked DIRECTORY is not descended, which is what keeps a link cycle from
// running forever, the same choice the Files search makes.

/**
 * Folders left out of the archive: dependency and cache trees the project can
 * regenerate, which are most of a project folder's weight and none of its
 * content. `.git` is NOT here — a project's history is part of the project.
 * The folder entry itself is left out too, so an unzipped project does not
 * carry an empty `node_modules/` that looks like a broken install.
 */
export const ZIP_SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".cache", ".npm", "__pycache__", ".venv"]);

/**
 * How many entries (files and folders) one archive may hold. The central
 * directory is written at the END, so a record of every entry is held until
 * then — a few hundred bytes each. A cap keeps a ZIP of a whole home folder
 * from growing that list without bound; the Files app asks first (`summarize`)
 * so the owner hears about it before a download starts.
 */
export const MAX_ZIP_ENTRIES = 100_000;

/** One thing the walk found, named as it will be inside the archive. */
export interface ZipWalkEntry {
  kind: "file" | "directory";
  abs: string;
  /** `/`-separated, under the top folder; a directory's ends in `/`. */
  name: string;
  size: number;
  mtime: Date;
  mode: number;
}

/**
 * Every entry of `rootAbs`, depth-first in name order, beginning with the top
 * folder itself as `topName/`. Unreadable folders are passed over rather than
 * failing the archive — the owner asked for what can be read.
 */
export async function* walkFolderForZip(rootAbs: string, topName: string): AsyncGenerator<ZipWalkEntry> {
  const top = await fsp.stat(rootAbs);
  yield { kind: "directory", abs: rootAbs, name: `${topName}/`, size: 0, mtime: top.mtime, mode: top.mode };
  const stack: Array<{ abs: string; name: string }> = [{ abs: rootAbs, name: topName }];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: import("fs").Dirent[];
    try {
      dirents = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: Array<{ abs: string; name: string }> = [];
    for (const dirent of dirents) {
      const abs = path.join(dir.abs, dirent.name);
      const name = `${dir.name}/${dirent.name}`;
      if (isProtectedFilePath(abs)) continue;
      if (dirent.isDirectory()) {
        if (ZIP_SKIPPED_DIRS.has(dirent.name)) continue;
        let st: import("fs").Stats;
        try { st = await fsp.stat(abs); } catch { continue; }
        yield { kind: "directory", abs, name: `${name}/`, size: 0, mtime: st.mtime, mode: st.mode };
        subdirs.push({ abs, name });
        continue;
      }
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue; // sockets, fifos, devices
      let st: import("fs").Stats;
      try { st = await fsp.stat(abs); } catch { continue; } // a dangling link
      if (!st.isFile()) continue; // a link to a directory is not descended
      yield { kind: "file", abs, name, size: st.size, mtime: st.mtime, mode: st.mode };
    }
    // Reversed onto the stack so the first subfolder is walked first.
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]);
  }
}

export interface ZipSummary {
  /** Files and folders the archive would hold, the top folder included. */
  entries: number;
  files: number;
  /** Uncompressed bytes of the files. */
  bytes: number;
  /** More than `limit` entries: the walk stopped counting there. */
  tooMany: boolean;
  limit: number;
}

/**
 * One thing the owner SELECTED for a ZIP (the Files app's multi-select
 * download): where it is, and the name it goes into the archive under.
 */
export interface ZipSelectionItem {
  abs: string;
  name: string;
}

/**
 * Every entry of a selection: a file as itself, a folder the way
 * `walkFolderForZip` walks one, each under its own `name`. The same rule as a
 * folder's walk — `isProtectedFilePath` on the item itself, a vanished item
 * passed over — so a selection holds exactly what the items downloaded one by
 * one would.
 */
export async function* walkSelectionForZip(items: readonly ZipSelectionItem[]): AsyncGenerator<ZipWalkEntry> {
  for (const item of items) {
    if (isProtectedFilePath(item.abs)) continue;
    let st: import("fs").Stats;
    try { st = await fsp.stat(item.abs); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkFolderForZip(item.abs, item.name);
      continue;
    }
    if (!st.isFile()) continue;
    yield { kind: "file", abs: item.abs, name: item.name, size: st.size, mtime: st.mtime, mode: st.mode };
  }
}

async function summarizeWalk(walk: AsyncIterable<ZipWalkEntry>, limit: number): Promise<ZipSummary> {
  let entries = 0;
  let files = 0;
  let bytes = 0;
  for await (const entry of walk) {
    entries += 1;
    if (entries > limit) return { entries: limit, files, bytes, tooMany: true, limit };
    if (entry.kind === "file") {
      files += 1;
      bytes += entry.size;
    }
  }
  return { entries, files, bytes, tooMany: false, limit };
}

/** What a ZIP of the folder would hold, counted without reading a byte of it. */
export async function summarizeFolderForZip(rootAbs: string, limit = MAX_ZIP_ENTRIES): Promise<ZipSummary> {
  return summarizeWalk(walkFolderForZip(rootAbs, path.basename(rootAbs)), limit);
}

/** What a ZIP of the selection would hold, counted the same way. */
export async function summarizeSelectionForZip(items: readonly ZipSelectionItem[], limit = MAX_ZIP_ENTRIES): Promise<ZipSummary> {
  return summarizeWalk(walkSelectionForZip(items), limit);
}

// ── The format ───────────────────────────────────────────────────────────────

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
/**
 * Where a FILE's entry is written with ZIP64 sizes. The choice is made before
 * the first byte, from the size `stat` reported, and deflate can make
 * incompressible data slightly LARGER — so the line sits 16 MiB under 4 GiB,
 * far more than deflate's worst-case growth on a file that size.
 */
const ZIP64_FILE_THRESHOLD = 0xff000000;

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/** "Made by" Unix (3), spec 4.5 — so the mode in the external attributes is read. */
const VERSION_MADE_BY = (3 << 8) | 45;
const VERSION_NEEDED = 20;
const VERSION_NEEDED_ZIP64 = 45;

/** Already-compressed formats: deflated at level 1, where level 6 buys nothing and costs the CPU. */
const COMPRESSED_EXT = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "whl", "apk",
  "docx", "xlsx", "pptx", "odt", "ods", "odp",
  "jpg", "jpeg", "png", "gif", "webp", "avif", "heic",
  "mp3", "mp4", "m4a", "m4v", "mov", "webm", "mkv", "ogg", "oga", "ogv", "opus", "flac", "aac",
  "gguf", "safetensors",
]);

function deflateLevelFor(name: string): number {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return COMPRESSED_EXT.has(ext) ? 1 : 6;
}

// zlib.crc32 arrived in Node 22.2. The appliance runs 24; the fallback keeps a
// development machine on an older Node from failing every archive.
let crcTable: Uint32Array | null = null;
function crc32Fallback(chunk: Uint8Array, crc: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ U32_MAX) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) c = crcTable[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return (c ^ U32_MAX) >>> 0;
}
const zlibCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;
export function crc32(chunk: Uint8Array, crc = 0): number {
  return zlibCrc32 ? zlibCrc32(chunk, crc) : crc32Fallback(chunk, crc);
}

/** MS-DOS date and time, in the box's local time; clamped to the range the format has. */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** What the central directory needs to know about one entry once its data is written. */
export interface ZipRecord {
  name: Buffer;
  kind: "file" | "directory";
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
  time: number;
  date: number;
  mode: number;
  /** The local header carried ZIP64 sizes (so the central one must too). */
  zip64Local: boolean;
}

export function localFileHeader(rec: Pick<ZipRecord, "name" | "method" | "flags" | "time" | "date" | "zip64Local">): Buffer {
  const extra = rec.zip64Local ? Buffer.alloc(20) : Buffer.alloc(0);
  if (rec.zip64Local) {
    // Both sizes, both zero: the real ones follow the data in the descriptor.
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
  }
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(rec.zip64Local ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 4);
  h.writeUInt16LE(rec.flags, 6);
  h.writeUInt16LE(rec.method, 8);
  h.writeUInt16LE(rec.time, 10);
  h.writeUInt16LE(rec.date, 12);
  // CRC and sizes are zero here and in the descriptor after the data (bit 3);
  // a ZIP64 entry says 0xFFFFFFFF and points at its extra field instead.
  h.writeUInt32LE(0, 14);
  h.writeUInt32LE(rec.zip64Local ? U32_MAX : 0, 18);
  h.writeUInt32LE(rec.zip64Local ? U32_MAX : 0, 22);
  h.writeUInt16LE(rec.name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, rec.name, extra]);
}

export function dataDescriptor(rec: Pick<ZipRecord, "crc" | "compressedSize" | "size" | "zip64Local">): Buffer {
  if (rec.zip64Local) {
    const d = Buffer.alloc(24);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(rec.crc >>> 0, 4);
    d.writeBigUInt64LE(BigInt(rec.compressedSize), 8);
    d.writeBigUInt64LE(BigInt(rec.size), 16);
    return d;
  }
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(rec.crc >>> 0, 4);
  d.writeUInt32LE(rec.compressedSize, 8);
  d.writeUInt32LE(rec.size, 12);
  return d;
}

export function centralDirectoryHeader(rec: ZipRecord): Buffer {
  const sizes64 = rec.zip64Local || rec.size >= U32_MAX || rec.compressedSize >= U32_MAX;
  const offset64 = rec.offset >= U32_MAX;
  const fields: bigint[] = [];
  if (sizes64) fields.push(BigInt(rec.size), BigInt(rec.compressedSize));
  if (offset64) fields.push(BigInt(rec.offset));
  let extra = Buffer.alloc(0);
  if (fields.length > 0) {
    extra = Buffer.alloc(4 + fields.length * 8);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(fields.length * 8, 2);
    fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
  }
  // Permissions in the high half (so an executable script stays executable
  // when unzipped on Linux or macOS), the MS-DOS directory bit in the low one.
  const external = (((rec.mode & 0xffff) << 16) >>> 0) | (rec.kind === "directory" ? 0x10 : 0);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(VERSION_MADE_BY, 4);
  h.writeUInt16LE(fields.length > 0 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED, 6);
  h.writeUInt16LE(rec.flags, 8);
  h.writeUInt16LE(rec.method, 10);
  h.writeUInt16LE(rec.time, 12);
  h.writeUInt16LE(rec.date, 14);
  h.writeUInt32LE(rec.crc >>> 0, 16);
  h.writeUInt32LE(sizes64 ? U32_MAX : rec.compressedSize, 20);
  h.writeUInt32LE(sizes64 ? U32_MAX : rec.size, 24);
  h.writeUInt16LE(rec.name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attributes
  h.writeUInt32LE(external >>> 0, 38);
  h.writeUInt32LE(offset64 ? U32_MAX : rec.offset, 42);
  return Buffer.concat([h, rec.name, extra]);
}

/**
 * The archive's closing records. `cdOffset` is where the central directory
 * starts and `cdSize` its length; past 65,535 entries or 4 GiB the ZIP64 end
 * record and its locator go first, and the classic record carries the
 * "look there" sentinels.
 */
export function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const zip64 = count >= U16_MAX || cdSize >= U32_MAX || cdOffset >= U32_MAX;
  const parts: Buffer[] = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(BigInt(56 - 12), 4);
    rec.writeUInt16LE(VERSION_MADE_BY, 12);
    rec.writeUInt16LE(VERSION_NEEDED_ZIP64, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(rec, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Math.min(count, U16_MAX), 8);
  end.writeUInt16LE(Math.min(count, U16_MAX), 10);
  end.writeUInt32LE(Math.min(cdSize, U32_MAX), 12);
  end.writeUInt32LE(Math.min(cdOffset, U32_MAX), 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * The bytes of a ZIP holding `entries`, as they are produced. Pull-driven: a
 * slow download reads the next file only when the last one has been taken, so
 * the memory this holds is one deflate window and the central directory list.
 *
 * Throws (and so errors the stream, which aborts the download) past
 * `maxEntries`, and if a file grew past the 32-bit sizes its entry was begun
 * with — a truncated archive the owner can see failed is better than one that
 * unzips wrong.
 */
export async function* zipEntries(
  entries: AsyncIterable<ZipWalkEntry>,
  { maxEntries = MAX_ZIP_ENTRIES }: { maxEntries?: number } = {},
): AsyncGenerator<Buffer> {
  const records: ZipRecord[] = [];
  let offset = 0;
  for await (const entry of entries) {
    if (records.length >= maxEntries) {
      throw new Error(`more than ${maxEntries} entries`);
    }
    const name = Buffer.from(entry.name, "utf8");
    if (name.length > U16_MAX) continue;
    const { time, date } = dosDateTime(entry.mtime);

    if (entry.kind === "directory") {
      const rec: ZipRecord = {
        name, kind: "directory", method: METHOD_STORED, flags: FLAG_UTF8, crc: 0, compressedSize: 0, size: 0,
        offset, time, date, mode: entry.mode, zip64Local: false,
      };
      const header = localFileHeader(rec);
      yield header;
      offset += header.length;
      records.push(rec);
      continue;
    }

    // Opened BEFORE its header is written: a file that cannot be read (a 600
    // file of another user's, removed since the walk) is left out rather than
    // leaving a header with no data behind it.
    let handle: import("fs/promises").FileHandle;
    try {
      handle = await fsp.open(entry.abs, "r");
    } catch {
      continue;
    }
    const rec: ZipRecord = {
      name, kind: "file", method: METHOD_DEFLATED, flags: FLAG_DATA_DESCRIPTOR | FLAG_UTF8, crc: 0,
      compressedSize: 0, size: 0, offset, time, date, mode: entry.mode,
      zip64Local: entry.size >= ZIP64_FILE_THRESHOLD,
    };
    const source = handle.createReadStream();
    const deflate = zlib.createDeflateRaw({ level: deflateLevelFor(entry.name) });
    try {
      const header = localFileHeader(rec);
      yield header;
      offset += header.length;
      // The CRC and the size are of the bytes READ, not of what stat said a
      // moment ago — a file still being written is archived as it was read.
      source.on("data", (chunk: Buffer | string) => {
        // No encoding is set, so a chunk is always bytes; the type allows text.
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        rec.crc = crc32(bytes, rec.crc);
        rec.size += bytes.length;
      });
      source.on("error", (err) => deflate.destroy(err));
      source.pipe(deflate);
      for await (const out of deflate as AsyncIterable<Buffer>) {
        rec.compressedSize += out.length;
        offset += out.length;
        yield out;
      }
    } finally {
      // Covers the consumer walking away mid-file (a cancelled download):
      // the generator is returned from inside the loop above, and the file
      // must not stay open behind it.
      source.destroy();
      deflate.destroy();
    }
    if (!rec.zip64Local && (rec.size >= U32_MAX || rec.compressedSize >= U32_MAX)) {
      throw new Error(`${entry.name} grew past 4 GiB while it was being archived`);
    }
    const descriptor = dataDescriptor(rec);
    yield descriptor;
    offset += descriptor.length;
    records.push(rec);
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const rec of records) {
    const header = centralDirectoryHeader(rec);
    cdSize += header.length;
    yield header;
  }
  yield endOfCentralDirectory(records.length, cdSize, cdOffset);
}

/** A ZIP of the folder at `rootAbs`, its entries under `topName/`, as a Node stream. */
export function zipFolderStream(rootAbs: string, topName: string, opts: { maxEntries?: number } = {}): Readable {
  return Readable.from(zipEntries(walkFolderForZip(rootAbs, topName), opts), { objectMode: false });
}

/** A ZIP of the selected files and folders, each at the top of the archive, as a Node stream. */
export function zipSelectionStream(items: readonly ZipSelectionItem[], opts: { maxEntries?: number } = {}): Readable {
  return Readable.from(zipEntries(walkSelectionForZip(items), opts), { objectMode: false });
}
