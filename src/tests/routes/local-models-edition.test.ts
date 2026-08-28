import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Memory embeddings" row came from `openclaw memory status`, spawned
 * through ClawKeep's memory module. On the Hermes edition there is no openclaw
 * binary, so that call could only fail — and the failure was swallowed into a
 * probe indistinguishable from a box whose embedding provider is down. The row
 * then told the customer "No embedding model is answering", i.e. that something
 * on their box was broken, about a feature this SKU never shipped.
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
}));
vi.mock("@/lib/local-ai-runtime", () => ({
  getOllamaBaseUrl: () => "http://127.0.0.1:11434",
}));

import { GET } from "@/app/setup-api/local-models/route";

/** The probe object the route handed to the inventory builder. */
function probes() {
  return inventory.mock.calls[0][0] as { embeddings: { supported: boolean } };
}

beforeEach(() => {
  vi.clearAllMocks();
  inventory.mockResolvedValue({ models: [], unavailable: [] });
  memoryStatus.mockResolvedValue({ available: true, provider: "ollama", model: "q", location: "local" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

describe("GET /setup-api/local-models — embeddings on the hermes edition", () => {
  it("reports the row as not on this edition", async () => {
    mockOpenclawIsAbsent.mockReturnValue(true);
    await GET();
    expect(probes().embeddings.supported).toBe(false);
  });

  it("does not ask openclaw for a memory status it cannot give", async () => {
    mockOpenclawIsAbsent.mockReturnValue(true);
    await GET();
    expect(memoryStatus).not.toHaveBeenCalled();
  });

  it("still reads the real memory status where openclaw exists", async () => {
    mockOpenclawIsAbsent.mockReturnValue(false);
    await GET();
    expect(memoryStatus).toHaveBeenCalledTimes(1);
    expect(probes().embeddings.supported).toBe(true);
  });
});
