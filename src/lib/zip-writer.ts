/**
 * A streaming ZIP writer, for the run-history exports (TASK-1178).
 *
 * The box had no zip library, and an export of a run history can be gigabytes
 * of screenshots and transcripts on a board with a few gigabytes of memory, so
 * nothing here holds a file whole: every entry is read from disk in chunks and
 * yielded as it is written, and the caller hands the chunks straight to the
 * HTTP response. Sizes and CRCs travel in a data descriptor after each entry
 * (general-purpose flag bit 3), which is what lets a file be written in the
 * same pass that reads it.
 *
 * ZIP64 where the numbers need it — an entry of 4 GiB or more, an offset past
 * 4 GiB, more than 65 535 entries — and the plain format everywhere else, so a
 * small export opens in every unzipper there is.
 *
 * Already-compressed formats (pictures, audio, archives) are STORED; text is
 * DEFLATED. A transcript shrinks five- to tenfold, a PNG not at all, and
 * deflating it would only spend the board's CPU.
 */
import fs from "fs";
import zlib from "zlib";
import path from "@/lib/runtime-path";

/** One file to put in the archive. */
export type ZipSource =
  | {
    /** The name inside the archive: forward slashes, no leading slash. */
    name: string;
    /** A file on disk. Opened O_NOFOLLOW; a file that has become a link is skipped. */
    file: string;
    /** The size the walk saw. Exactly this many bytes are read, at most. */
    size: number;
    mtimeMs: number;
  }
  | {
    name: string;
    /** Bytes built in memory — a manifest, a record. */
    data: Buffer;
    mtimeMs: number;
  };

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;

const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** 2.0 — deflate and descriptors; 4.5 — ZIP64. */
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** Unix, spec 4.5: the external attributes carry a Unix mode. */
const VERSION_MADE_BY = (3 << 8) | VERSION_ZIP64;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

/**
 * An entry this large (or larger) is written with a ZIP64 local header. Only
 * stored entries can reach it: deflate is skipped past DEFLATE_MAX_BYTES, so a
 * deflated entry's output can never overrun the 32-bit fields it promised.
 */
const ZIP64_ENTRY_BYTES = MAX32;
/** Past this a file is stored even when it would compress: see above. */
const DEFLATE_MAX_BYTES = 512 * 1024 * 1024;

/** Extensions whose bytes are already compressed. */
const STORED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".mp3", ".ogg", ".opus", ".m4a", ".aac", ".mp4", ".webm", ".mov",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".pdf", ".woff", ".woff2",
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32, continued from `value`. zlib's own when this Node has it (22.2+ and
 * the box's 24 do), the table otherwise — the answer is the same either way.
 */
export function crc32(data: Buffer, value = 0): number {
  const native = (zlib as unknown as { crc32?: (d: Buffer, v?: number) => number }).crc32;
  if (typeof native === "function") return native(data, value) >>> 0;
  let c = (value ^ MAX32) >>> 0;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

/** MS-DOS time and date. The format starts in 1980, so anything earlier is 1980. */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * An archive-safe entry name: forward slashes, no leading slash, no `.` or
 * `..` segment, no empty segment. The walkers build names from paths they
 * listed themselves, so this is the floor under them rather than the check.
 */
export function zipEntryName(name: string): string | null {
  const parts = name.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

interface CentralRecord {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  zip64Local: boolean;
}

function localHeader(name: Buffer, method: number, time: number, date: number, zip64: boolean): Buffer {
  const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
  if (zip64) {
    // Sizes are in the descriptor; the extra field only announces that the
    // descriptor's sizes are 8 bytes wide.
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
  }
  const head = Buffer.alloc(30);
  head.writeUInt32LE(SIG_LOCAL, 0);
  head.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
  head.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
  head.writeUInt16LE(method, 8);
  head.writeUInt16LE(time, 10);
  head.writeUInt16LE(date, 12);
  head.writeUInt32LE(0, 14);
  head.writeUInt32LE(zip64 ? MAX32 : 0, 18);
  head.writeUInt32LE(zip64 ? MAX32 : 0, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(extra.length, 28);
  return Buffer.concat([head, name, extra]);
}

function descriptor(crc: number, compressed: number, uncompressed: number, zip64: boolean): Buffer {
  if (zip64) {
    const buf = Buffer.alloc(24);
    buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
    buf.writeUInt32LE(crc, 4);
    buf.writeBigUInt64LE(BigInt(compressed), 8);
    buf.writeBigUInt64LE(BigInt(uncompressed), 16);
    return buf;
  }
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
  buf.writeUInt32LE(crc, 4);
  buf.writeUInt32LE(compressed, 8);
  buf.writeUInt32LE(uncompressed, 12);
  return buf;
}

function centralHeader(rec: CentralRecord): Buffer {
  const bigUncompressed = rec.uncompressed >= MAX32;
  const bigCompressed = rec.compressed >= MAX32;
  const bigOffset = rec.offset >= MAX32;
  const fields: number[] = [];
  if (bigUncompressed) fields.push(rec.uncompressed);
  if (bigCompressed) fields.push(rec.compressed);
  if (bigOffset) fields.push(rec.offset);
  const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
  if (fields.length) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(fields.length * 8, 2);
    fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  }
  const zip64 = rec.zip64Local || fields.length > 0;
  const head = Buffer.alloc(46);
  head.writeUInt32LE(SIG_CENTRAL, 0);
  head.writeUInt16LE(VERSION_MADE_BY, 4);
  head.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
  head.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
  head.writeUInt16LE(rec.method, 10);
  head.writeUInt16LE(rec.time, 12);
  head.writeUInt16LE(rec.date, 14);
  head.writeUInt32LE(rec.crc, 16);
  head.writeUInt32LE(bigCompressed ? MAX32 : rec.compressed, 20);
  head.writeUInt32LE(bigUncompressed ? MAX32 : rec.uncompressed, 24);
  head.writeUInt16LE(rec.name.length, 28);
  head.writeUInt16LE(extra.length, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  // A regular file, rw-r--r--: what the owner unpacks is theirs to open.
  head.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
  head.writeUInt32LE(bigOffset ? MAX32 : rec.offset, 42);
  return Buffer.concat([head, rec.name, extra]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const needs64 = count >= MAX16 || size >= MAX32 || offset >= MAX32;
  const parts: Buffer[] = [];
  if (needs64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(SIG_EOCD64, 0);
    rec.writeBigUInt64LE(BigInt(44), 4);
    rec.writeUInt16LE(VERSION_MADE_BY, 12);
    rec.writeUInt16LE(VERSION_ZIP64, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(size), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_EOCD64_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset + size), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(rec, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Math.min(count, MAX16), 8);
  eocd.writeUInt16LE(Math.min(count, MAX16), 10);
  eocd.writeUInt32LE(Math.min(size, MAX32), 12);
  eocd.writeUInt32LE(Math.min(offset, MAX32), 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);
  return Buffer.concat(parts);
}

/** Should this entry be deflated? Text yes; already-compressed formats and giants no. */
function shouldDeflate(name: string, size: number): boolean {
  if (size === 0 || size > DEFLATE_MAX_BYTES) return false;
  return !STORED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Open a file for the archive, refusing a link. Null when it cannot be opened
 * or is no longer a regular file — the entry is then left out, not failed: an
 * export must not die because a run's evidence changed under it.
 */
async function openRegular(file: string): Promise<fs.promises.FileHandle | null> {
  try {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close().catch(() => {});
      return null;
    }
    return handle;
  } catch {
    return null;
  }
}

/** Options for {@link zipStream}; tests use `forceZip64` to exercise the wide records on small files. */
export interface ZipStreamOptions {
  forceZip64?: boolean;
}

/**
 * The archive, as chunks. Sources are consumed lazily, so the caller can walk
 * a tree while the archive is being sent. Names that are not archive-safe and
 * files that cannot be opened are skipped; a duplicate name keeps the first.
 */
export async function* zipStream(sources: Iterable<ZipSource> | AsyncIterable<ZipSource>, options: ZipStreamOptions = {}): AsyncGenerator<Buffer> {
  const central: CentralRecord[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for await (const source of sources) {
    const safe = zipEntryName(source.name);
    if (!safe || seen.has(safe)) continue;
    const name = Buffer.from(safe, "utf-8");
    if (name.length > MAX16) continue;
    const { time, date } = dosDateTime(source.mtimeMs);

    let handle: fs.promises.FileHandle | null = null;
    let size: number;
    if ("file" in source) {
      handle = await openRegular(source.file);
      if (!handle) continue;
      size = Math.max(0, source.size);
    } else {
      size = source.data.length;
    }
    seen.add(safe);

    const method = shouldDeflate(safe, size) ? METHOD_DEFLATE : METHOD_STORE;
    const zip64Local = options.forceZip64 === true || size >= ZIP64_ENTRY_BYTES;
    const entryOffset = offset;
    const header = localHeader(name, method, time, date, zip64Local);
    offset += header.length;
    yield header;

    let crc = 0;
    let uncompressed = 0;
    let compressed = 0;
    try {
      const chunks: AsyncIterable<Buffer> = handle
        ? readChunks(handle, size)
        : (async function* one() { yield (source as { data: Buffer }).data; })();
      if (method === METHOD_STORE) {
        for await (const chunk of chunks) {
          crc = crc32(chunk, crc);
          uncompressed += chunk.length;
          compressed += chunk.length;
          offset += chunk.length;
          yield chunk;
        }
      } else {
        const deflate = zlib.createDeflateRaw({ level: 6 });
        const feeding = (async () => {
          try {
            for await (const chunk of chunks) {
              crc = crc32(chunk, crc);
              uncompressed += chunk.length;
              if (!deflate.write(chunk)) await new Promise<void>((resolve) => deflate.once("drain", resolve));
            }
            deflate.end();
          } catch (err) {
            deflate.destroy(err as Error);
          }
        })();
        for await (const out of deflate as AsyncIterable<Buffer>) {
          compressed += out.length;
          offset += out.length;
          yield out;
        }
        await feeding;
      }
    } finally {
      await handle?.close().catch(() => {});
    }

    const tail = descriptor(crc, compressed, uncompressed, zip64Local);
    offset += tail.length;
    yield tail;
    central.push({ name, method, time, date, crc, compressed, uncompressed, offset: entryOffset, zip64Local });
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const rec of central) {
    const head = centralHeader(rec);
    cdSize += head.length;
    yield head;
  }
  yield endOfCentralDirectory(central.length, cdSize, cdOffset);
}

/** Exactly `size` bytes of an open file, or fewer if it shrank, in 256 KiB reads. */
async function* readChunks(handle: fs.promises.FileHandle, size: number): AsyncGenerator<Buffer> {
  const CHUNK = 256 * 1024;
  let position = 0;
  while (position < size) {
    const want = Math.min(CHUNK, size - position);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, position);
    if (bytesRead <= 0) return;
    position += bytesRead;
    yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
  }
}

/**
 * The archive as a web ReadableStream, for a route's Response. Pulled, so a
 * slow client slows the disk reads instead of filling the board's memory.
 */
export function zipResponseStream(sources: Iterable<ZipSource> | AsyncIterable<ZipSource>, options?: ZipStreamOptions): ReadableStream<Uint8Array> {
  const chunks = zipStream(sources, options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
