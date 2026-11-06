/**
 * 8-bit vault vectors: how the search index stores a vector in about one byte
 * per dimension instead of four.
 *
 * THE SCHEME (symmetric scalar quantisation, one scale per vector): the vector
 * is scaled so its largest component is ±127 and every component rounded to
 * an int8 in [-127, 127]; the scale kept beside the codes is 1/‖codes‖, so
 * `scale × codes` is the quantised vector at unit length again. A cosine is
 * then `scale × (query · codes)` — the query stays float32 (asymmetric, so
 * only the stored side is rounded) — and a page vector is the mean of its
 * chunks' `scale × codes`.
 *
 * THE BLOB: `[header length h][float32 scale, little-endian][codes…]`, where
 * h is 5, or 6 (one zero pad byte before the scale) when 5 + dims would be a
 * multiple of 4. So an 8-bit blob is NEVER a multiple of 4 bytes long, and a
 * float32 blob (the format before this one) ALWAYS is: a row's format is told
 * by its length alone, which is what lets the store be migrated row by row and
 * a crash part-way be picked up where it stopped. It also keeps a build from
 * before the 8-bit index from misreading the new rows: their length is no
 * float32 vector's, so that build skips them rather than reading noise.
 *
 * Pure: no sqlite, no I/O.
 */

/** The largest code magnitude: [-127, 127], symmetric, so -128 is never used. */
export const Q8_MAX = 127;

export interface Q8Vector {
  codes: Int8Array;
  /** 1/‖codes‖: `scale × codes` is unit length. 0 for an all-zero vector. */
  scale: number;
}

/** The header in front of the codes of a vector `dims` wide (5 or 6 bytes, see the module comment). */
export function q8HeaderBytes(dims: number): number {
  return (5 + dims) % 4 === 0 ? 6 : 5;
}

/** What one stored vector `dims` wide costs on disk: the codes, the scale, the header byte (and a pad byte). */
export function q8BlobBytes(dims: number): number {
  return dims + q8HeaderBytes(dims);
}

/** Quantise a vector (any length; it is normalised first) to int8 codes and a per-vector scale. */
export function quantizeQ8(vec: ArrayLike<number>): Q8Vector {
  const codes = new Int8Array(vec.length);
  let max = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (Number.isFinite(a) && a > max) max = a;
  }
  if (max === 0) return { codes, scale: 0 };
  const k = Q8_MAX / max;
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number.isFinite(vec[i]) ? vec[i] : 0;
    const c = Math.max(-Q8_MAX, Math.min(Q8_MAX, Math.round(v * k)));
    codes[i] = c;
    sum += c * c;
  }
  return { codes, scale: sum > 0 ? Math.fround(1 / Math.sqrt(sum)) : 0 };
}

/** The blob a vector is stored as. */
export function encodeQ8Blob(vec: ArrayLike<number>): Uint8Array {
  const { codes, scale } = quantizeQ8(vec);
  const header = q8HeaderBytes(codes.length);
  const out = new Uint8Array(header + codes.length);
  out[0] = header;
  new DataView(out.buffer).setFloat32(header - 4, scale, true);
  out.set(new Uint8Array(codes.buffer, codes.byteOffset, codes.byteLength), header);
  return out;
}

/** Is this blob a float32 vector (the format before the 8-bit one)? */
export function isFloat32Blob(blob: Uint8Array): boolean {
  return blob.byteLength > 0 && blob.byteLength % Float32Array.BYTES_PER_ELEMENT === 0;
}

/** A float32 blob as a vector (a copy: sqlite's buffer need not be aligned). */
export function float32FromBlob(blob: Uint8Array): Float32Array {
  const out = new Float32Array(blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
  new Uint8Array(out.buffer).set(blob);
  return out;
}

/**
 * A stored vector of either format, as codes and a scale: an 8-bit blob as it
 * is (the codes are a view into the blob), a float32 one quantised on the way.
 * Null for a blob that is neither (empty, a header that does not add up).
 */
export function decodeVectorBlob(blob: Uint8Array): Q8Vector | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return null;
  if (isFloat32Blob(blob)) return quantizeQ8(float32FromBlob(blob));
  const header = blob[0];
  if (header !== 5 && header !== 6) return null;
  const dims = blob.byteLength - header;
  if (dims <= 0 || q8HeaderBytes(dims) !== header) return null;
  const scale = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getFloat32(header - 4, true);
  if (!Number.isFinite(scale) || scale < 0) return null;
  return { codes: new Int8Array(blob.buffer, blob.byteOffset + header, dims), scale };
}

/** How many dimensions a stored vector of either format has (0 for one that does not decode). */
export function vectorBlobDims(blob: Uint8Array): number {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return 0;
  if (isFloat32Blob(blob)) return blob.byteLength / Float32Array.BYTES_PER_ELEMENT;
  const header = blob[0];
  const dims = blob.byteLength - header;
  return (header === 5 || header === 6) && dims > 0 && q8HeaderBytes(dims) === header ? dims : 0;
}

/** `scale × codes` as float32, added onto `into` when given (for a mean), else into a new array. */
export function dequantizeQ8(q: Q8Vector, into?: Float32Array): Float32Array {
  const out = into ?? new Float32Array(q.codes.length);
  const n = Math.min(out.length, q.codes.length);
  if (into) for (let i = 0; i < n; i++) out[i] += q.codes[i] * q.scale;
  else for (let i = 0; i < n; i++) out[i] = q.codes[i] * q.scale;
  return out;
}

/** The cosine of a unit float32 query with row `row` of a packed code matrix `dims` wide. */
export function dotQ8(query: Float32Array, codes: Int8Array, row: number, dims: number, scale: number): number {
  let s = 0;
  const base = row * dims;
  for (let i = 0; i < dims; i++) s += query[i] * codes[base + i];
  return s * scale;
}
