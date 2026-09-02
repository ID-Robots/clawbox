import { describe, it, expect, vi, beforeEach } from "vitest";

// The owner's wizard step (POST /setup-api/clawkeep/memory/provider) writes the
// embedding choice through the OpenClaw CLI. OpenClaw 2 (2026.8+) moved that
// choice from agents.defaults.memorySearch.* to memory.search.* and refuses
// the retired path outright ("moved to memory.search. Run openclaw doctor
// --fix"), so on every shipping box the write 500'd with that message. The
// key names must follow the installed core, read from the same package.json
// scripts/ensure-local-embeddings.sh reads at boot.

const OPENCLAW_PACKAGE_JSON = "/home/clawbox/.npm-global/lib/node_modules/openclaw/package.json";

const { runOpenclawConfigSetBatch, readFile } = vi.hoisted(() => ({
  runOpenclawConfigSetBatch: vi.fn(async () => ""),
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("fs/promises", () => ({ readFile }));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
}));
vi.mock("@/lib/openclaw-config", () => ({
  readConfig: vi.fn(async () => ({})),
  runOpenclawConfigSetBatch,
  // The npm --prefix layout of /home/clawbox/.npm-global on the box.
  findOpenclawBin: () => "/home/clawbox/.npm-global/bin/openclaw",
}));

import { embeddingConfigHome, switchToLocalEmbeddings } from "@/lib/memory-shard";
import { LOCAL_EMBEDDING_MODEL } from "@/lib/memory-shard-state";

const V2_OPS = [
  ["memory.search.provider", "ollama"],
  ["memory.search.model", LOCAL_EMBEDDING_MODEL],
];
const LEGACY_OPS = [
  ["agents.defaults.memorySearch.provider", "ollama"],
  ["agents.defaults.memorySearch.model", LOCAL_EMBEDDING_MODEL],
];

function installedCore(version: string): void {
  readFile.mockResolvedValue(JSON.stringify({ name: "openclaw", version }));
}

beforeEach(() => {
  runOpenclawConfigSetBatch.mockClear();
  readFile.mockReset();
});

describe("embeddingConfigHome", () => {
  it("names OpenClaw 2's memory.search home from 2026.8 on", () => {
    for (const version of ["2026.8.1", "2026.8.0", "2026.12.3", "2027.1.0"]) {
      expect(embeddingConfigHome(version)).toBe("memory.search");
    }
  });

  it("keeps the legacy agents.defaults.memorySearch home for earlier cores", () => {
    for (const version of ["2026.7.12", "2025.12.1"]) {
      expect(embeddingConfigHome(version)).toBe("agents.defaults.memorySearch");
    }
  });

  it("assumes the generation ClawBox pins when the version cannot be read", () => {
    expect(embeddingConfigHome(null)).toBe("memory.search");
    expect(embeddingConfigHome("garbage")).toBe("memory.search");
  });
});

describe("switchToLocalEmbeddings", () => {
  it("writes memory.search.* on an OpenClaw 2 core, as one batch", async () => {
    installedCore("2026.8.1");
    await switchToLocalEmbeddings();
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith(V2_OPS);
  });

  it("writes the legacy keys on a core older than 2026.8", async () => {
    installedCore("2026.7.12");
    await switchToLocalEmbeddings();
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith(LEGACY_OPS);
  });

  it("reads the core's own package.json, the file the boot script reads — never `openclaw --version`", async () => {
    installedCore("2026.8.1");
    await switchToLocalEmbeddings();
    expect(readFile).toHaveBeenCalledWith(OPENCLAW_PACKAGE_JSON, "utf-8");
    // The only CLI call is the write itself.
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the pinned generation when there is no package.json to read", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await switchToLocalEmbeddings();
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith(V2_OPS);
  });

  it("falls back to the pinned generation when the package.json has no version", async () => {
    readFile.mockResolvedValue("{ not json");
    await switchToLocalEmbeddings();
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith(V2_OPS);
  });
});
