/**
 * TASK-2411: Qwen3-Embedding-4B as a selectable local embedding model beside
 * the 0.6B.
 *
 * Pinned here:
 *  - the catalog, and the bash copy of it the unit's start script and the boot
 *    wiring read (scripts/embed-model-select.sh) — one id, one file, one hash;
 *  - the pick in data/config.json: read defensively by both readers, written
 *    as one entry, and never able to name a path;
 *  - the gate: the 0.6B everywhere, the 4B only on x86 with an NVIDIA GPU and
 *    6 GB free (Q8_0 from 8 GB), refused on a Jetson and on a CPU-only PC;
 *  - the index identity names the model and its width, so a switch is
 *    `embedder_changed`, while an index stamped before the width joined is
 *    still this embedder's;
 *  - the resumable, disk-checked, verified download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  EMBED_HF_FILE,
  EMBED_HF_REPO,
  EMBED_MODEL_ALIAS,
  LOCAL_EMBEDDING_MODELS,
  localEmbeddingVariant,
} from "@/lib/embed-runtime-ids";
import {
  gateLocalEmbeddingModel,
  parseLocalEmbeddingModelOptions,
  type EmbedHardware,
} from "@/lib/local-embedding-gating";
import {
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  MEMORY_SHARD_LOCAL_MODEL_KEY,
  MEMORY_SHARD_LOCAL_QUANT_KEY,
  parseEmbedderChoiceStatus,
} from "@/lib/memory-shard-state";
import { estimateFullReindex } from "@/lib/memory-reindex-advice";

// Real bash processes: room for a loaded CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = path.resolve(__dirname, "../../..");
const SELECT = path.join(ROOT, "scripts/embed-model-select.sh");

/** Run a snippet with the selector sourced; stdout trimmed. */
function bash(snippet: string, env: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", `. "${SELECT}"\n${snippet}`], {
    encoding: "utf-8",
    // Only PATH and what the case sets: an EMBED_* in the runner's own
    // environment must not decide what the selector answers.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as unknown as NodeJS.ProcessEnv,
  }).trim();
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-2411-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the catalog", () => {
  it("keeps the 0.6B as the default slot, with the names and width it always had", () => {
    const spec = LOCAL_EMBEDDING_MODELS.find((m) => m.id === DEFAULT_LOCAL_EMBEDDING_MODEL_ID)!;
    expect(spec.id).toBe(EMBED_MODEL_ALIAS);
    expect(spec.id).toBe(LOCAL_EMBEDDING_MODEL);
    expect(spec.hfRepo).toBe(EMBED_HF_REPO);
    expect(spec.variants[0].file).toBe(EMBED_HF_FILE);
    expect(spec.dimensions).toBe(LOCAL_EMBEDDING_DIMENSIONS);
  });

  it("offers the 4B at 2,560 dimensions as Q8_0 first and Q4_K_M second, Apache-2.0", () => {
    const spec = LOCAL_EMBEDDING_MODELS.find((m) => m.id === "qwen3-embedding-4b")!;
    expect(spec).toMatchObject({ hfRepo: "Qwen/Qwen3-Embedding-4B-GGUF", dimensions: 2560, license: "Apache-2.0" });
    expect(spec.variants.map((v) => v.quant)).toEqual(["Q8_0", "Q4_K_M"]);
    for (const v of spec.variants) {
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(v.file).toMatch(/^Qwen3-Embedding-4B-(Q8_0|Q4_K_M)\.gguf$/);
    }
    // A quant the model does not have is its first (best) variant.
    expect(localEmbeddingVariant("qwen3-embedding-4b", "Q2_K").quant).toBe("Q8_0");
  });

  it("is the same table in bash, row for row", () => {
    for (const spec of LOCAL_EMBEDDING_MODELS) {
      for (const v of spec.variants) {
        const row = bash(`embed_catalog ${spec.id} ${v.quant}`).split(" ");
        expect(row, `${spec.id} ${v.quant}`).toEqual([spec.id, spec.hfRepo, v.file, String(v.bytes), v.sha256, String(spec.dimensions)]);
      }
    }
    expect(() => bash("embed_catalog qwen3-embedding-8b Q8_0")).toThrow();
  });

  it("is what install.sh's embed_model step verifies the shipped 0.6B against", () => {
    const install = fs.readFileSync(path.join(ROOT, "install.sh"), "utf-8");
    const v = LOCAL_EMBEDDING_MODELS[0].variants[0];
    expect(install).toContain(`KNOWN_BYTES=${v.bytes}`);
    expect(install).toContain(`KNOWN_SHA=${v.sha256}`);
  });

  it("keys the pick under the same two words in TS, in the server reader, and in bash", () => {
    expect(MEMORY_SHARD_LOCAL_MODEL_KEY).toBe("memory_shard_local_model");
    expect(MEMORY_SHARD_LOCAL_QUANT_KEY).toBe("memory_shard_local_model_quant");
    const server = fs.readFileSync(path.join(ROOT, "src/lib/embed-server.ts"), "utf-8");
    expect(server).toContain(`LOCAL_MODEL_KEY = "${MEMORY_SHARD_LOCAL_MODEL_KEY}"`);
    expect(server).toContain(`LOCAL_QUANT_KEY = "${MEMORY_SHARD_LOCAL_QUANT_KEY}"`);
    const select = fs.readFileSync(SELECT, "utf-8");
    expect(select).toContain(`c.get("${MEMORY_SHARD_LOCAL_MODEL_KEY}")`);
    expect(select).toContain(`c.get("${MEMORY_SHARD_LOCAL_QUANT_KEY}")`);
  });
});

describe("the pick, as the unit and the boot wiring read it", () => {
  const cfg = (value: unknown) => {
    const file = path.join(tmp, "config.json");
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };

  it("is the default slot for a missing, broken or foreign config", () => {
    expect(bash(`embed_read_selection "${path.join(tmp, "absent.json")}"`)).toBe("qwen3-embedding-0.6b Q8_0");
    expect(bash(`embed_read_selection "${cfg("{not json")}"`)).toBe("qwen3-embedding-0.6b Q8_0");
    expect(bash(`embed_read_selection "${cfg([1, 2])}"`)).toBe("qwen3-embedding-0.6b Q8_0");
    expect(bash(`embed_read_selection "${cfg({ memory_shard_local_model: "../../models/evil.gguf" })}"`)).toBe("qwen3-embedding-0.6b Q8_0");
  });

  it("reads the 4B and its quant", () => {
    const file = cfg({ memory_shard_local_model: "qwen3-embedding-4b", memory_shard_local_model_quant: "Q4_K_M" });
    expect(bash(`embed_read_selection "${file}"`)).toBe("qwen3-embedding-4b Q4_K_M");
    const bad = cfg({ memory_shard_local_model: "qwen3-embedding-4b", memory_shard_local_model_quant: "$(reboot)" });
    expect(bash(`embed_read_selection "${bad}"`)).toBe("qwen3-embedding-4b Q8_0");
  });

  it("takes the 4B's file from the catalog alone, whatever .env says about the default slot", () => {
    const file = cfg({ memory_shard_local_model: "qwen3-embedding-4b", memory_shard_local_model_quant: "Q4_K_M" });
    const out = bash(`embed_apply_selection "${file}"; echo "$EMBED_MODEL_ID|$EMBED_MODEL|$EMBED_HF_REPO|$EMBED_HF_FILE|$EMBED_DIMENSIONS"`, {
      EMBED_MODEL: "custom", EMBED_HF_REPO: "someone/else", EMBED_HF_FILE: "other.gguf",
    });
    expect(out).toBe("qwen3-embedding-4b|qwen3-embedding-4b|Qwen/Qwen3-Embedding-4B-GGUF|Qwen3-Embedding-4B-Q4_K_M.gguf|2560");
  });

  it("leaves the default slot to .env, and vouches only for the shipped file", () => {
    const file = cfg({});
    expect(bash(`embed_apply_selection "${file}"; echo "$EMBED_MODEL|$EMBED_HF_FILE|$EMBED_SHA256"`))
      .toBe(`qwen3-embedding-0.6b|${EMBED_HF_FILE}|${LOCAL_EMBEDDING_MODELS[0].variants[0].sha256}`);
    expect(bash(`embed_apply_selection "${file}"; echo "$EMBED_MODEL|$EMBED_HF_FILE|$EMBED_SHA256"`, { EMBED_HF_FILE: "mine.gguf", EMBED_MODEL: "mine" }))
      .toBe("mine|mine.gguf|");
  });

  it("is what both bash readers source before they decide anything", () => {
    for (const script of ["scripts/start-embed-server.sh", "scripts/ensure-local-embeddings.sh"]) {
      const text = fs.readFileSync(path.join(ROOT, script), "utf-8");
      expect(text, script).toMatch(/embed-model-select\.sh/);
      expect(text, script).toMatch(/embed_apply_selection /);
    }
    // The unit never fetches a picked model inside a proxied request, and never
    // runs one on a Jetson.
    const start = fs.readFileSync(path.join(ROOT, "scripts/start-embed-server.sh"), "utf-8");
    expect(start).toMatch(/nv_tegra_release/);
    expect(start).toMatch(/is not on this box: download it from Settings → Local AI/);
  });
});

describe("the verified fetch in bash", () => {
  function fakeHf(content: string): string {
    const bin = path.join(tmp, "hf");
    fs.writeFileSync(bin, `#!/usr/bin/env bash\ndir=""; while [ $# -gt 0 ]; do [ "$1" = "--local-dir" ] && dir="$2"; shift; done\nprintf '%s' '${content}' > "$dir/m.gguf"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  it("keeps a file that hashes to the catalog's sha256", () => {
    const hf = fakeHf("weights");
    const out = bash(`embed_fetch_verified "${hf}" r m.gguf "${tmp}/m" 7 ${sha("weights")} && echo OK`);
    expect(out).toBe("OK");
    expect(fs.existsSync(path.join(tmp, "m", "m.gguf"))).toBe(true);
  });

  it("deletes one that does not, and says so", () => {
    const hf = fakeHf("tampered");
    const out = bash(`embed_fetch_verified "${hf}" r m.gguf "${tmp}/m" 8 ${sha("weights")} || echo FAILED`);
    expect(out).toMatch(/did not verify[\s\S]*FAILED/);
    expect(fs.existsSync(path.join(tmp, "m", "m.gguf"))).toBe(false);
  });

  it("refuses before fetching when the disk cannot hold it", () => {
    const hf = fakeHf("weights");
    const out = bash(`embed_fetch_verified "${hf}" r m.gguf "${tmp}/m" 999999999999999 "" || echo FAILED`);
    expect(out).toMatch(/not enough disk space[\s\S]*FAILED/);
    expect(fs.existsSync(path.join(tmp, "m", "m.gguf"))).toBe(false);
  });
});

describe("the gate", () => {
  const x86 = (freeMiB: number | null): EmbedHardware => ({
    arch: "x64",
    jetson: false,
    gpu: freeMiB === null ? null : { name: "NVIDIA GeForce RTX 4070", totalMiB: 12282, freeMiB },
  });
  const jetson: EmbedHardware = { arch: "arm64", jetson: true, gpu: null };

  it("never refuses the 0.6B", () => {
    for (const hw of [jetson, x86(null), x86(100), { arch: "arm64", jetson: false, gpu: null }]) {
      expect(gateLocalEmbeddingModel("qwen3-embedding-0.6b", hw)).toMatchObject({ available: true, quant: "Q8_0" });
    }
  });

  it("refuses the 4B on a Jetson Orin Nano Super, with a plain reason", () => {
    const gate = gateLocalEmbeddingModel("qwen3-embedding-4b", jetson);
    expect(gate).toMatchObject({ available: false, reason: "jetson", quant: null });
    expect(gate.detail).toMatch(/Jetson Orin Nano Super/);
    expect(gate.detail).toMatch(/Qwen3-Embedding-0\.6B/);
    // Even as the model a hand-edited config says is active.
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", jetson, { active: true }).available).toBe(false);
  });

  it("refuses it off x86 and on a CPU-only PC", () => {
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", { arch: "arm64", jetson: false, gpu: null }).reason).toBe("not_x86");
    const cpu = gateLocalEmbeddingModel("qwen3-embedding-4b", x86(null));
    expect(cpu).toMatchObject({ available: false, reason: "no_gpu" });
    expect(cpu.detail).toMatch(/hours/);
  });

  it("needs 6 GB of free GPU memory, and fetches Q8_0 from 8 GB, Q4_K_M below", () => {
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", x86(6143))).toMatchObject({ available: false, reason: "gpu_memory" });
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", x86(6143)).detail).toMatch(/6\.0 GB free|has 6\.0 GB/);
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", x86(6144))).toMatchObject({ available: true, quant: "Q4_K_M" });
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", x86(8191))).toMatchObject({ available: true, quant: "Q4_K_M" });
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", x86(8192))).toMatchObject({ available: true, quant: "Q8_0" });
  });

  it("does not refuse the 4B that is already running for the memory its own weights hold", () => {
    expect(gateLocalEmbeddingModel("qwen3-embedding-4b", x86(1500), { active: true })).toMatchObject({ available: true });
  });
});

describe("nvidia-smi", () => {
  it("reads the first GPU, and nothing that is not a reading", async () => {
    const { parseNvidiaSmiGpu } = await import("@/lib/local-embedding-model");
    expect(parseNvidiaSmiGpu("NVIDIA GeForce RTX 2080, 8192, 7189\nNVIDIA T4, 15360, 15000\n"))
      .toEqual({ name: "NVIDIA GeForce RTX 2080", totalMiB: 8192, freeMiB: 7189 });
    expect(parseNvidiaSmiGpu("Orin (nvgpu), [N/A], [N/A]")).toBeNull();
    expect(parseNvidiaSmiGpu("")).toBeNull();
    expect(parseNvidiaSmiGpu("garbage")).toBeNull();
  });
});

describe("the provider status, read defensively", () => {
  it("is the 0.6B and no rows from a server that predates the choice", () => {
    const s = parseEmbedderChoiceStatus({ source: "local", localInstalled: true });
    expect(s).toMatchObject({ localModel: "qwen3-embedding-0.6b", localModels: [] });
  });

  it("keeps known rows only", () => {
    const rows = parseLocalEmbeddingModelOptions([
      { id: "qwen3-embedding-4b", available: false, reason: "jetson", installed: false },
      { id: "elsewhere", available: true },
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "qwen3-embedding-4b", available: false, reason: "jetson", dimensions: 2560 });
  });
});

describe("the pick in data/config.json and the launch spec", () => {
  async function server() {
    vi.stubEnv("CLAWBOX_ROOT", tmp);
    vi.resetModules();
    return import("@/lib/embed-server");
  }

  it("reads the default for an absent or foreign value, and writes id and quant together", async () => {
    const s = await server();
    expect(await s.readActiveLocalEmbeddingModel()).toEqual({ id: "qwen3-embedding-0.6b", quant: "Q8_0" });
    fs.writeFileSync(path.join(tmp, "data", "config.json"), JSON.stringify({ memory_shard_local_model: "qwen3-embedding-9b" }));
    expect((await s.readActiveLocalEmbeddingModel()).id).toBe("qwen3-embedding-0.6b");
    await s.writeActiveLocalEmbeddingModel({ id: "qwen3-embedding-4b", quant: "Q4_K_M" });
    const stored = JSON.parse(fs.readFileSync(path.join(tmp, "data", "config.json"), "utf-8"));
    expect(stored).toMatchObject({ memory_shard_local_model: "qwen3-embedding-4b", memory_shard_local_model_quant: "Q4_K_M" });
    expect(await s.readActiveLocalEmbeddingModel()).toEqual({ id: "qwen3-embedding-4b", quant: "Q4_K_M" });
  });

  it("runs the 4B from the catalog, and the default slot from .env as before", async () => {
    vi.stubEnv("EMBED_HF_FILE", "custom.gguf");
    vi.stubEnv("EMBED_MODEL", "custom");
    const s = await server();
    const fourB = s.getEmbedLaunchSpec({ id: "qwen3-embedding-4b", quant: "Q8_0" });
    expect(fourB).toMatchObject({ modelId: "qwen3-embedding-4b", alias: "qwen3-embedding-4b", hfFile: "Qwen3-Embedding-4B-Q8_0.gguf", dimensions: 2560 });
    expect(fourB.modelPath).toBe(path.join(tmp, "data", "embed", "models", "Qwen3-Embedding-4B-Q8_0.gguf"));
    expect(s.getEmbedLaunchSpec()).toMatchObject({ modelId: "qwen3-embedding-0.6b", alias: "custom", hfFile: "custom.gguf", dimensions: 1024 });
    expect(s.getEmbedLaunchSpec({ id: "qwen3-embedding-0.6b", quant: "Q8_0" }).hfFile).toBe("custom.gguf");
  });
});

describe("the index identity", () => {
  it("names the model and its width, and still owns an index stamped before the width joined", async () => {
    const { embedderIdentity, legacyEmbedderIdentity } = await import("@/lib/memory-index-local");
    const base = { source: "local" as const, provider: "openai-compatible", baseUrl: "http://127.0.0.1/setup-api/local-ai/embed/v1", requestUrl: "", token: null, labelInputs: true };
    const small = { ...base, model: "qwen3-embedding-0.6b", dimensions: 1024 };
    const large = { ...base, model: "qwen3-embedding-4b", dimensions: 2560 };
    expect(embedderIdentity(small)).not.toBe(embedderIdentity(large));
    expect(embedderIdentity(small)).not.toBe(embedderIdentity({ ...small, dimensions: 2560 }));
    // The legacy stamp is the old formula: still model-specific, so accepting
    // it can never pass the 0.6B's index off as the 4B's.
    expect(legacyEmbedderIdentity(small)).not.toBe(legacyEmbedderIdentity(large));
    expect(legacyEmbedderIdentity(small)).not.toBe(embedderIdentity(small));
  });
});

describe("the re-embed estimate for a change of model", () => {
  it("does not reuse the 0.6B's timing for the 4B", () => {
    const status = { files: 100, chunks: 2000, location: "local", model: "qwen3-embedding-0.6b", run: { status: "succeeded", mode: "full", durationMs: 120_000 } };
    const same = estimateFullReindex(status, "local", "qwen3-embedding-0.6b");
    expect(same.basis).toMatch(/last full pass/);
    const other = estimateFullReindex(status, "local", "qwen3-embedding-4b");
    expect(other.basis).not.toMatch(/last full pass/);
    expect(other.basis).toMatch(/qwen3-embedding-4b/);
  });
});

describe("the verified download", () => {
  const variant = (content: string) => ({
    quant: "Q8_0" as const,
    file: "m.gguf",
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  function hub(content: string, opts: { ignoreRange?: boolean; status?: number } = {}) {
    const calls: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push(headers);
      if (opts.status) return new Response("no", { status: opts.status });
      const m = /^bytes=(\d+)-$/.exec(headers.Range ?? "");
      if (m && !opts.ignoreRange) return new Response(content.slice(Number(m[1])), { status: 206 });
      return new Response(content, { status: 200 });
    });
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it("fetches, verifies and only then puts the file where the embedder looks", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    const { fetchImpl } = hub("the weights");
    const progress: number[] = [];
    const dest = await fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1e12, onProgress: (c) => progress.push(c) });
    expect(fs.readFileSync(dest, "utf-8")).toBe("the weights");
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(11);
  });

  it("resumes a part with a Range request", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    fs.writeFileSync(path.join(tmp, "m.gguf.part"), "the ");
    const { calls, fetchImpl } = hub("the weights");
    await fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1e12 });
    expect(calls[0].Range).toBe("bytes=4-");
    expect(fs.readFileSync(path.join(tmp, "m.gguf"), "utf-8")).toBe("the weights");
  });

  it("starts over when the server ignores the Range", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    fs.writeFileSync(path.join(tmp, "m.gguf.part"), "xxxx");
    const { fetchImpl } = hub("the weights", { ignoreRange: true });
    await fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1e12 });
    expect(fs.readFileSync(path.join(tmp, "m.gguf"), "utf-8")).toBe("the weights");
  });

  it("deletes what does not verify and leaves nothing in place", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    const { fetchImpl } = hub("the wrong!!");
    await expect(fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1e12 }))
      .rejects.toThrow(/did not verify/);
    expect(fs.existsSync(path.join(tmp, "m.gguf"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "m.gguf.part"))).toBe(false);
  });

  it("refuses before a byte is fetched when the disk cannot hold it", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    const { calls, fetchImpl } = hub("the weights");
    await expect(fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1000 }))
      .rejects.toThrow(/Not enough disk space/);
    expect(calls).toHaveLength(0);
  });

  it("keeps a short part for the next attempt", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    const { fetchImpl } = hub("the wei");
    await expect(fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1e12 }))
      .rejects.toThrow(/resume/);
    expect(fs.readFileSync(path.join(tmp, "m.gguf.part"), "utf-8")).toBe("the wei");
  });

  it("says what the Hub answered when it refuses", async () => {
    const { fetchVerifiedGguf } = await import("@/lib/embed-model-fetch");
    const { fetchImpl } = hub("x", { status: 503 });
    await expect(fetchVerifiedGguf({ repo: "r", variant: variant("the weights"), dir: tmp, fetchImpl, freeBytes: async () => 1e12 }))
      .rejects.toThrow(/HTTP 503/);
  });
});
