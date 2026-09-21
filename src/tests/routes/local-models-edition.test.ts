import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Memory embeddings" row.
 *
 * It came from `openclaw memory status`, spawned through ClawKeep's memory
 * module, and on the Hermes edition there was no openclaw binary — so the call
 * could only fail, and the failure was swallowed into a probe indistinguishable
 * from a box whose embedding provider is down. The row then told the customer
 * "No embedding model is answering", i.e. that something on their box was
 * broken, about a feature that SKU never shipped. Hence `supported`.
 *
 * SINCE THE HERMES PORT there is an index on every edition — OpenClaw's where
 * there is an OpenClaw, ClawBox's own where there is not — over the same
 * embedder, which was always installed everywhere. So the row is MEASURED on
 * every SKU and `supported` is true. The field and its branch stay: it is the
 * honest answer to a question that can be asked again (a future SKU without the
 * embedder), and it is the route's contract. What these tests pin now is that
 * no shipping edition takes the "not on this edition" branch by accident.
 */

const mockOpenclawIsAbsent = vi.fn();
const memoryStatus = vi.fn();
const inventory = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: () => mockOpenclawIsAbsent(),
}));
vi.mock("@/lib/clawkeep-memory", () => ({
  peekMemoryStatus: () => memoryStatus(),
}));
vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return {
    ...actual,
    buildLocalModelInventory: (...args: unknown[]) => inventory(...args),
  };
});
vi.mock("@/lib/llamacpp", () => ({
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8081/v1",
  getDefaultLlamaCppModel: () => "gemma",
}));
vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppProvisioningStatus: async () => ({ installed: false }),
  resolveConfiguredLlamaCppAlias: async () => null,
}));
const embedProvisioning = vi.fn();
vi.mock("@/lib/embed-server", () => ({
  getEmbedProvisioningStatus: () => embedProvisioning(),
}));

import { GET } from "@/app/setup-api/local-models/route";

/** The probe object the route handed to the inventory builder. */
function probes() {
  return inventory.mock.calls[0][0] as {
    embeddings: {
      supported: boolean; ready: boolean; available: boolean; provider: string | null; model: string | null; local: boolean;
      engine: { installed: boolean; modelBytes: number | null };
    };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inventory.mockResolvedValue({ models: [], unavailable: [] });
  // peekMemoryStatus is SYNCHRONOUS: the cached reading or null, never a
  // promise — the route must answer at once and the probe runs behind it. A
  // resolved-value mock handed the route a Promise instead, whose fields all
  // read undefined while `ready` claimed the reading was in.
  memoryStatus.mockReturnValue({ available: true, provider: "openai-compatible", model: "q", location: "local" });
  embedProvisioning.mockResolvedValue({ installed: true, modelBytes: 639_000_000 });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

describe("GET /setup-api/local-models — embeddings on the hermes edition", () => {
  it("measures the row there, because that edition has an index of its own now", async () => {
    mockOpenclawIsAbsent.mockReturnValue(true);
    await GET();
    expect(probes().embeddings.supported).toBe(true);
  });

  it("asks the box the same questions it asks an OpenClaw one", async () => {
    // `peekMemoryStatus` answers from whichever arm the server picked, and the
    // engine half is two stats of files that exist on every SKU. Skipping
    // either used to be right and is now the bug: it drew "not on this
    // edition" over a working embedder and a real index.
    mockOpenclawIsAbsent.mockReturnValue(true);
    await GET();
    expect(memoryStatus).toHaveBeenCalledTimes(1);
    expect(embedProvisioning).toHaveBeenCalledTimes(1);
    expect(probes().embeddings.engine).toEqual({ installed: true, modelBytes: 639_000_000 });
  });

  it("still reads the real memory status where openclaw exists", async () => {
    mockOpenclawIsAbsent.mockReturnValue(false);
    await GET();
    expect(memoryStatus).toHaveBeenCalledTimes(1);
    // Every field of the row comes from the reading the peek handed back, and
    // the engine half from the box itself.
    expect(probes().embeddings).toEqual({
      supported: true, ready: true, available: true, provider: "openai-compatible", model: "q", local: true,
      engine: { installed: true, modelBytes: 639_000_000 },
    });
  });
});
