/**
 * Why the memory index wants a pass, and what a full one costs
 * (src/lib/memory-reindex-advice.ts): the reading the status route adds, so
 * the assistant can tell an incremental fix from a full re-embed. Synthetic
 * readings only.
 */
import { describe, expect, it } from "vitest";
import { estimateFullReindex, memoryReindexAdvice, TOKENS_PER_CHUNK, type MemoryStatusFacts } from "@/lib/memory-reindex-advice";

const HEALTHY: MemoryStatusFacts = {
  available: true,
  location: "local",
  indexIdentity: "valid",
  indexIdentityCode: "",
  errorCode: "",
  sourceCount: 2,
  files: 120,
  chunks: 3_000,
  pendingFiles: 0,
  dirty: false,
  run: { status: "succeeded", mode: "incremental", errorCode: "" },
};

const codes = (s: MemoryStatusFacts, arm: "local" | "openclaw" = "local") => memoryReindexAdvice(s, arm).reasons.map((r) => r.code);

describe("memoryReindexAdvice", () => {
  it("wants nothing of a healthy index", () => {
    expect(memoryReindexAdvice(HEALTHY, "local")).toEqual({ needed: false, mode: null, reasons: [] });
  });

  it("invents nothing from a probe that failed", () => {
    expect(memoryReindexAdvice({ ...HEALTHY, available: false, chunks: 0, indexIdentity: "missing" }, "local").needed).toBe(false);
  });

  it("calls a first build a full pass, and an empty box with no folders nothing", () => {
    expect(memoryReindexAdvice({ ...HEALTHY, chunks: 0, files: 0, indexIdentity: "missing" }, "local")).toMatchObject({ needed: true, mode: "full", reasons: [{ code: "no_index" }] });
    expect(memoryReindexAdvice({ ...HEALTHY, chunks: 0, files: 0, sourceCount: 0, indexIdentity: "missing" }, "local").needed).toBe(false);
  });

  it("wants nothing of folders a finished pass found nothing to index in", () => {
    // The index vouches for an empty scan (identity valid, zero chunks); a
    // second pass would read the same zero files.
    expect(memoryReindexAdvice({ ...HEALTHY, chunks: 0, files: 0, indexIdentity: "valid" }, "local")).toEqual({ needed: false, mode: null, reasons: [] });
  });

  it("tells an embedder change from an update's new chunking", () => {
    const local = memoryReindexAdvice({ ...HEALTHY, indexIdentity: "mismatched" }, "local");
    expect(local).toMatchObject({ needed: true, mode: "full", reasons: [{ code: "embedder_changed", mode: "full" }] });
    expect(local.reasons[0].detail).toMatch(/provider was switched, or an update changed the format/);
    expect(codes({ ...HEALTHY, indexIdentity: "mismatched", indexIdentityCode: "chunking-changed" }, "openclaw")).toEqual(["index_format_changed"]);
    expect(codes({ ...HEALTHY, indexIdentity: "mismatched", indexIdentityCode: "provider-changed" }, "openclaw")).toEqual(["embedder_changed"]);
  });

  it("says a missing identity over a built index needs a full pass", () => {
    expect(codes({ ...HEALTHY, indexIdentity: "missing" })).toEqual(["identity_missing"]);
  });

  it("sends new files, changed files and a stopped pass to an incremental pass", () => {
    const waiting = memoryReindexAdvice({ ...HEALTHY, pendingFiles: 7 }, "local");
    expect(waiting).toMatchObject({ needed: true, mode: "incremental", reasons: [{ code: "files_waiting", mode: "incremental" }] });
    expect(waiting.reasons[0].detail).toMatch(/^7 files in the folders are not in the index yet/);
    expect(memoryReindexAdvice({ ...HEALTHY, pendingFiles: 1 }, "local").reasons[0].detail).toMatch(/^1 file in the folders is not/);
    expect(codes({ ...HEALTHY, dirty: true }, "openclaw")).toEqual(["files_changed"]);
    expect(codes({ ...HEALTHY, run: { status: "failed", errorCode: "interrupted" } })).toEqual(["last_pass_stopped"]);
    expect(codes({ ...HEALTHY, run: { status: "failed", errorCode: "timed_out" } })).toEqual(["last_pass_stopped"]);
  });

  it("never sends a stopped FULL pass to an incremental one", () => {
    // A full pass stopped part-way is finished only by a new full pass; what
    // it left behind (a missing identity here) is the reason that says so.
    expect(codes({ ...HEALTHY, run: { status: "failed", mode: "full", errorCode: "interrupted" } })).toEqual([]);
    expect(memoryReindexAdvice({ ...HEALTHY, indexIdentity: "missing", run: { status: "failed", mode: "full", errorCode: "interrupted" } }, "local"))
      .toMatchObject({ mode: "full", reasons: [{ code: "identity_missing" }] });
  });

  it("reads `dirty` on ClawBox's own index as the size ceiling, which no pass fixes", () => {
    expect(memoryReindexAdvice({ ...HEALTHY, dirty: true }, "local")).toMatchObject({ needed: false, mode: null, reasons: [{ code: "size_ceiling", mode: "none" }] });
  });

  it("names a fallen-back provider without asking for a pass", () => {
    expect(memoryReindexAdvice({ ...HEALTHY, errorCode: "provider_mismatch" }, "openclaw")).toMatchObject({ needed: false, reasons: [{ code: "provider_fell_back", mode: "none" }] });
  });

  it("asks for the full pass when one reason needs it and another only an incremental one", () => {
    const both = memoryReindexAdvice({ ...HEALTHY, indexIdentity: "mismatched", pendingFiles: 3 }, "local");
    expect(both.mode).toBe("full");
    expect(both.reasons.map((r) => r.code)).toEqual(["embedder_changed", "files_waiting"]);
  });
});

describe("estimateFullReindex", () => {
  it("counts the files indexed and waiting, and the tokens of what is indexed", () => {
    const e = estimateFullReindex({ ...HEALTHY, pendingFiles: 20 }, "local");
    expect(e).toMatchObject({ files: 140, chunks: 3_000, embedder: "local", tokens: 3_000 * TOKENS_PER_CHUNK });
    expect(e.cost).toMatch(/^No money/);
    expect(e.basis).toMatch(/rough rate/);
    expect(e.minutes!.low).toBeLessThan(e.minutes!.high);
  });

  it("scales from this box's own last full pass on the same embedder", () => {
    const e = estimateFullReindex({ ...HEALTHY, run: { status: "succeeded", mode: "full", durationMs: 20 * 60_000 } }, "local");
    expect(e.minutes).toEqual({ low: 14, high: 26 });
    expect(e.basis).toMatch(/last full pass took about 20 min/);
  });

  it("does not borrow the other embedder's timing for a provider move", () => {
    const e = estimateFullReindex({ ...HEALTHY, run: { status: "succeeded", mode: "full", durationMs: 20 * 60_000 } }, "cloud", "text-embedding-3-large");
    expect(e.basis).toMatch(/rough rate for the ClawBox AI cloud/);
    expect(e.cost).toMatch(/text-embedding-3-large.*about 900,000 tokens.*ClawBox AI plan/);
  });

  it("says it cannot time a first build rather than guessing", () => {
    const e = estimateFullReindex({ ...HEALTHY, chunks: 0, files: 0, pendingFiles: 50 }, "local");
    expect(e).toMatchObject({ files: 50, chunks: null, tokens: null, minutes: null });
    expect(e.basis).toMatch(/nothing is indexed yet/);
  });
});
