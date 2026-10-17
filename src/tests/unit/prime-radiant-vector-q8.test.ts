/**
 * 8-bit vault vectors (vector-q8.ts): the blob format, the scale, and what
 * the rounding costs — recall@10 against float32 on seeded synthetic sets.
 */
import { describe, expect, it } from "vitest";
import {
  Q8_MAX,
  decodeVectorBlob,
  dequantizeQ8,
  dotQ8,
  encodeQ8Blob,
  float32FromBlob,
  isFloat32Blob,
  q8BlobBytes,
  q8HeaderBytes,
  quantizeQ8,
  vectorBlobDims,
} from "@/lib/prime-radiant/vector-q8";

/** mulberry32: the same numbers on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function float32Blob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/**
 * Mean recall@10 of 8-bit search against float32 over `queries` queries:
 * documents around `clusters` centroids (0 = no structure) with `noise`.
 */
function recallAt10(seed: number, opts: { docs: number; dims: number; queries: number; clusters: number; noise: number }): number {
  const r = rng(seed);
  const { docs: N, dims: D } = opts;
  const centroids = Array.from({ length: opts.clusters }, () => unit(Float32Array.from({ length: D }, () => gauss(r))));
  const docs = Array.from({ length: N }, (_, i) => {
    const c = centroids.length ? centroids[i % centroids.length] : null;
    return unit(Float32Array.from({ length: D }, (_, d) => (c ? c[d] : 0) + (opts.noise * gauss(r)) / Math.sqrt(D)));
  });
  const codes = new Int8Array(N * D);
  const scales = new Float32Array(N);
  docs.forEach((v, i) => {
    const q = decodeVectorBlob(encodeQ8Blob(v))!;
    codes.set(q.codes, i * D);
    scales[i] = q.scale;
  });
  let sum = 0;
  for (let k = 0; k < opts.queries; k++) {
    const near = docs[Math.floor(r() * N)];
    const query = unit(Float32Array.from(near, (x) => x + (0.5 * gauss(r)) / Math.sqrt(D)));
    const exact = docs.map((v, i) => [dot(v, query), i] as const).sort((a, b) => b[0] - a[0]).slice(0, 10).map(([, i]) => i);
    const approx = docs.map((_, i) => [dotQ8(query, codes, i, D, scales[i]), i] as const).sort((a, b) => b[0] - a[0]).slice(0, 10).map(([, i]) => i);
    const truth = new Set(exact);
    sum += approx.filter((i) => truth.has(i)).length / 10;
  }
  return sum / opts.queries;
}

describe("the 8-bit blob", () => {
  it("is the codes, one scale and a header: about one byte a dimension (1,029 bytes at 1,024-d)", () => {
    expect(q8BlobBytes(1024)).toBe(1029);
    expect(q8BlobBytes(768)).toBe(773);
    const v = unit(Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i)));
    const blob = encodeQ8Blob(v);
    expect(blob.byteLength).toBe(1029);
    expect(blob[0]).toBe(5);
    expect(vectorBlobDims(blob)).toBe(1024);
  });

  it("is never a multiple of 4 bytes long, so a float32 row is told apart by its length alone", () => {
    for (let dims = 1; dims <= 1100; dims++) {
      const blob = encodeQ8Blob(new Float32Array(dims).fill(0.5));
      expect(blob.byteLength % 4, `dims ${dims}`).not.toBe(0);
      expect(blob[0]).toBe(q8HeaderBytes(dims));
      expect(isFloat32Blob(blob)).toBe(false);
      expect(vectorBlobDims(blob)).toBe(dims);
      expect(decodeVectorBlob(blob)!.codes.length).toBe(dims);
    }
    expect(isFloat32Blob(float32Blob(new Float32Array(1024)))).toBe(true);
  });

  it("keeps the vector's direction at unit length: codes in [-127, 127], scale × codes of norm 1", () => {
    const r = rng(7);
    for (let k = 0; k < 50; k++) {
      const v = unit(Float32Array.from({ length: 1024 }, () => gauss(r)));
      const q = decodeVectorBlob(encodeQ8Blob(v))!;
      expect(Math.max(...Array.from(q.codes, Math.abs))).toBe(Q8_MAX);
      expect(Array.from(q.codes).every((c) => c >= -127 && c <= 127)).toBe(true);
      const back = dequantizeQ8(q);
      expect(Math.sqrt(dot(back, back))).toBeCloseTo(1, 5);
      // The cosine of the rounded vector with the original.
      expect(dot(back, v)).toBeGreaterThan(0.9999);
    }
  });

  it("scores a query as the float32 cosine does, within 0.002", () => {
    const r = rng(11);
    const D = 1024;
    for (let k = 0; k < 200; k++) {
      const a = unit(Float32Array.from({ length: D }, () => gauss(r)));
      const b = unit(Float32Array.from(a, (x) => x + (gauss(r) * (k % 5)) / Math.sqrt(D)));
      const q = decodeVectorBlob(encodeQ8Blob(b))!;
      expect(Math.abs(dotQ8(a, q.codes, 0, D, q.scale) - dot(a, b))).toBeLessThan(0.002);
    }
  });

  it("reads a float32 blob (a store from before) as the same codes its migration writes", () => {
    const v = unit(Float32Array.from({ length: 1024 }, (_, i) => Math.cos(i * 0.37)));
    const fromFloat = decodeVectorBlob(float32Blob(v))!;
    const fromQ8 = decodeVectorBlob(encodeQ8Blob(float32FromBlob(float32Blob(v))))!;
    expect(Array.from(fromFloat.codes)).toEqual(Array.from(fromQ8.codes));
    expect(fromFloat.scale).toBe(fromQ8.scale);
    expect(vectorBlobDims(float32Blob(v))).toBe(1024);
  });

  it("survives an all-zero or non-finite vector and refuses a blob that does not add up", () => {
    expect(quantizeQ8(new Float32Array(8))).toEqual({ codes: new Int8Array(8), scale: 0 });
    const odd = quantizeQ8(Float32Array.from([NaN, 1, -Infinity, 0.5]));
    expect(Array.from(odd.codes)).toEqual([0, 127, 0, 64]);
    expect(decodeVectorBlob(new Uint8Array(0))).toBeNull();
    expect(decodeVectorBlob(Uint8Array.from([9, 0, 0, 0, 0, 1, 2]))).toBeNull();
    // A header of 6 where 5 is right (and the other way round).
    expect(decodeVectorBlob(Uint8Array.from([6, 0, 0, 0, 0, 0, 1, 2, 3, 4]))).toBeNull();
    expect(vectorBlobDims(Uint8Array.from([5]))).toBe(0);
  });

  it("adds onto a running sum for a page's mean vector", () => {
    const a = decodeVectorBlob(encodeQ8Blob(Float32Array.from([1, 0, 0, 0])))!;
    const b = decodeVectorBlob(encodeQ8Blob(Float32Array.from([0, 1, 0, 0])))!;
    const sum = new Float32Array(4);
    dequantizeQ8(a, sum);
    dequantizeQ8(b, sum);
    [1, 1, 0, 0].forEach((x, i) => expect(sum[i]).toBeCloseTo(x, 6));
  });
});

describe("recall@10, 8-bit against float32 (seeded synthetic sets, 1,024-d)", () => {
  it.each([
    ["no structure", { clusters: 0, noise: Math.sqrt(1024) }],
    ["40 clusters", { clusters: 40, noise: 0.6 }],
    ["40 tight clusters", { clusters: 40, noise: 0.25 }],
  ])("is at least 0.95 with %s", (_label, shape) => {
    const recall = recallAt10(42, { docs: 2000, dims: 1024, queries: 60, ...shape });
    expect(recall).toBeGreaterThanOrEqual(0.95);
  }, 60_000); // 2,000 × 1,024-d docs: a few seconds locally, more on a shared CI runner.
});
