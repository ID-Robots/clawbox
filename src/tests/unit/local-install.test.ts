import { describe, expect, it } from "vitest";
import {
  diskVerdict,
  isHfGgufFile,
  isHfRepo,
  isLocalGgufName,
  isWhisperSize,
  OLLAMA_PRESET_MODELS,
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
    expect(isHfGgufFile("../../etc/passwd.gguf")).toBe(false);
    expect(isHfGgufFile("./model.gguf")).toBe(false);
    // A leading dash is an option to `hf download`, not a name.
    expect(isHfRepo("-oops/name")).toBe(false);
    expect(isHfGgufFile("-rf.gguf")).toBe(false);
    expect(isLocalGgufName("-rf.gguf")).toBe(false);
  });

  it("takes only a .gguf as the file, and only a plain name as a local one", () => {
    expect(isHfGgufFile("gemma-4-E2B_q4_0-it.gguf")).toBe(true);
    expect(isHfGgufFile("sub/dir/model.gguf")).toBe(true);
    expect(isHfGgufFile("README.md")).toBe(false);
    // The DELETE target addresses something already on disk: no directory part.
    expect(isLocalGgufName("model.gguf")).toBe(true);
    expect(isLocalGgufName("sub/model.gguf")).toBe(false);
    expect(isLocalGgufName("model.bin")).toBe(false);
  });

  it("keeps one list of the models the wizard and Settings both offer", () => {
    expect(OLLAMA_PRESET_MODELS.length).toBeGreaterThan(0);
    for (const preset of OLLAMA_PRESET_MODELS) {
      expect(preset.id).toMatch(/^[a-z0-9.:_-]+$/i);
      expect(preset.label.length).toBeGreaterThan(0);
    }
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
