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
