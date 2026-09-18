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
const CLOUD_ENDPOINT = "https://clawbox.test/api/ai/embeddings";
const TOKEN = "t".repeat(64);

const { runOpenclawConfigSetBatch, readFile, openclawIsAbsent, stampLocalEmbeddingIdentity, readConfig, writeEmbedderPin } = vi.hoisted(() => ({
  runOpenclawConfigSetBatch: vi.fn(async () => ""),
  openclawIsAbsent: vi.fn(() => false),
  stampLocalEmbeddingIdentity: vi.fn(async () => {}),
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
  readConfig: vi.fn<() => Promise<Record<string, unknown>>>(),
  /** The word ClawBox's own store keeps on the SKU where it is the indexer. */
  writeEmbedderPin: vi.fn(async (_source: string) => {}),
}));

vi.mock("fs/promises", () => ({ readFile }));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
}));
vi.mock("@/lib/openclaw-config", () => ({
  readConfig,
  readConfigStrict: vi.fn(async () => ({})),
  runOpenclawConfigSetBatch,
  openclawIsAbsent,
  // The npm --prefix layout of /home/clawbox/.npm-global on the box.
  findOpenclawBin: () => "/home/clawbox/.npm-global/bin/openclaw",
}));
// The other arm, stubbed rather than exercised: this file is about the keys
// written into openclaw.json, and the local index has suites of its own.
vi.mock("@/lib/memory-index-local", () => ({
  stampLocalEmbeddingIdentity,
  readLocalSources: vi.fn(async () => []),
  writeLocalSources: vi.fn(async () => {}),
}));
vi.mock("@/lib/embed-server", () => ({
  getEmbedProxyBaseUrl: () => PROXY_URL,
}));
vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: () => TOKEN,
}));
vi.mock("@/lib/memory-embedder", async (importOriginal) => ({
  // The fence is the real one: this file is about what each edition WRITES, and
  // a stubbed fence would let a cloud switch record an endpoint it must refuse.
  ...(await importOriginal<typeof import("@/lib/memory-embedder")>()),
  writeEmbedderPin,
  readEmbedderPin: vi.fn(async () => null),
  defaultEmbedderSource: vi.fn(async () => "local" as const),
}));
/** The support kill switch, `clawai_cloud_embeddings: "off"`. */
const cloudEmbeddingsOff = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/clawai-cloud-embeddings", () => ({
  CLOUD_EMBEDDING_MODEL: "text-embedding-3-large",
  CLOUD_EMBEDDING_PROVIDER: "openai-compatible",
  cloudEmbeddingsUrl: () => CLOUD_ENDPOINT,
  embeddingsBaseUrlOf: (endpoint: string) => endpoint.replace(/\/+$/, "").replace(/\/embeddings$/, ""),
  // The real rule, narrow enough to stand in for it here: an address that could
  // be an embedding endpoint at all. `readEmbeddingPlacement` asks it before it
  // calls a configured endpoint a recorded cloud placement, and the endpoint it
  // is asking about is OPENCLAW'S client's, not ClawBox's — so ClawBox's own
  // cleartext fence has no jurisdiction over it.
  embeddingEndpointParseable: (raw: string | undefined) => {
    if (!raw || raw.length > 2048) return false;
    try {
      const parsed = new URL(raw);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "";
    } catch {
      return false;
    }
  },
  cloudEmbeddingsSwitchedOff: async () => cloudEmbeddingsOff.value,
}));
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: async () => "claw_test",
}));

import { embeddingConfigHome, readEmbeddingChoice, readEmbeddingPlacement, switchToCloudEmbeddings, switchToLocalEmbeddings } from "@/lib/memory-shard";
import { defaultEmbedderSource, readEmbedderPin } from "@/lib/memory-embedder";
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
  readConfig.mockReset().mockResolvedValue({});
  stampLocalEmbeddingIdentity.mockClear();
  writeEmbedderPin.mockClear();
  openclawIsAbsent.mockReturnValue(false);
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

/**
 * The READ side of the same two homes, and it must answer from ONE of them.
 *
 * `readEmbeddingChoice` used to take each leaf from `memory.search` and fall
 * back to `agents.defaults.memorySearch` per FIELD, which could compose an
 * answer out of two different configurations. On a box part-way through the
 * 2026.8 move — a new `memory.search` carrying provider and model, a stale
 * legacy `remote.baseUrl` still naming a cloud endpoint — it reported that
 * legacy endpoint. `currentEmbeddingSource` then called the box "cloud",
 * `promoteEmbeddings` skipped the write as already done, and the half-written
 * `memory.search` it was meant to complete stayed half-written.
 */
describe("readEmbeddingChoice", () => {
  const LEGACY_CLOUD = {
    agents: { defaults: { memorySearch: { provider: "openai", model: "text-embedding-3-large", remote: { baseUrl: "https://clawbox.test/api/ai" } } } },
  };

  it("reads only the home the installed core uses, on an OpenClaw 2 box", async () => {
    installedCore("2026.8.1");
    readConfig.mockResolvedValue({
      memory: { search: { provider: LOCAL_EMBEDDING_PROVIDER, model: LOCAL_EMBEDDING_MODEL, remote: { baseUrl: PROXY_URL } } },
      ...LEGACY_CLOUD,
    });
    expect(await readEmbeddingChoice()).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER,
      model: LOCAL_EMBEDDING_MODEL,
      baseUrl: PROXY_URL,
    });
  });

  it("does not borrow a leaf from the home nothing writes any more", async () => {
    // The half-migrated box: the new home has the provider and the model, and
    // no endpoint yet. The stale cloud endpoint next door is NOT the answer —
    // reporting it made the applier skip the write that completes this config.
    installedCore("2026.8.1");
    readConfig.mockResolvedValue({
      memory: { search: { provider: LOCAL_EMBEDDING_PROVIDER, model: LOCAL_EMBEDDING_MODEL } },
      ...LEGACY_CLOUD,
    });
    expect(await readEmbeddingChoice()).toEqual({
      provider: LOCAL_EMBEDDING_PROVIDER,
      model: LOCAL_EMBEDDING_MODEL,
      baseUrl: null,
    });
  });

  it("reads the legacy home, and only it, on a core older than 2026.8", async () => {
    installedCore("2026.7.12");
    readConfig.mockResolvedValue({
      memory: { search: { provider: "should-not-be-read", model: "nor-this", remote: { baseUrl: "http://nor.this" } } },
      ...LEGACY_CLOUD,
    });
    expect(await readEmbeddingChoice()).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      baseUrl: "https://clawbox.test/api/ai",
    });
  });

  it("answers null for what the config does not say, which is not either engine", async () => {
    installedCore("2026.8.1");
    readConfig.mockResolvedValue({ memory: { search: { model: "   " } } });
    expect(await readEmbeddingChoice()).toEqual({ provider: null, model: null, baseUrl: null });
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

  it("writes NOTHING into openclaw.json on the edition that has no OpenClaw", async () => {
    // There is no external client to point at the embedder on that SKU —
    // ClawBox is the client — so what is recorded is where ClawBox should embed
    // and which model the vectors about to be written belong to. Spawning the
    // CLI there would be spawning a binary that is not installed.
    openclawIsAbsent.mockReturnValue(true);
    await switchToLocalEmbeddings();
    expect(writeEmbedderPin).toHaveBeenCalledWith("local");
    expect(stampLocalEmbeddingIdentity).toHaveBeenCalledTimes(1);
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("switchToCloudEmbeddings on the edition that has no OpenClaw", () => {
  beforeEach(() => openclawIsAbsent.mockReturnValue(true));

  it("records the WORD and nothing else — no address, no copy of the credential", async () => {
    await switchToCloudEmbeddings(CLOUD_ENDPOINT, "claw_test");
    expect(writeEmbedderPin).toHaveBeenCalledWith("cloud");
    expect(stampLocalEmbeddingIdentity).toHaveBeenCalledTimes(1);
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
    for (const [[stored]] of writeEmbedderPin.mock.calls.map((call) => [call])) {
      expect(stored).toBe("cloud");
    }
  });

  it("refuses an endpoint that is not this box's own ClawBox AI account", async () => {
    // The fence, checked where the choice is RECORDED as well as where the
    // socket is opened: everything the owner has indexed is the body of those
    // requests.
    await expect(switchToCloudEmbeddings("https://someone-elses-server.example/v1/embeddings", "claw_test"))
      .rejects.toThrow(/ClawBox AI account/i);
    expect(writeEmbedderPin).not.toHaveBeenCalled();
    expect(stampLocalEmbeddingIdentity).not.toHaveBeenCalled();
  });

  it("refuses an empty credential rather than recording a cloud it cannot reach", async () => {
    await expect(switchToCloudEmbeddings(CLOUD_ENDPOINT, "   ")).rejects.toThrow(/credential/i);
    expect(writeEmbedderPin).not.toHaveBeenCalled();
  });
});

/**
 * `readEmbeddingPlacement` — the ONE reader of where the index is embedded, and
 * the only one that can say whether that is written down.
 *
 * Two arms because the thing that INDEXES owns the setting, and `recorded` is
 * what stops the automatic promotion rebuilding the index at every boot.
 */
describe("readEmbeddingPlacement", () => {
  const pin = vi.mocked(readEmbedderPin);
  const fallback = vi.mocked(defaultEmbedderSource);

  beforeEach(() => {
    pin.mockReset().mockResolvedValue(null);
    fallback.mockReset().mockResolvedValue("local");
    cloudEmbeddingsOff.value = false;
    installedCore("2026.9.1");
  });

  it("reads openclaw.json where the core is the embedding client", async () => {
    readConfig.mockResolvedValue({ memory: { search: { remote: { baseUrl: PROXY_URL } } } });
    expect(await readEmbeddingPlacement()).toEqual({ source: "local", recorded: true });

    readConfig.mockResolvedValue({ memory: { search: { remote: { baseUrl: "https://clawbox.test/api/ai" } } } });
    expect(await readEmbeddingPlacement()).toEqual({ source: "cloud", recorded: true });
  });

  it("calls an OpenClaw box with no endpoint at all unwritten, so the default still has its write to make", async () => {
    readConfig.mockResolvedValue({});
    expect(await readEmbeddingPlacement()).toEqual({ source: "local", recorded: false });
  });

  it("never calls an address nothing can embed through a recorded cloud placement", async () => {
    // `memory.search` is a file a restored backup, a hand edit or a
    // half-finished migration can leave holding a truncated URL, a `file:`
    // scheme or cleartext off the device. Reading any of those as
    // `recorded: cloud` is the false-success shape on the one reader the
    // automatic default asks before deciding whether it still owes this box a
    // write: it skipped the write, and the box kept a `memory.search` it could
    // not embed with and no surface saying so. Unrecorded hands it back to the
    // rule that writes a configuration which works.
    for (const bad of [
      "https://",
      "not-a-url",
      "file:///etc/passwd",
      `https://long.test/${"a".repeat(2100)}`,
    ]) {
      readConfig.mockResolvedValue({ memory: { search: { remote: { baseUrl: bad } } } });
      expect(await readEmbeddingPlacement(), bad).toEqual({ source: "local", recorded: false });
    }
  });

  it("still calls a genuine third-party https endpoint the cloud, because it IS one", async () => {
    // The owner pointing OpenClaw at their own account is a real recorded
    // placement, and the promotion leaves a recorded cloud alone. Refusing it
    // here would have had the applier overwrite their configuration.
    readConfig.mockResolvedValue({ memory: { search: { remote: { baseUrl: "https://api.openai.com/v1" } } } });
    expect(await readEmbeddingPlacement()).toEqual({ source: "cloud", recorded: true });
  });

  it("leaves the owner's own LAN embedding endpoint alone", async () => {
    // ClawBox's cleartext fence is about where CLAWBOX sends the owner's
    // documents. On this arm the client is OpenClaw's own, pointed at a
    // llama.cpp on another machine by a person editing openclaw.json, and
    // ClawBox has no jurisdiction over it. Read as unset, the boot promotion
    // replaced that endpoint with the ClawBox AI one and started a full reindex
    // — a configuration change the owner never asked for.
    readConfig.mockResolvedValue({ memory: { search: { remote: { baseUrl: "http://192.168.1.50:8080/v1" } } } });
    expect(await readEmbeddingPlacement()).toEqual({ source: "cloud", recorded: true });
  });

  it("reads the pin where ClawBox is the indexer", async () => {
    openclawIsAbsent.mockReturnValue(true);
    pin.mockResolvedValue("cloud");
    expect(await readEmbeddingPlacement()).toEqual({ source: "cloud", recorded: true });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("says LOCAL over a cloud pin the support kill switch has switched off", async () => {
    // M-6's other half. `resolveMemoryEmbedder` honours `clawai_cloud_embeddings:
    // "off"` over a stored pin, so every embed and every search goes to the
    // loopback proxy — while this reader answered "cloud" from the pin alone, so
    // the card drew the cloud hint and preselected the cloud segment, and the
    // provider GET answered `source: "cloud"` beside `cloudAvailable: false`.
    // The pin is NOT rewritten: the lever is a support action and reversible.
    openclawIsAbsent.mockReturnValue(true);
    pin.mockResolvedValue("cloud");
    cloudEmbeddingsOff.value = true;
    expect(await readEmbeddingPlacement()).toEqual({ source: "local", recorded: true });
  });

  it("answers the default rule for a box nobody has pinned — the cloud where the subscription covers it", async () => {
    openclawIsAbsent.mockReturnValue(true);
    fallback.mockResolvedValue("cloud");
    expect(await readEmbeddingPlacement()).toEqual({ source: "cloud", recorded: false });
  });

  it("takes a verdict the caller already worked out rather than paying for the probe twice", async () => {
    openclawIsAbsent.mockReturnValue(true);
    expect(await readEmbeddingPlacement("cloud")).toEqual({ source: "cloud", recorded: false });
    expect(fallback).not.toHaveBeenCalled();
  });
});
