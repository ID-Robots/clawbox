/**
 * src/lib/memory-embedder.ts — WHICH embedder Memory Shard's own index uses on
 * the edition where ClawBox is the indexer, and the two addresses it may send
 * the owner's documents to.
 *
 * Pinned here: the default is the ClawBox AI cloud wherever the box's
 * subscription covers it (the owner's ruling of 2026-09-18) and the model on
 * this box everywhere else; a stored pin beats the default in both directions;
 * the key holds a WORD, so a hand-edited or restored `data/config.json` can
 * never name an endpoint; and the fence passes exactly two addresses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value); },
}));

const token = vi.fn(async () => "claw_test" as string | null);
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
  resolveClawaiToken: () => token(),
}));

vi.mock("@/lib/embed-server", () => ({
  getEmbedProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/embed/v1",
}));

const facts = vi.fn(async () => ({
  linked: true,
  entitlement: "pro" as string | null,
  embeddingsSupported: true,
  embeddingsRouteReady: true,
}));
vi.mock("@/lib/clawai-cloud-defaults", () => ({ readCloudDefaultsFacts: () => facts() }));

import {
  assertEmbedEndpointAllowed,
  embedEndpointAllowed,
  readEmbedderPin,
  resolveMemoryEmbedder,
  writeEmbedderPin,
} from "@/lib/memory-embedder";
import { MEMORY_SHARD_EMBEDDER_KEY } from "@/lib/memory-shard-state";
import { CLAWAI_CLOUD_EMBEDDINGS_KEY } from "@/lib/clawai-cloud-embeddings";

const CLOUD_ENDPOINT = "https://clawbox.test/api/ai/embeddings";
const PROXY = "http://127.0.0.1/setup-api/local-ai/embed/v1";

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  token.mockResolvedValue("claw_test");
  facts.mockResolvedValue({ linked: true, entitlement: "pro", embeddingsSupported: true, embeddingsRouteReady: true });
});

describe("what a box nobody has pinned embeds with", () => {
  it("is the ClawBox AI cloud when the subscription covers it", async () => {
    const embedder = await resolveMemoryEmbedder();
    expect(embedder.source).toBe("cloud");
    expect(embedder.requestUrl).toBe(CLOUD_ENDPOINT);
    expect(embedder.token).toBe("claw_test");
    // An OpenAI-shaped route: no `input_type`, which is the field the loopback
    // proxy reads and this one would 400 on.
    expect(embedder.labelInputs).toBe(false);
  });

  it("is the model on this box when nothing links it to a subscription", async () => {
    token.mockResolvedValue(null);
    facts.mockResolvedValue({ linked: false, entitlement: null, embeddingsSupported: true, embeddingsRouteReady: false });
    const embedder = await resolveMemoryEmbedder();
    expect(embedder.source).toBe("local");
    expect(embedder.requestUrl).toBe(`${PROXY}/embeddings`);
    expect(embedder.labelInputs).toBe(true);
  });

  it("is the model on this box when the cloud route does not answer", async () => {
    facts.mockResolvedValue({ linked: true, entitlement: "pro", embeddingsSupported: true, embeddingsRouteReady: false });
    expect((await resolveMemoryEmbedder()).source).toBe("local");
  });

  it("is the model on this box when the facts cannot be read at all", async () => {
    facts.mockRejectedValue(new Error("the probe blew up"));
    expect((await resolveMemoryEmbedder()).source).toBe("local");
  });

  it("takes the verdict the caller already paid for rather than reading it again", async () => {
    expect((await resolveMemoryEmbedder("local")).source).toBe("local");
    expect(facts).not.toHaveBeenCalled();
  });
});

describe("the pin", () => {
  it("beats the default in both directions", async () => {
    await writeEmbedderPin("local");
    expect(await readEmbedderPin()).toBe("local");
    expect((await resolveMemoryEmbedder()).source).toBe("local");
    // And the facts are not even read: the owner has said.
    expect(facts).not.toHaveBeenCalled();

    await writeEmbedderPin("cloud");
    facts.mockResolvedValue({ linked: false, entitlement: null, embeddingsSupported: true, embeddingsRouteReady: false });
    expect((await resolveMemoryEmbedder()).source).toBe("cloud");
  });

  it("is a WORD: anything else in the store is ignored, never used as an address", async () => {
    // The state a restored backup or a hand-edited config.json can produce, and
    // the reason this key holds a word at all: everything the owner has indexed
    // is the body of these requests.
    store.set(MEMORY_SHARD_EMBEDDER_KEY, "https://someone-elses-server.example/v1");
    expect(await readEmbedderPin()).toBeNull();
    const embedder = await resolveMemoryEmbedder();
    expect(embedder.requestUrl).toBe(CLOUD_ENDPOINT);
    expect(JSON.stringify(embedder)).not.toContain("someone-elses-server");
  });
});

describe("the field switch", () => {
  it("takes a PINNED box off the cloud, which is the population the lever exists for", async () => {
    // `clawai_cloud_embeddings: "off"` is there so a box already in a
    // customer's hands can be taken off the cloud embedder without an update,
    // whatever its plan says. It used to be read only inside
    // `probeCloudEmbeddings`, i.e. only where nothing had been pinned — and the
    // automatic promotion now writes a pin at the first boot of every linked,
    // paid box, so the lever no longer reached the boxes it was written for:
    // support switched it off and the owner's documents kept going out.
    await writeEmbedderPin("cloud");
    store.set(CLAWAI_CLOUD_EMBEDDINGS_KEY, "off");
    const embedder = await resolveMemoryEmbedder();
    expect(embedder.source).toBe("local");
    expect(embedder.requestUrl).toBe(`${PROXY}/embeddings`);
  });

  it("is reversible, and leaves the owner's pin exactly where it was", async () => {
    await writeEmbedderPin("cloud");
    store.set(CLAWAI_CLOUD_EMBEDDINGS_KEY, "off");
    await resolveMemoryEmbedder();
    expect(await readEmbedderPin()).toBe("cloud");
    store.delete(CLAWAI_CLOUD_EMBEDDINGS_KEY);
    expect((await resolveMemoryEmbedder()).source).toBe("cloud");
  });

  it("is one word and nothing else", async () => {
    await writeEmbedderPin("cloud");
    for (const value of ["on", "OFF ", "", "no", true]) {
      store.set(CLAWAI_CLOUD_EMBEDDINGS_KEY, value);
      const expected = String(value).trim().toLowerCase() === "off" ? "local" : "cloud";
      expect((await resolveMemoryEmbedder()).source, String(value)).toBe(expected);
    }
  });
});

describe("the width each embedder answers with", () => {
  it("is carried, because the index's memory budget is a function of it", async () => {
    // The chunk ceiling and the vector cache are derived from this
    // (`maxIndexChunks`): the cloud model is three times as wide as the one on
    // the box, and a ceiling written as a flat number next to a comment about
    // 1,024 dimensions tripled the budget underneath itself.
    expect((await resolveMemoryEmbedder("cloud")).dimensions).toBe(3072);
    expect((await resolveMemoryEmbedder("local")).dimensions).toBe(1024);
  });
});

describe("the fence", () => {
  it("passes this box's own proxy and this box's own ClawBox AI account, and nothing else", () => {
    expect(embedEndpointAllowed("local", PROXY)).toBe(true);
    expect(embedEndpointAllowed("cloud", "https://clawbox.test/api/ai")).toBe(true);
    // Trailing slashes are not part of an address.
    expect(embedEndpointAllowed("cloud", "https://clawbox.test/api/ai/")).toBe(true);

    expect(embedEndpointAllowed("local", "https://someone-elses-server.example/v1")).toBe(false);
    expect(embedEndpointAllowed("cloud", "https://someone-elses-server.example/v1")).toBe(false);
    // The right address on the wrong arm is still refused: each arm knows one.
    expect(embedEndpointAllowed("local", "https://clawbox.test/api/ai")).toBe(false);
    expect(embedEndpointAllowed("cloud", PROXY)).toBe(false);
  });

  it("refuses in words the switch can show", () => {
    expect(() => assertEmbedEndpointAllowed("cloud", "https://someone-elses-server.example/v1"))
      .toThrow(/ClawBox AI account/i);
    expect(() => assertEmbedEndpointAllowed("local", "https://someone-elses-server.example/v1"))
      .toThrow(/not on this device/i);
  });
});
