import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OLLAMA_MAX_MODEL_PARAM_B } from "@/lib/resource-limits";
import { ollamaMaxModelParamB } from "@/lib/ollama-size-cap";

/**
 * The largest Ollama model the picker offers, per host.
 *
 * OLLAMA_MAX_MODEL_PARAM_B (4) is derived from the cgroup cap install.sh puts
 * on ollama.service on a Jetson (50-clawbox-memory.conf, MemoryMax 5632M). A PC
 * installed by install-x64.sh has no such cap — Ollama may use the machine —
 * yet the search still offered nothing above 4B, so a 128 GB DGX Spark could
 * not find a single model worth its memory.
 */
const GB = 1e9;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-ollama-cap-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ollamaMaxModelParamB", () => {
  it("keeps the Jetson's figure wherever ClawBox's memory cap is on ollama.service", () => {
    const dropin = path.join(dir, "50-clawbox-memory.conf");
    writeFileSync(dropin, "[Service]\nMemoryMax=5632M\n");
    expect(ollamaMaxModelParamB(dropin, 130 * GB)).toBe(OLLAMA_MAX_MODEL_PARAM_B);
  });

  it("keeps the Jetson's figure on a Jetson whose drop-in is missing", () => {
    // A skipped or failed resource-limits step must not open 7B pulls on an
    // 8 GB board that shares its memory with the local model and the desktop.
    const tegra = path.join(dir, "nv_tegra_release");
    writeFileSync(tegra, "# R36 (release), REVISION: 4.3\n");
    expect(ollamaMaxModelParamB(path.join(dir, "absent.conf"), 7.4 * GB, tegra)).toBe(OLLAMA_MAX_MODEL_PARAM_B);
  });

  it("offers 120B-class models on an uncapped 128 GB workstation", () => {
    const cap = ollamaMaxModelParamB(path.join(dir, "absent.conf"), 130.6 * GB);
    expect(cap).toBeGreaterThanOrEqual(122);
  });

  it("scales with an uncapped PC's memory", () => {
    const absent = path.join(dir, "absent.conf");
    expect(ollamaMaxModelParamB(absent, 16 * GB)).toBe(16);
    expect(ollamaMaxModelParamB(absent, 32 * GB)).toBe(32);
  });

  it("never offers less than the Jetson's figure", () => {
    expect(ollamaMaxModelParamB(path.join(dir, "absent.conf"), 2 * GB)).toBe(OLLAMA_MAX_MODEL_PARAM_B);
  });
});
