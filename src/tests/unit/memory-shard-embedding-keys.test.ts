import { describe, it, expect, vi, beforeEach } from "vitest";

// The owner's wizard step (POST /setup-api/clawkeep/memory/provider) writes the
// embedding choice through the OpenClaw CLI. OpenClaw 2 (2026.8+) moved that
// choice from agents.defaults.memorySearch.* to memory.search.* and refuses
// the retired path outright ("moved to memory.search. Run openclaw doctor
// --fix"), so on every shipping box the write 500'd with that message. The
// key names must follow the installed core, read from the same package.json
// scripts/ensure-local-embeddings.sh reads at boot.
//
// The embedder moved off ollama onto ClawBox's own llama.cpp behind the
// local-AI proxy: the write now carries the proxy URL, the service bearer and
// the two input-type labels the proxy restores the query instruction from.

const OPENCLAW_PACKAGE_JSON = "/home/clawbox/.npm-global/lib/node_modules/openclaw/package.json";
const PROXY_URL = "http://127.0.0.1/setup-api/local-ai/embed/v1";
const TOKEN = "t".repeat(64);

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
vi.mock("@/lib/embed-server", () => ({
  getEmbedProxyBaseUrl: () => PROXY_URL,
}));
vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: () => TOKEN,
}));

import { embeddingConfigHome, switchToLocalEmbeddings } from "@/lib/memory-shard";
import { LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_PROVIDER } from "@/lib/memory-shard-state";

/** Everything the embedder needs, and the provider LAST — the switch itself. */
function ops(home: string) {
  return [
    [`${home}.model`, LOCAL_EMBEDDING_MODEL],
    [`${home}.remote.baseUrl`, PROXY_URL],
    [`${home}.remote.apiKey`, TOKEN],
    [`${home}.queryInputType`, "query"],
    [`${home}.documentInputType`, "document"],
    [`${home}.provider`, LOCAL_EMBEDDING_PROVIDER],
  ];
}
const V2_OPS = ops("memory.search");
const LEGACY_OPS = ops("agents.defaults.memorySearch");

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
  it("writes memory.search.* on an OpenClaw 2 core, as one batch, provider last", async () => {
    installedCore("2026.8.1");
    await switchToLocalEmbeddings();
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledTimes(1);
    expect(runOpenclawConfigSetBatch).toHaveBeenCalledWith(V2_OPS);
  });

  it("points OpenClaw at the proxy with the service bearer, never at the server's own port", () => {
    // The proxy is what wakes the unit; the bare port is asleep most of the day.
    const remote = Object.fromEntries(V2_OPS.filter(([k]) => k.includes(".remote.")));
    expect(remote["memory.search.remote.baseUrl"]).toBe(PROXY_URL);
    expect(remote["memory.search.remote.apiKey"]).toBe(TOKEN);
    expect(LOCAL_EMBEDDING_PROVIDER).toBe("openai-compatible");
    expect(LOCAL_EMBEDDING_MODEL).toBe("qwen3-embedding-0.6b");
  });

  it("labels queries and documents, which is what the proxy prefixes the query instruction from", () => {
    expect(V2_OPS).toContainEqual(["memory.search.queryInputType", "query"]);
    expect(V2_OPS).toContainEqual(["memory.search.documentInputType", "document"]);
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
