import { describe, expect, it } from "vitest";
import {
  diskVerdict,
  isGgufName,
  isHfRepo,
  isWhisperSize,
  OLLAMA_PRESET_MODELS,
  safeGgufName,
  safeHfRepo,
  safeWhisperSize,
  WHISPER_SIZES,
  whisperSize,
} from "@/lib/local-install";
import { DISK_FREE_RESERVE_BYTES } from "@/lib/disk-reserve";

/**
 * The rule both sides of every install read. The panel refuses a bad reference
 * before it posts and the route refuses it again; these are the cases where the
 * two would otherwise have been free to disagree.
 */
describe("local-install: what may be asked for", () => {
  it("offers only sizes scripts/whisper-server.py can load", () => {
    expect(WHISPER_SIZES.map((s) => s.id)).toEqual(["tiny", "base", "small", "medium"]);
    // large-v3 is a ~3 GB download that does not fit beside the agent model on
    // an 8 GB board: offering it would be offering an install that cannot run.
    expect(isWhisperSize("large-v3")).toBe(false);
    expect(isWhisperSize("base")).toBe(true);
    expect(isWhisperSize("")).toBe(false);
    expect(isWhisperSize(null)).toBe(false);
  });

  it("gives every offered size a download cost, so the disk can be checked first", () => {
    for (const size of WHISPER_SIZES) {
      expect(whisperSize(size.id)?.bytes).toBeGreaterThan(0);
    }
    expect(whisperSize("nonsense")).toBeNull();
  });

  it("takes a Hugging Face repo as owner/name and nothing else", () => {
    expect(isHfRepo("google/gemma-4-E2B-it-qat-q4_0-gguf")).toBe(true);
    expect(isHfRepo("owner/name")).toBe(true);
    expect(isHfRepo("bare-name")).toBe(false);
    expect(isHfRepo("too/many/slashes")).toBe(false);
    expect(isHfRepo("")).toBe(false);
    expect(isHfRepo(42)).toBe(false);
  });

  it("refuses a reference that would escape, or that a downloader would read as a flag", () => {
    expect(isHfRepo("owner/../etc")).toBe(false);
    expect(isHfRepo("../owner")).toBe(false);
    expect(isGgufName("../../etc/passwd.gguf")).toBe(false);
    expect(isGgufName("./model.gguf")).toBe(false);
    // A leading dash is an option to `hf download`, not a name.
    expect(isHfRepo("-oops/name")).toBe(false);
    expect(isGgufName("-rf.gguf")).toBe(false);
  });

  it("takes a .gguf as one path segment, going either way", () => {
    expect(isGgufName("gemma-4-E2B_q4_0-it.gguf")).toBe(true);
    expect(isGgufName("README.md")).toBe(false);
    expect(isGgufName("model.bin")).toBe(false);
    // The SAME rule names a file inside a repository and a file in this box's
    // library: a nested reference downloads to a path the listing would never
    // show and the removal would never accept.
    expect(isGgufName("sub/dir/model.gguf")).toBe(false);
  });

  it("keeps one list of the models the wizard and Settings both offer", () => {
    expect(OLLAMA_PRESET_MODELS.length).toBeGreaterThan(0);
    for (const preset of OLLAMA_PRESET_MODELS) {
      expect(preset.id).toMatch(/^[a-z0-9.:_-]+$/i);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
});

describe("local-install: what a path and a URL are made of", () => {
  // The repo's `safeAppId` rule: a value that reaches `path.join` or `fetch` is
  // REBUILT out of a constant alphabet rather than tested and passed through,
  // so the data flow itself shows the cut.
  it("answers a value made only of the alphabet, character for character", () => {
    const safe = safeHfRepo("google/gemma-4-E2B-it-qat-q4_0-gguf");
    expect(safe).toBe("google/gemma-4-E2B-it-qat-q4_0-gguf");
    expect(safe).toMatch(/^[A-Za-z0-9._/-]+$/);
    // One character outside it and nothing comes back — there is no partial
    // answer to strip and pass on.
    expect(safeHfRepo("google/gemma\u0000-4")).toBeNull();
    expect(safeHfRepo("owner/na me")).toBeNull();
    expect(safeHfRepo("owner/naméé")).toBeNull();
  });

  it("answers the catalogue's own size string for a Whisper pick", () => {
    const safe = safeWhisperSize("small");
    expect(safe).toBe("small");
    expect(safe).toBe(WHISPER_SIZES.find((s) => s.id === "small")?.id);
    expect(safeWhisperSize("large-v3")).toBeNull();
    expect(safeWhisperSize(null)).toBeNull();
  });

  it("answers null for everything the predicates refuse", () => {
    for (const bad of ["owner/../etc", "-oops/name", "too/many/slashes", "bare", "", 7]) {
      expect(safeHfRepo(bad)).toBeNull();
    }
    for (const bad of ["../x.gguf", "-rf.gguf", "README.md", "", "sub/model.gguf", ".."]) {
      expect(safeGgufName(bad)).toBeNull();
    }
  });

  it("refuses a reference longer than any real one", () => {
    expect(safeHfRepo(`${"a".repeat(300)}/name`)).toBeNull();
  });
});

describe("local-install: does it fit", () => {
  const GB = 1024 * 1024 * 1024;

  it("counts the box-wide reserve against the download", () => {
    const verdict = diskVerdict(GB, 2 * GB, DISK_FREE_RESERVE_BYTES);
    expect(verdict.ok).toBe(true);
    expect(verdict.shortfallBytes).toBe(0);
  });

  it("refuses when the reserve is what the download would eat", () => {
    // 1.2 GB free, a 1 GB download: it "fits" only by spending the margin the
    // in-app update's build needs.
    const verdict = diskVerdict(GB, Math.round(1.2 * GB), DISK_FREE_RESERVE_BYTES);
    expect(verdict.ok).toBe(false);
    expect(verdict.shortfallBytes).toBeGreaterThan(0);
  });

  it("does not refuse when the disk will not say", () => {
    // statfs failing is a fault in the measurement, not a full disk; refusing
    // every install on a box whose filesystem does not report is the worse
    // outcome, and the same judgement the upload route makes.
    const verdict = diskVerdict(100 * GB, null, DISK_FREE_RESERVE_BYTES);
    expect(verdict.ok).toBe(true);
    expect(verdict.freeBytes).toBeNull();
  });
});
