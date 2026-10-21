/**
 * The one archive format the ClawBox Store moves: a gzip'd POSIX tar of plain
 * files and folders.
 *
 * Written here rather than taken from a package because the box needs very
 * little of tar and must refuse most of it. A package is produced from a
 * project folder (src/lib/store-publish.ts) and unpacked into the owner's
 * project folder (src/lib/store-install.ts), and what arrives is a file from
 * the internet: a symlink, a hard link, a device node, an absolute path or a
 * `..` segment is a way out of the folder it is unpacked into, so the reader
 * REFUSES the whole package on any of them rather than skipping the entry —
 * a package that carries one was not made by `packTarGz`.
 *
 * Long and non-ASCII paths travel as a PAX `path` record (the reader also
 * takes GNU long names, which other packers write); everything else about an
 * entry — owner, group, times beyond mtime — is dropped on both sides.
 */
import zlib from "zlib";
import { Readable, Writable } from "stream";
import { pipeline } from "stream/promises";

const BLOCK = 512;

export interface TarEntry {
  /** POSIX path relative to the archive root, no leading `./`, no trailing `/`. */
  path: string;
  type: "file" | "dir";
  /** Permission bits; only the executable bit survives a round trip. */
  mode: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** A file's bytes; absent for a folder. */
  data?: Buffer;
}

export type TarErrorReason = "too_large" | "invalid" | "unsafe_entry";

export class TarError extends Error {
  constructor(readonly reason: TarErrorReason, message: string) {
    super(message);
    this.name = "TarError";
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  block.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

function headerBlock(input: { name: string; prefix: string; size: number; mode: number; mtime: number; type: string }): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(input.name, 0, 100, "utf8");
  writeOctal(block, input.mode & 0o7777, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, input.size, 124, 12);
  writeOctal(block, Math.max(0, Math.floor(input.mtime)), 136, 12);
  block.fill(0x20, 148, 156);
  block.write(input.type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(input.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest, 0);
}

/** A PAX record is `<length> <key>=<value>\n`, the length counting its own digits. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, "utf8");
  let length = bodyBytes + 1;
  while (length !== bodyBytes + String(length).length) length = bodyBytes + String(length).length;
  return Buffer.from(`${length}${body}`, "utf8");
}

/** Split a path into ustar's name (≤ 100 bytes) and prefix (≤ 155), or null when it needs PAX. */
function ustarSplit(p: string): { name: string; prefix: string } | null {
  if (!/^[\x20-\x7e]*$/.test(p)) return null;
  if (p.length <= 100) return { name: p, prefix: "" };
  for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return { name, prefix };
  }
  return null;
}

function entryBlocks(entry: TarEntry): Buffer[] {
  const isDir = entry.type === "dir";
  const fullPath = isDir ? `${entry.path}/` : entry.path;
  const size = isDir ? 0 : entry.data?.length ?? 0;
  const mode = isDir ? 0o755 : (entry.mode & 0o111 ? 0o755 : 0o644);
  const out: Buffer[] = [];
  let split = ustarSplit(fullPath);
  if (!split) {
    const record = paxRecord("path", fullPath);
    out.push(headerBlock({ name: "PaxHeader", prefix: "", size: record.length, mode: 0o644, mtime: entry.mtime, type: "x" }), record, padding(record.length));
    // The ustar name is only a fallback for a reader without PAX: ASCII, bounded.
    split = { name: fullPath.replace(/[^\x20-\x7e]/g, "_").slice(-100).replace(/^\/+/, ""), prefix: "" };
  }
  out.push(headerBlock({ ...split, size, mode, mtime: entry.mtime, type: isDir ? "5" : "0" }));
  if (!isDir && entry.data && size > 0) out.push(entry.data, padding(size));
  return out;
}

/**
 * Pack entries into a gzip'd tar. `maxBytes` bounds the COMPRESSED output and
 * is checked while it is produced, so an oversized project fails before it is
 * held whole; the entries are pulled one at a time for the same reason.
 */
export async function packTarGz(
  entries: AsyncIterable<TarEntry> | Iterable<TarEntry>,
  opts: { maxBytes: number },
): Promise<Buffer> {
  async function* blocks(): AsyncGenerator<Buffer> {
    for await (const entry of entries) {
      for (const block of entryBlocks(entry)) yield block;
    }
    yield Buffer.alloc(BLOCK * 2, 0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > opts.maxBytes) {
        done(new TarError("too_large", `The package is larger than ${Math.round(opts.maxBytes / (1024 * 1024))} MB.`));
        return;
      }
      chunks.push(chunk);
      done();
    },
  });
  await pipeline(Readable.from(blocks(), { objectMode: false }), zlib.createGzip({ level: 9 }), sink);
  return Buffer.concat(chunks, total);
}

// ── Reading ──────────────────────────────────────────────────────────────────

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  // A leading 0x80 byte is the base-256 form: sizes no package of ours reaches.
  if (block[offset] & 0x80) throw new TarError("too_large", "The package holds an entry too large to be an app file.");
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("invalid", "The package is not a valid tar archive.");
  return Number.parseInt(text, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === stored;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(at, space).toString("ascii"), 10);
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) break;
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/**
 * The entry's path made safe to join under a folder, or null for the
 * archive's own root (`./`). Throws on anything that could leave the folder.
 */
export function safeEntryPath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) {
    throw new TarError("unsafe_entry", `The package names a path outside its own folder ("${raw.slice(0, 120)}").`);
  }
  const parts = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (parts.some((segment) => segment === "..")) {
    throw new TarError("unsafe_entry", `The package names a path outside its own folder ("${raw.slice(0, 120)}").`);
  }
  return parts.length === 0 ? null : parts.join("/");
}

const TYPE_NAMES: Record<string, string> = {
  "1": "hard link", "2": "symbolic link", "3": "character device", "4": "block device", "6": "named pipe",
};

/**
 * Read a gzip'd tar into its entries. `maxBytes` bounds the UNPACKED archive
 * (the gunzip stops there — a small package can still inflate to anything),
 * `maxEntries` the number of files and folders. A later entry for the same
 * path replaces an earlier one, as tar itself does.
 */
export function readTarGz(gz: Buffer, limits: { maxBytes: number; maxEntries: number }): TarEntry[] {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: limits.maxBytes });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof RangeError || code === "ERR_BUFFER_TOO_LARGE") {
      throw new TarError("too_large", `The package unpacks to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`);
    }
    throw new TarError("invalid", "The package is not a gzip archive.");
  }
  const byPath = new Map<string, TarEntry>();
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new TarError("invalid", "The package is not a valid tar archive.");
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) throw new TarError("invalid", "The package ends in the middle of a file.");
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") { pax = parsePax(data); continue; }
    if (type === "g") continue;
    if (type === "L") { longName = readString(data, 0, data.length); continue; }

    const magic = readString(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(header, 345, 155) : "";
    const ustarName = readString(header, 0, 100);
    const rawPath = pax.path ?? longName ?? (prefix ? `${prefix}/${ustarName}` : ustarName);
    pax = {};
    longName = null;

    if (type !== "0" && type !== "7" && type !== "5") {
      const what = TYPE_NAMES[type] ?? `"${type}" entry`;
      throw new TarError("unsafe_entry", `The package holds a ${what} ("${rawPath.slice(0, 120)}"), which an app package may not.`);
    }
    const entryPath = safeEntryPath(rawPath);
    if (entryPath === null) continue;
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12);
    byPath.set(entryPath, type === "5"
      ? { path: entryPath, type: "dir", mode: 0o755, mtime }
      : { path: entryPath, type: "file", mode: mode & 0o111 ? 0o755 : 0o644, mtime, data });
    if (byPath.size > limits.maxEntries) {
      throw new TarError("too_large", `The package holds more than ${limits.maxEntries} files.`);
    }
  }
  return [...byPath.values()];
}
