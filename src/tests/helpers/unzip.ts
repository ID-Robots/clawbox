/**
 * A ZIP READER for tests — the other half of src/lib/zip-writer.ts, written
 * from the format rather than from the writer, so a test that round-trips
 * through it checks the bytes a real unzipper would read: the end of central
 * directory (ZIP64 included), each central record, its local header, the
 * entry's bytes inflated where they were deflated, and the CRC-32 recomputed.
 */
import zlib from "zlib";

export interface UnzippedEntry {
  name: string;
  data: Buffer;
  method: number;
  /** The local header announced ZIP64 sizes (the writer's wide descriptor). */
  zip64Local: boolean;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Every entry of a ZIP, in central-directory order. Throws on any inconsistency. */
export function unzip(zip: Buffer): UnzippedEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end of central directory");
  let count = zip.readUInt16LE(eocd + 10);
  let cdSize = zip.readUInt32LE(eocd + 12);
  let cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (zip.readUInt32LE(locator) !== 0x07064b50) throw new Error("no ZIP64 locator");
    const rec = Number(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(rec) !== 0x06064b50) throw new Error("no ZIP64 end record");
    count = Number(zip.readBigUInt64LE(rec + 32));
    cdSize = Number(zip.readBigUInt64LE(rec + 40));
    cdOffset = Number(zip.readBigUInt64LE(rec + 48));
  }
  const out: UnzippedEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    let compressed = zip.readUInt32LE(p + 20);
    let size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    let offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf-8");
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e < extraEnd) {
      const id = zip.readUInt16LE(e);
      const len = zip.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(zip.readBigUInt64LE(q)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(zip.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(zip.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localNameLen = zip.readUInt16LE(offset + 26);
    const localExtraLen = zip.readUInt16LE(offset + 28);
    const zip64Local = localExtraLen >= 4 && zip.readUInt16LE(offset + 30 + localNameLen) === 0x0001;
    const start = offset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(start, start + compressed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : (() => { throw new Error(`method ${method}`); })();
    if (data.length !== size) throw new Error(`${name}: size ${data.length} != ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: bad CRC`);
    // The descriptor after the data must agree with the central record.
    const d = start + compressed;
    if (zip.readUInt32LE(d) !== 0x08074b50) throw new Error(`${name}: no data descriptor`);
    if (zip.readUInt32LE(d + 4) !== crc) throw new Error(`${name}: descriptor CRC differs`);
    const descSize = zip64Local ? Number(zip.readBigUInt64LE(d + 16)) : zip.readUInt32LE(d + 12);
    if (descSize !== size) throw new Error(`${name}: descriptor size differs`);
    out.push({ name, data, method, zip64Local });
    p = extraEnd + commentLen;
  }
  if (p !== cdOffset + cdSize) throw new Error("central directory size mismatch");
  return out;
}

/** Collect a web ReadableStream into one Buffer. */
export async function readAllStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
